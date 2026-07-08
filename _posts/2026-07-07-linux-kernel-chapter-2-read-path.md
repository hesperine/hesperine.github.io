---
title: Linux 内核学习笔记（二）：从一次 read() 看内核如何接管执行
date: 2026-07-07 17:30:00 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, Operating System, System Call, Scheduler, Virtual Memory]
---

第 2 个模块入口记录一条横切路径：用户态执行 `read(fd, buf, count)` 后，Linux 如何从系统调用入口走到当前 task、文件描述符表、VFS、用户缓冲区、page cache、等待队列和调度器。

本模块可以继续拆成多篇笔记。这里先写入口笔记：

| 笔记单元 | 记录内容 |
| --- | --- |
| 基础与八股 | 系统调用、文件描述符、阻塞 I/O、同步/异步 I/O、上下文切换 |
| OS 模型 | trap、进程资源表、虚拟地址空间、I/O 等待、调度 |
| Linux 实现 | `current`、`files_struct`、fdtable、`struct file`、VFS、page cache、`copy_to_user()`、wait queue |

## 2.1 基础与八股：问题边界

`read(fd, buf, count)` 可以拆成三个参数和两类结果。

| 参数 | 用户态看到的含义 | 内核要确认的事 |
| --- | --- | --- |
| `fd` | 一个整数 | 是否能在当前进程的打开文件表中解析到对象 |
| `buf` | 一段用户态地址 | 是否属于当前地址空间，是否可写 |
| `count` | 最多读取多少字节 | 长度是否合法，返回值如何表达成功或失败 |

常见问题：

| 问题 | 短回答 |
| --- | --- |
| 系统调用是什么？ | 用户程序请求内核服务的正式入口，参数要按 syscall ABI 传给内核。 |
| fd 是什么？ | 进程局部的整数 handle，指向当前进程打开文件表里的某个打开对象。 |
| 为什么 `read()` 不直接用文件名？ | 文件名在 `open()` 时解析，`read()` 使用 `open()` 返回的 fd。 |
| `read()` 会不会阻塞？ | 取决于对象和打开方式。普通文件可能等磁盘 I/O，pipe/socket 可能等数据到达。 |
| 阻塞 I/O 等什么？ | 等内核侧数据准备好，也等数据从内核缓冲区复制到用户缓冲区。 |
| 同步 I/O 和阻塞 I/O 是一回事吗？ | 二者不同。阻塞/非阻塞描述调用在数据未就绪时是否等待；同步/异步描述 I/O 完成过程由调用方等待还是由内核完成后通知。 |
| 用户缓冲区为什么要检查？ | `buf` 是用户虚拟地址，可能非法、不可写，或者访问时触发 page fault。 |
| 系统调用进入内核态等于上下文切换吗？ | 不等于。syscall 是同一个 task 进入内核代码；context switch 是 CPU 从一个 task 切到另一个 task。 |

小林 Code《图解系统》的文件系统部分从用户视角讲 `open -> read/write -> close`，核心点是：打开文件后，操作系统要为进程维护打开文件表，fd 是打开文件的标识；文件读写最终会被文件系统转换为对数据块和缓存的操作。

## 2.2 OS 模型：一次 read 涉及哪些抽象

从 OSTEP 的视角看，`read()` 同时碰到三条主线：

| 主线 | `read()` 中的体现 |
| --- | --- |
| 虚拟化 CPU | 当前进程通过 syscall 进入内核，阻塞时让出 CPU，之后再被调度回来 |
| 虚拟化内存 | `buf` 是当前进程的虚拟地址，内核要通过当前地址空间访问它 |
| 持久化 | fd 对应文件系统对象，数据可能来自磁盘、page cache、pipe、socket 或设备 |

`read()` 的最小状态线：

```text
用户态运行
  -> syscall/trap 进入内核
  -> 查当前进程资源
  -> 查 fd 对应对象
  -> 数据就绪则复制到用户缓冲区
  -> 数据未就绪则阻塞、调度、等待唤醒
  -> 返回用户态
```

这里有两个容易混的边界。

| 边界 | 记录 |
| --- | --- |
| syscall vs context switch | syscall 是同一个 task 从用户态进入内核态；context switch 是 CPU 换另一个 task 运行。 |
| fd vs 文件名 | 文件名用于路径查找；fd 是打开后的 handle，后续读写主要通过 fd 找打开文件对象。 |

## 2.3 用户态入口：libc、syscall ABI、返回值

用户代码一般调用 libc 的 `read()` 包装函数，最后通过体系结构定义的 syscall 指令进入内核。以 x86-64 为例，系统调用号和参数会放进约定寄存器。

| 内容 | 记录 |
| --- | --- |
| syscall number | 用来选择具体系统调用实现 |
| 参数寄存器 | 放 `fd`、`buf`、`count` 等参数 |
| 返回值 | 成功返回读到的字节数；失败返回 `-1` 并设置 `errno` |

用户态例子：

```c
char buf[4096];
int fd = open("data.txt", O_RDONLY);
ssize_t n = read(fd, buf, sizeof(buf));
close(fd);
```

这几行对应三类系统调用：路径名解析和打开文件、基于 fd 的读、释放 fd 引用。

## 2.4 `current`：这次内核路径代表谁执行

系统调用进入内核后，Linux 需要知道当前路径属于哪个执行实体。`current` 指向当前 CPU 上正在运行的 `task_struct`。

`task_struct` 在这条路径里主要用三组引用：

| 引用 | 用途 |
| --- | --- |
| `current->files` | 找当前进程的文件描述符表 |
| `current->mm` | 找当前进程的地址空间、VMA 和页表 |
| 调度字段 | 阻塞、唤醒、进入 runqueue 或离开 runqueue |

`current` 不只是“当前进程”的名字。Linux 里线程也是 task，同一进程内不同线程共享 `mm_struct` 和文件表的方式由 `clone()` flags 决定。`read()` 路径里的“当前”更准确地说是当前 task。

## 2.5 fd：整数到 `struct file`

fd 的查找路径：

```text
current
  -> files_struct
  -> fdtable
  -> struct file
```

三层对象：

| 对象 | 作用 |
| --- | --- |
| fd | 进程局部整数，只在当前文件表里有意义 |
| `struct file` | 一次打开文件对象，保存 offset、flags、引用计数、操作表 |
| inode / socket / pipe / device | 更底层的实际对象 |

`open()` 两次同一个路径，通常得到两个 fd 和两个打开文件对象，文件偏移可以独立变化。`fork()` 后父子进程继承同一个打开文件对象时，文件偏移可能共享。这个细节是文件描述符八股题里最容易漏的部分。

`/proc/<pid>/fd` 看到的是 fd 到对象的映射；`/proc/<pid>/fdinfo/<fd>` 可以看到 offset、flags 等信息。

## 2.6 VFS：把不同对象统一成文件接口

VFS 把普通文件、目录、pipe、socket、字符设备、procfs 文件等对象放到统一接口下。`read()` 找到 `struct file` 后，最终会分发到这个对象的文件操作。

```text
read()
  -> fdtable 找 struct file
  -> VFS
  -> file_operations
  -> 具体文件系统 / pipe / socket / 设备
```

几个对象边界：

| 对象 | 记录 |
| --- | --- |
| dentry | 路径名解析时的目录项缓存 |
| inode | 文件系统里的文件元数据和对象身份 |
| superblock | 一个已挂载文件系统的整体元数据 |
| page cache | 内核缓存文件页，减少磁盘 I/O |
| `file_operations` | 具体对象支持哪些文件操作 |

小林 Code 的文件系统章节把用户空间、系统调用、VFS、缓存、文件系统和存储串成一条层次线。Linux 内核里，`read()` 进入 VFS 后是否走 page cache、是否发起磁盘 I/O、是否等待设备，取决于具体对象和打开方式。

## 2.7 用户缓冲区：`buf` 是当前地址空间里的虚拟地址

`buf` 来自用户态，内核不能直接当成可信内核指针。

内核要处理的问题：

| 问题 | 说明 |
| --- | --- |
| 地址是否合法 | 是否落在当前 `mm_struct` 的合法 VMA 内 |
| 权限是否匹配 | `read()` 要往用户缓冲区写数据，所以目标区域要可写 |
| 是否已映射物理页 | 没有映射时可能触发 page fault |
| 复制是否完整 | 用户地址访问失败时要返回错误 |

用户地址访问会通过 `copy_to_user()` 这类接口。合法 page fault 可以由内核补齐映射，例如按需分配匿名页、建立文件映射或处理 COW；非法访问会返回错误或导致信号。

## 2.8 page cache、直接 I/O、阻塞 I/O

普通文件读写默认通常走 page cache。读路径上，如果数据已经在 page cache，内核可以直接从缓存复制到用户缓冲区；如果不在，内核需要发起底层 I/O，把数据读入缓存，再复制给用户。

| 类型 | 记录 |
| --- | --- |
| 缓冲 I/O | 使用 C 标准库缓冲，最终仍会通过系统调用访问文件 |
| 非缓冲 I/O | 直接调用系统调用，不经过标准库缓冲 |
| 非直接 I/O | 使用内核 page cache，是普通文件 I/O 的常见默认路径 |
| 直接 I/O | 绕过 page cache，常通过 `O_DIRECT` 请求 |
| 阻塞 I/O | 数据未就绪时调用线程睡眠等待 |
| 非阻塞 I/O | 数据未就绪时立即返回错误码，调用方稍后再试 |

阻塞 `read()` 的状态线：

```text
RUNNING
  -> 数据未就绪
  -> 加入 wait queue
  -> schedule()
  -> SLEEPING
  -> I/O 完成或数据到达
  -> wakeup
  -> RUNNABLE
  -> 再次 RUNNING
```

同步/异步 I/O 的重点是完成方式。同步 I/O 需要调用方等待数据准备和复制过程完成；异步 I/O 由内核在后台推进，完成后用事件或回调式机制通知用户态。第 10 章网络和第 12 章 tracing/BPF 会继续用这个边界。

## 2.9 `schedule()`：read 卡住时 CPU 去哪里

当 `read()` 需要等 I/O、socket 数据、pipe 数据或设备事件，当前 task 会进入睡眠状态并调用调度器。

调度器做的事可以先压缩成三步：

| 步骤 | 说明 |
| --- | --- |
| 保存当前执行状态 | 当前 task 之后要能从睡眠点继续 |
| 选择下一个 runnable task | 从当前 CPU 的 runqueue 和调度类里选 |
| 恢复下一个 task | CPU 开始执行另一个 task |

系统调用进入内核不一定发生上下文切换；阻塞、时间片用完、更高优先级 task 被唤醒、主动 sleep/yield 等情况才可能触发真正的 task 切换。

## 2.10 一次 read 的对象链

```text
用户态 read(fd, buf, count)
  -> syscall entry
  -> current task_struct
  -> current->files
  -> fdtable[fd]
  -> struct file
  -> VFS / file_operations
  -> page cache / pipe / socket / device
  -> copy_to_user(buf)
  -> 返回用户态
```

如果数据未准备好：

```text
struct file 对应对象
  -> 等待事件
  -> wait queue
  -> 当前 task 睡眠
  -> schedule()
  -> wakeup 后回到 read 路径
```

这条路径把后续模块串起来：

| 后续模块 | `read()` 中的入口 |
| --- | --- |
| 进程管理 | `current`、`task_struct`、进程资源引用 |
| 文件系统 | fdtable、`struct file`、VFS、inode、page cache |
| 内存管理 | `buf`、`mm_struct`、VMA、page fault |
| 调度系统 | task state、wait queue、runqueue、`schedule()` |
| 同步机制 | 睡眠锁、等待队列、唤醒路径 |
| tracing/BPF | syscall tracepoint、VFS/kprobe、sched tracepoint |

## 2.11 观测入口

| 目标 | 命令 |
| --- | --- |
| 看系统调用 | `strace -e openat,read,write,close cat data.txt` |
| 看 fd 指向 | `ls -l /proc/<pid>/fd` |
| 看 fd offset 和 flags | `cat /proc/<pid>/fdinfo/<fd>` |
| 看地址空间 | `cat /proc/<pid>/maps` |
| 看进程状态 | `ps -o pid,ppid,stat,comm -p <pid>` |
| 看上下文切换 | `pidstat -w 1` |
| 看调度延迟 | `perf sched record -- sleep 3`、`perf sched latency` |
| 看 syscall tracepoint | `bpftrace -e 'tracepoint:syscalls:sys_enter_read { @[comm] = count(); }'` |

最小排查顺序：

1. `strace -T` 看 `read()` 是否耗时。
2. `/proc/<pid>/fd` 确认读的是普通文件、pipe、socket 还是设备。
3. `/proc/<pid>/fdinfo/<fd>` 看 offset 和 flags。
4. `ps` / `pidstat` / `perf sched` 判断是否在睡眠或调度等待。
5. 需要内核内部事件时再用 ftrace、perf trace 或 BPF。

## 2.12 源码入口

| 路径 | 内容 |
| --- | --- |
| `arch/x86/entry/entry_64.S` | x86-64 syscall/interrupt 入口 |
| `arch/x86/entry/common.c` | syscall 通用入口路径 |
| `fs/read_write.c` | read/write 系统调用和 VFS 入口 |
| `include/linux/fdtable.h` | fd table 相关结构 |
| `include/linux/fs.h` | `struct file`、inode、`file_operations` |
| `fs/file.c` | fd table、文件对象引用相关逻辑 |
| `mm/memory.c` | page fault 和内存映射核心路径之一 |
| `kernel/sched/core.c` | `schedule()` 和核心调度逻辑 |

源码阅读时按对象链走：先找系统调用入口，再找 fd 解析，再看 VFS 分发，再看用户地址复制和可能的等待队列。

## 本模块检查点与参考回答

| 问题 | 参考回答 |
| --- | --- |
| `read(fd, buf, count)` 进入内核后主要查什么？ | 查当前 task、当前文件表中的 fd、fd 对应的 `struct file`、用户缓冲区是否合法，以及底层对象的数据是否准备好。 |
| fd 和文件名是什么关系？ | 文件名在 `open()` 时用于路径解析；`open()` 返回 fd 后，`read()` / `write()` 主要通过 fd 找打开文件对象，不再传文件名。 |
| fd、`struct file`、inode 怎么分层？ | fd 是进程局部整数；`struct file` 是一次打开对象，保存 offset、flags、操作表等打开状态；inode 表示文件系统中的文件对象和元数据。 |
| 阻塞 I/O 和非阻塞 I/O 怎么区分？ | 阻塞 I/O 在数据未就绪时让当前 task 睡眠；非阻塞 I/O 在数据未就绪时立即返回，调用方稍后重试或配合事件通知机制。 |
| syscall 进入内核态和上下文切换有什么区别？ | syscall 是同一个 task 进入内核执行路径；上下文切换是 CPU 从一个 task 切到另一个 task。`read()` 阻塞时通常会触发后者。 |
| page fault 一定是错误吗？ | 不一定。合法 page fault 可以用于按需分配页、建立文件映射、处理 COW；非法访问才会导致错误返回或信号。 |
| 为什么 `read()` 可以读 socket、pipe、设备？ | VFS 和 fd 模型把不同内核对象统一到文件接口下，具体行为由 `struct file` 的操作表和底层对象决定。 |

## 本模块参考

- 小林 Code《图解系统》4.1 进程、线程基础知识
- 小林 Code《图解系统》6.1 文件系统
- Remzi H. Arpaci-Dusseau and Andrea C. Arpaci-Dusseau, *Operating Systems: Three Easy Pieces*
- Michael Kerrisk, *The Linux Programming Interface*
- Robert Love, *Linux Kernel Development*
- Linux Kernel Documentation: Filesystems
- Linux Kernel Documentation: Memory Management
- Linux Kernel Documentation: Core API
