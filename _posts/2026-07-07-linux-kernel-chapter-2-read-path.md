---
title: Linux 内核学习笔记（二）：从一次 read() 看内核如何接管执行
date: 2026-07-07 17:30:00 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, Operating System, System Call, Scheduler, Virtual Memory]
---

`read()` 路径记录。一行普通用户态代码会同时经过系统调用入口、当前进程、文件描述符、VFS、用户内存检查、阻塞等待和调度器。

这条路径适合做第一条 Linux 横切路径。它同时连接六大模块里的四个部分：

| 模块 | `read()` 里的落点 |
| --- | --- |
| 进程管理 | `current`、`task_struct`、当前 task 的资源引用 |
| 文件系统 | fdtable、`struct file`、VFS、page cache |
| 内存管理 | 用户态 `buf`、VMA、page fault、`copy_to_user()` |
| 调度系统 | wait queue、sleeping、wakeup、`schedule()` |

路径草图：

```text
用户态 read()
  -> syscall 进入内核态
  -> current 找到当前 task_struct
  -> current->files 找到 fd table
  -> fd table 找到 struct file
  -> VFS 分发到具体文件/设备/socket
  -> 访问用户缓冲区时可能触发 page fault
  -> 数据未准备好时进入 wait queue 并 schedule()
```

`read()` 路径里记录几个问题：

- 当前执行实体是谁？
- 它从哪里进入内核？
- 它带来了哪些用户态参数？
- 内核要查哪些对象？
- 它会不会睡眠？
- 如果睡眠，谁把 CPU 交给下一个 task？

## 术语表 / 八股检查点

| 名词 | 记录 |
| --- | --- |
| syscall ABI | 用户态把 syscall number 和参数放到约定寄存器，CPU 进入内核 |
| syscall number | 系统调用号，用来分发到具体 syscall 实现 |
| `current` | 当前 CPU 上正在代表哪个 task 执行内核代码 |
| user pointer | 用户态传给内核的虚拟地址，不能当内核指针直接解引用 |
| `copy_to_user()` | 内核把数据复制到用户态地址的接口 |
| `copy_from_user()` | 内核从用户态地址复制数据的接口 |
| fdtable | 当前文件表里的 fd 到 `struct file` 映射 |
| `struct file` | 一次打开文件对象，记录 offset、flags、操作表等 |
| VFS | Linux 对不同文件系统、socket、pipe、设备提供的统一文件接口 |
| page fault | 虚拟地址访问无法由当前页表完成时进入内核的异常 |
| wait queue | 等待某个事件的 task 集合 |
| blocking I/O | 数据未准备好时 task 进入睡眠等待 |
| `EFAULT` | 用户地址非法或复制失败时常见错误 |

## 从用户态的一行代码开始

```c
#include <fcntl.h>
#include <unistd.h>

int main(void) {
    char buf[4096];
    int fd = open("data.txt", O_RDONLY);
    ssize_t n = read(fd, buf, sizeof(buf));
    write(1, buf, n);
    close(fd);
    return 0;
}
```

`read(fd, buf, sizeof(buf))` 里的三个参数在用户态看起来很普通：

| 参数 | 用户态含义 |
| --- | --- |
| `fd` | 一个整数 |
| `buf` | 一段用户态内存地址 |
| `count` | 想读多少字节 |

进入内核后，它们会变成三个检查点：

- `fd` 是否是当前进程打开过的文件描述符？
- `buf` 是否是当前进程地址空间里可写的用户地址？
- `count` 是否在合理范围内，读到的数据是否真的能复制回用户态？

## syscall：从用户态进入内核态

用户态的 `read()` 通常是 libc 包装函数，最后通过 CPU 的 syscall 指令进入内核。以 x86-64 Linux 为例，系统调用号和参数主要放在寄存器里：

| 寄存器 | 内容 |
| --- | --- |
| `rax` | syscall number |
| `rdi` | fd |
| `rsi` | buf |
| `rdx` | count |

syscall 入口做几件事：

- 保存必要寄存器。
- 切到内核定义好的入口路径。
- 在当前 task 的内核栈上继续执行。
- 根据 syscall number 分发到具体系统调用实现。

“保存必要寄存器”对应简化模型里的 `context`：CPU 从用户态进入内核时，需要留下足够的信息，之后才能返回原来的用户态位置继续执行。Linux 的保存现场细节和体系结构相关，核心条件是保留可恢复的执行状态。

入口路径：

```text
用户态 read()
  |
  v
syscall instruction
  |
  v
arch/x86/entry/entry_64.S
  |
  v
arch/x86/entry/common.c
  |
  v
read 系统调用实现
```

这里还没有发生调度意义上的上下文切换。CPU 仍然在执行同一个 task，只是从用户态指令流进入了内核态指令流。

## current：内核怎么知道当前进程是谁

进入内核后，代码需要知道这次 syscall 属于哪个执行实体。Linux 用 `current` 找到当前 CPU 上正在运行的 `task_struct`。

这一步对应小 OS 里的 `current_task[cpu]`。多 CPU 系统里，每个 CPU 都有自己的当前 task；当前 CPU 进入内核后，`current` 指向“这次内核路径正在代表谁执行”。

`task_struct` 挂着当前任务的主要资源：

```text
task_struct
  |
  +-- mm              用户态地址空间，指向 mm_struct
  +-- files           打开的文件表，指向 files_struct
  +-- fs              cwd/root/umask 等文件系统上下文
  +-- signal/sighand  信号相关状态
  +-- cred            uid/gid/capability 等权限信息
  +-- sched fields    调度状态、优先级、调度类
  +-- stack           内核栈
```

这里的 task 指 Linux 内核调度和管理的执行实体。Linux 里进程和线程都对应 task。`fork()`、`clone()` / `clone3()`、`pthread_create()` 的差别主要在于新 task 和旧 task 共享哪些资源。线程共享同一个 `mm_struct`，所以同一进程里的线程看到同一份用户态地址空间；普通 `fork()` 会得到一份新的地址空间视图，很多物理页一开始通过 copy-on-write 共享。

本节只用到 `task_struct` 的三条边：

| 边 | 用途 |
| --- | --- |
| `current -> files` | 找 fd |
| `current -> mm` | 检查用户缓冲区 |
| `current -> sched` | 睡眠、唤醒、调度 |

## fd：整数怎么变成打开文件对象

`fd` 是当前进程文件表里的索引。两个进程都可以有 `fd = 3`，但它们的 `current->files` 不同，最后指向的 `struct file` 也可以不同。

```text
current
  |
  v
files_struct
  |
  v
fdtable[fd]
  |
  v
struct file
```

`struct file` 表示一次打开文件实例，里面有当前 offset、打开 flags、引用计数和文件操作表：

```text
struct file
  |
  +-- f_pos       当前文件偏移
  +-- f_flags     打开标志
  +-- f_inode     对应 inode
  +-- f_op        file_operations
```

三个对象需要分清：

| 对象 | 含义 |
| --- | --- |
| fd | 用户态整数，进程局部 |
| `struct file` | 一次 open 得到的打开文件对象，记录 offset/flags |
| `struct inode` | 文件系统里的文件本体，记录元数据和底层对象 |

同一个进程 `open()` 两次同一路径，会得到两个 fd，对应两个 `struct file`，文件偏移可以独立变化。`fork()` 之后父子进程继承同一个打开文件对象时，二者可能共享同一个 file offset。

## VFS：read 可读多类对象

`read()` 可以服务普通磁盘文件、pipe、socket、字符设备、procfs 文件。系统调用层通过 VFS 分发到具体实现。

```text
read(fd, buf, count)
  |
  v
找到 struct file
  |
  v
VFS
  |
  v
file->f_op->read_iter 或相关实现
  |
  v
具体文件系统 / 设备 / socket / pipe
```

VFS 提供统一对象和统一操作接口。普通文件、管道、socket 的底层实现不同，但都可以通过 fd 和 `read()` 进入对应的内核路径。

很多 Linux 机制也沿用 fd 作为用户态 handle：`epoll`、`eventfd`、`timerfd`、`signalfd`，以及 BPF program、BPF map、BPF link。

## buf：用户地址不能直接信任

`buf` 是用户态虚拟地址。内核不能把它当成普通内核指针直接写。

内核需要确认：

- `buf` 是否属于当前进程地址空间？
- 这段地址是否可写？
- 写入过程中是否会触发 page fault？
- 复制过程中用户态映射是否仍然有效？

用户态地址空间由 `mm_struct` 和 VMA 描述：

```text
mm_struct
  |
  +-- VMA: 代码段，r-x
  +-- VMA: 堆，rw-
  +-- VMA: mmap 文件，r-- / rw-
  +-- VMA: 用户栈，rw-
  +-- page table
```

把数据交回用户程序时，内核通过 `copy_to_user()` 一类接口写入用户地址。这个过程可能触发缺页异常；地址非法时，系统调用会返回错误或进程收到信号。

## page fault：访问内存时进入内核

page fault 是访问虚拟地址时触发的内核入口。当前指令访问虚拟地址，CPU/MMU 发现页表无法完成翻译或权限不满足，于是进入 page fault 处理路径。

例如：

```c
char *p = malloc(4096 * 1024);
p[0] = 1;
```

`malloc()` 返回的是虚拟地址范围。第一次写 `p[0]` 时，对应物理页可能还没分配。CPU 查页表失败后触发 page fault，内核根据当前任务的 `mm_struct` 和 VMA 判断：

- 地址是否落在合法 VMA 内？
- 访问权限是否匹配？
- 这是匿名页、文件映射页，还是 copy-on-write？
- 需要分配新物理页，还是从文件/page cache 建立映射？

合法 fault 会由内核补齐映射，然后返回原指令重新执行。非法 fault 会产生 `SIGSEGV`。

```text
用户态 load/store
  |
  v
MMU 查页表失败
  |
  v
page fault
  |
  +-- 合法 -> 分配页/建立映射 -> 重试原指令
  |
  +-- 非法 -> SIGSEGV
```

`read()` 的用户缓冲区、`mmap()` 文件映射、copy-on-write、按需分配物理页，都会回到 page fault 这条线。

## read 可能睡眠

`read()` 不保证立刻返回。普通文件的数据可能不在 page cache 里，socket 可能还没有收到包，pipe 可能暂时没有写入端数据。

数据没有准备好时，当前 task 会进入等待：

```text
当前 task 调用 read()
  |
  v
数据未准备好
  |
  v
设置 task state
  |
  v
加入 wait queue
  |
  v
schedule()
  |
  v
CPU 切到另一个 runnable task
```

I/O 完成、网络包到达、pipe 写入数据后，内核唤醒等待队列上的任务，把它重新放回 runqueue。之后调度器再次选中它，它会从之前睡眠的内核路径继续执行，最终把数据复制到用户缓冲区并返回用户态。

这里和小 OS 里的信号量等待很像：没有资源时，当前 task 标记为 blocked，不再参与调度；资源出现时，再把它变回 runnable。Linux 的等待队列会记录“谁在等这个事件”，而调度器只从 runnable task 里选下一个执行。

用状态变化看更清楚：

```text
RUNNING
  |
  | read 等不到数据
  v
SLEEPING / BLOCKED
  |
  | I/O 完成，wakeup
  v
RUNNABLE
  |
  | scheduler 选中
  v
RUNNING
```

## schedule 和上下文切换

`schedule()` 是调度器入口之一。它从当前 CPU 的 runqueue 中选择下一个 runnable task，然后完成上下文切换。

```text
task A
  |
  +-- 时间片用完
  +-- 等 I/O
  +-- 等锁
  +-- 被更高优先级任务抢占
  v
schedule()
  |
  v
选择 task B
  |
  v
context switch
```

上下文切换会保存当前 task 的执行状态，恢复下一个 task 的执行状态。它涉及寄存器、栈、调度状态；如果切到另一个进程，还会涉及地址空间和 TLB 影响。同一进程内线程切换通常共享 `mm_struct`，地址空间相关成本较低。

系统调用进入内核态本身是同一个 task 切到内核执行路径。CPU 从一个 task 切到另一个 task，才是这里讨论的 context switch。

小 OS 里调度器可能是一个 FIFO 队列：保存当前 task 的 context，把 runnable task 放回队列，再弹出下一个 task。Linux 有调度类、优先级、CFS/EEVDF、实时任务、多 CPU 负载均衡。第一层 mental model：

保存当前 task，选择下一个 runnable task，恢复下一个 task。

## syscall、exception、interrupt

三类入口都能让 CPU 进入内核，但来源不同。

| 入口 | 触发者 | 例子 | 同步性 | 当前任务上下文 |
| --- | --- | --- | --- | --- |
| syscall | 用户程序主动触发 | `read()`、`write()`、`mmap()` | 同步 | 有 |
| exception | 当前指令触发 | page fault、除零、非法指令 | 同步 | 通常有 |
| interrupt | 外部设备触发 | 网卡收包、磁盘完成、定时器 | 异步 | 不一定代表当前任务 |

系统调用和 page fault 都和当前执行流强相关。中断可能在任意任务运行时到来；网卡中断发生时，当前 CPU 上运行的 task 未必和这个网络包有关。

进程上下文里通常可以睡眠，因为内核代码代表某个具体 task 执行，能被调度走再恢复。中断上下文属于硬件事件处理路径，不能随便睡眠。

## 一次 read 的完整轮廓

```text
用户态进程
  |
  | read(fd, buf, count)
  v
syscall entry
  |
  v
current task_struct
  |
  +-- files_struct -> fdtable -> struct file
  |
  v
VFS
  |
  +-- page cache 命中
  |       |
  |       v
  |   copy_to_user(buf) -> 返回用户态
  |
  +-- 数据未准备好
          |
          v
      wait queue
          |
          v
      schedule()
          |
          v
      之后被唤醒继续执行
```

这张图里已经出现了后续章节的入口：

| 主题 | 入口 |
| --- | --- |
| 进程模型 | `current -> task_struct` |
| 文件系统 | fdtable -> `struct file` -> VFS -> inode/page cache |
| 虚拟内存 | buf -> `mm_struct` -> VMA -> page table -> page fault |
| 调度器 | task state -> wait queue -> runqueue -> `schedule()` |
| 并发同步 | wait queue、锁、唤醒路径 |
| tracing/BPF | syscall、tracepoint、kprobe、调度事件、网络事件 |

易混点记录：

- `read()` 进入内核时，CPU 仍然可以在同一个 task 的内核路径上执行。
- fd 是当前 task 的文件表索引，作用域在当前文件表。
- buf 是用户态虚拟地址，内核写它前要检查和复制。
- `read()` 卡住时，卡住的是当前 task；CPU 会去跑别的 task。
- page fault 不一定是程序错误，也可能是内核按需建立映射。

## 观察命令

用户态 syscall：

```bash
strace -e read,write,openat,close cat data.txt
```

进程和线程：

```bash
ps -eLf
ls /proc/<pid>/task
cat /proc/<pid>/status
```

地址空间：

```bash
cat /proc/<pid>/maps
cat /proc/<pid>/smaps
pmap <pid>
```

文件描述符：

```bash
ls -l /proc/<pid>/fd
cat /proc/<pid>/fdinfo/<fd>
lsof -p <pid>
```

调度和上下文切换：

```bash
vmstat 1
pidstat -w 1
perf sched record -- sleep 3
perf sched latency
```

## 源码位置

| 路径 | 内容 |
| --- | --- |
| `arch/x86/entry/entry_64.S` | x86-64 syscall/interrupt 入口 |
| `arch/x86/entry/common.c` | syscall 进入通用 C 路径 |
| `fs/read_write.c` | read/write 系统调用与 VFS 入口 |
| `include/linux/sched.h` | `task_struct` 相关定义 |
| `include/linux/fdtable.h` | fd table 相关结构 |
| `include/linux/fs.h` | `struct file`、inode、`file_operations` |
| `mm/memory.c` | page fault 和内存映射核心路径之一 |
| `kernel/sched/core.c` | `schedule()` 和核心调度逻辑 |

源码阅读沿路径抓对象关系：`current` 怎么连到 `files_struct`，fd 怎么连到 `struct file`，用户地址怎么连到 `mm_struct` 和 VMA，阻塞怎么连到 wait queue 和 runqueue。

## 例子：最小 OS 模型对照

简化 OS 模型里，`read()` 这类请求可以放进 trap / syscall 入口理解：

```text
trap 入口
  -> 保存当前 context
  -> 找到当前 task
  -> 根据事件类型调用 handler
  -> 如果需要切换，调度器返回下一个 task 的 context
```

教学 OS 里的 task 通常只有 `status/context/stack` 这类字段，trap handler 按顺序执行，调度器从 runnable 队列里选下一个 task。Linux 的 `read()` 路径保留了这条骨架，但每一步都接到更具体的对象：`current`、`files_struct`、`struct file`、VFS、VMA、wait queue、runqueue。

## 本章检查点与参考回答

| 问题 | 参考回答 |
| --- | --- |
| `read(fd, buf, count)` 进入内核后先检查什么？ | `fd` 要在当前 task 的 `files_struct` / fdtable 中解析成 `struct file`；`buf` 是用户虚拟地址，要通过用户地址访问接口检查和复制；`count` 要限制读写长度并处理返回值。 |
| fd 和 `struct file` 的区别是什么？ | fd 是当前文件表里的整数索引，作用域在当前进程或共享文件表内；`struct file` 是打开文件对象，记录 offset、flags、引用计数和 `file_operations`。 |
| 为什么内核不能直接写用户态 `buf`？ | `buf` 是用户态虚拟地址，可能无效、权限不匹配或在复制过程中触发 page fault。内核要通过 `copy_to_user()` 这类接口处理访问检查、异常和失败返回。 |
| page fault 一定是程序错误吗？ | page fault 是地址翻译或权限检查失败后进入内核的异常。合法 fault 可用于按需分配物理页、建立文件映射或处理 COW；非法访问才会导致 `SIGSEGV` 或 syscall 返回错误。 |
| `read()` 等不到数据时发生什么？ | 当前 task 设置睡眠状态，挂到对应等待队列，然后调用 `schedule()` 让出 CPU。数据到达或 I/O 完成后，唤醒路径把 task 放回 runqueue，之后继续执行原来的内核路径。 |

## 本章参考

- [Linux kernel documentation: The Linux kernel user's and administrator's guide](https://docs.kernel.org/admin-guide/)
- [Linux kernel documentation: Adding a New System Call](https://docs.kernel.org/process/adding-syscalls.html)
- [Linux kernel documentation: Core API](https://docs.kernel.org/core-api/index.html)
- [Linux kernel documentation: Memory Management](https://docs.kernel.org/mm/index.html)
- [Linux kernel documentation: Filesystems](https://docs.kernel.org/filesystems/index.html)
- Remzi H. Arpaci-Dusseau and Andrea C. Arpaci-Dusseau, [Operating Systems: Three Easy Pieces](https://pages.cs.wisc.edu/~remzi/OSTEP/)
- [小林 Code：图解系统](https://xiaolincoding.com/os/)
- Michael Kerrisk, *The Linux Programming Interface*
- Robert Love, *Linux Kernel Development*
