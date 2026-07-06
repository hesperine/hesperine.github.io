---
title: Linux 内核学习笔记（一）：从一次 read() 看内核如何接管执行
date: 2026-07-06 20:30:00 +0800
categories: [学习笔记, Linux 内核笔记]
tags: [Linux, Linux Kernel, Operating System, System Call, Scheduler, Virtual Memory]
---

{% comment %}
系列规划参考 OSTEP 的三块结构，但每章都落到 Linux 的真实路径、数据结构和工具。

OSTEP: Virtualization
1. 从一次 read() 看内核如何接管执行
2. 进程模型：task_struct、fork、execve、exit、wait
3. 调度器：runqueue、调度类、CFS/EEVDF、实时调度
4. 虚拟内存：VMA、页表、缺页异常、mmap、COW
5. 内存分配与回收：buddy、slub、LRU、OOM

OSTEP: Concurrency
6. 线程与内核并发：clone、pthread、futex
7. 内核同步：spinlock、mutex、RCU、wait queue
8. 中断与 deferred work：IRQ、softirq、workqueue

OSTEP: Persistence
9. 文件系统与 I/O：VFS、inode、dentry、page cache、block layer
10. 网络栈：socket、NAPI、sk_buff、XDP/tc

Linux 机制扩展
11. namespace、cgroup 与容器
12. tracing：procfs、sysfs、ftrace、perf、tracepoint
13. BPF：verifier、map、helper、BTF、CO-RE、sched_ext
{% endcomment %}

这组笔记按 OSTEP 的大结构展开：先看 CPU 和内存如何被虚拟化，再看并发，最后看持久化。每一章同时绑定 Linux 里的真实路径、关键数据结构和可观察现象。

进程部分会看 `task_struct`、`fork()`、`execve()`、`wait()`。内存部分会看 VMA、page fault、copy-on-write、`/proc/<pid>/maps`。文件系统部分会看 fd table、`struct file`、VFS、page cache。

第一章从一条具体执行路径开始：用户程序调用 `read()` 时，CPU 怎么从用户态切进内核，内核怎么找到当前进程的文件表，VFS 怎么把一个整数 fd 变成真正的文件对象，如果数据还没准备好，当前进程又是怎么睡眠、让出 CPU、之后再被唤醒的。

整条线大致会这样展开：

```text
Virtualization:
  process -> scheduling -> address space -> page fault -> memory reclaim

Concurrency:
  thread -> lock -> futex -> interrupt -> deferred work -> RCU

Persistence:
  fd -> VFS -> page cache -> block layer -> filesystem

Linux-specific:
  namespace/cgroup -> tracing/perf/ftrace -> BPF
```

这一章只抓三个入口：

```text
read() 系统调用    -> 用户主动请求内核服务
page fault         -> 当前指令访问内存时被硬件打断
schedule()         -> 内核决定当前任务不再继续占用 CPU
```

这三个入口足够把第一批关键概念落到实处：用户态/内核态、系统调用、异常、进程上下文、内核栈、文件描述符、VFS、缺页异常、阻塞、唤醒和上下文切换。

## 从用户态的一行代码开始

先看一个很普通的程序：

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

在 C 语言层面，这只是一次函数调用。但从 Linux 内核角度看，`read(fd, buf, 4096)` 至少牵涉四件事：

```text
1. 通过系统调用入口从用户态进入内核态；
2. 根据当前进程的 fd table 找到 fd 对应的 struct file；
3. 经过 VFS 分发到具体文件系统或设备的 read 实现；
4. 把数据复制回用户地址空间，或者在数据没准备好时阻塞当前任务。
```

## 系统调用不是普通函数调用

用户态的 `read()` 通常是 libc 包装函数。它最终会触发 CPU 的 syscall 指令，带着系统调用号和参数进入内核。以 x86-64 Linux 为例，参数大致通过寄存器传递：

```text
rax = syscall number
rdi = fd
rsi = buf
rdx = count
```

`syscall` 指令做的事情不是“跳到另一个 C 函数”这么简单。它会让 CPU 进入更高权限级别，切换到内核定义好的入口地址，并让内核开始在当前任务的内核栈上执行。

入口路径：

```text
用户态代码
  |
  | syscall instruction
  v
arch/x86/entry/entry_64.S
  |
  v
arch/x86/entry/common.c
  |
  v
具体 syscall 实现，例如 read
```

不同内核版本里函数名和宏展开会变化，但主线大致是：架构相关的汇编入口先保存必要寄存器、建立内核执行环境，然后进入通用 syscall 分发逻辑，最后根据 syscall number 调到具体实现。

内核不是替用户程序“调用一个库函数”，而是在当前任务的上下文里执行内核代码。执行 `read()` 的仍然是当前进程对应的执行流，只是它现在处在内核态。

系统调用参数来自用户态，内核不能直接信任。`fd` 可能无效，`buf` 可能指向非法地址，`count` 可能过大。内核必须检查用户指针，并通过 `copy_to_user()`、`copy_from_user()` 这类接口在用户地址空间和内核之间拷贝数据。

## 当前进程是谁：current 和 task_struct

进入内核以后，内核需要知道“是谁发起了这个系统调用”。Linux 通过 `current` 找到当前 CPU 上正在运行的任务，也就是当前的 `task_struct`。

可以先把 `task_struct` 理解成 Linux 内核里“可调度实体”的中心对象。它不直接装下所有东西，而是挂着很多子结构：

```text
task_struct
  |
  +-- mm              -> 用户态地址空间，指向 mm_struct
  +-- files           -> 打开的文件表，指向 files_struct
  +-- fs              -> cwd/root/umask 等文件系统上下文
  +-- signal/sighand  -> 信号相关状态
  +-- cred            -> uid/gid/capability 等权限信息
  +-- sched fields    -> 调度相关字段
  +-- stack           -> 内核栈
```

所以 `read(fd, buf, count)` 进入内核后，不是全局地找一个文件，而是沿着当前任务的 `files` 找：

```text
current
  -> files_struct
      -> fd table
          -> struct file
```

fd 是进程局部的整数。两个进程都可以有 `fd = 3`，但它们的 `current->files` 不同，最终指向的 `struct file` 也可以完全不同。

## fd 不是文件，struct file 才是打开文件实例

`fd` 是用户态 handle；`struct file` 是内核里的打开文件实例。它里面保存了当前文件偏移、打开模式、引用计数，以及指向具体文件操作表的指针。

简化后可以这么看：

```text
int fd
  |
  v
files_struct / fdtable
  |
  v
struct file
  |
  +-- f_pos             当前文件偏移
  +-- f_flags           打开标志
  +-- f_inode           对应 inode
  +-- f_op              file_operations
```

这里容易混淆三个对象：

```text
fd            用户态整数，进程局部
struct file   一次 open 得到的打开文件对象，记录 offset/flags
struct inode  文件系统里的文件本体，记录元数据和底层对象
```

如果同一个进程 `open()` 两次同一个路径，会得到两个 fd，对应两个 `struct file`，所以文件偏移可以独立变化。如果 `fork()` 之后父子进程继承同一个打开文件对象，它们可能共享同一个 file offset。这类细节都不是“文件”这个抽象词能表达清楚的，必须落到内核对象上看。

## VFS 把 read 分发到具体实现

Linux 不希望每个用户程序关心底层是 ext4、xfs、procfs、pipe、socket 还是字符设备。因此系统调用层不会直接写死某个文件系统实现，而是走 VFS。

简化路径可以写成：

```text
read(fd, buf, count)
  -> syscall entry
  -> 找到 struct file
  -> vfs_read()
  -> file->f_op->read_iter 或相关实现
  -> 具体文件系统 / 设备 / socket / pipe
```

VFS 把“读一个 fd”统一成一组内核对象和操作接口。普通文件、管道、socket 都能被 `read()`，不是因为它们在硬件上相似，而是因为它们在 VFS/文件接口层面暴露了相似操作。

这里也能看出 Linux 的一个设计习惯：很多内核对象都尽量以 fd 形式暴露给用户态。除了普通文件，还有 pipe、socket、epoll、eventfd、timerfd、signalfd，后面学 BPF 时也会看到 BPF program、map、link 可以通过 fd 管理生命周期。

## read 可能不会立刻返回

如果数据已经在 page cache 里，普通文件的 `read()` 可以较快地把数据复制到用户缓冲区。但如果数据不在内存里，或者读的是 pipe/socket 这类可能暂时没有数据的对象，当前任务就可能不能继续执行。

这时内核不会让 CPU 空转等数据，而是把当前任务标记成某种睡眠状态，挂到等待队列上，然后调用调度器让出 CPU。

简化成：

```text
当前任务调用 read()
  |
  v
数据未准备好
  |
  v
设置 task state，例如 TASK_INTERRUPTIBLE / TASK_UNINTERRUPTIBLE
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

之后，当磁盘 I/O 完成、网络包到达、pipe 另一端写入数据，内核会唤醒等待队列上的任务，把它重新放回 runqueue。等调度器再次选中它时，它从当初睡眠的内核路径继续往下走，最终把数据复制回用户态并从 `read()` 返回。

阻塞不是用户态函数自己“暂停了一会儿”，而是当前任务在内核里让出 CPU，并依靠内核事件和调度器恢复执行。

## 内核栈：系统调用执行到一半时状态放在哪里

每个任务都有内核栈。用户程序平时运行在用户栈上；一旦进入内核，内核代码使用的是当前任务的内核栈。

`read()` 执行到一半阻塞时，当前任务的内核栈、寄存器保存状态、调度上下文一起保留它在内核中的执行位置。

阻塞 `read()` 的执行片段：

```text
task A:
  用户态调用 read()
  进入内核
  在内核栈上执行到等待 I/O 的位置
  设置睡眠状态
  schedule() 切走

task B:
  被调度运行

I/O 完成:
  唤醒 task A

task A:
  再次被调度
  从之前的内核栈位置继续执行
  copy_to_user()
  返回用户态
```

所以进程上下文不是一个抽象词。它至少意味着：这段内核代码是代表某个具体 task 执行的，可以访问 `current`，可以睡眠，可以被调度走，之后还能恢复。

## page fault 是另一个入口

系统调用是用户程序主动进入内核。page fault 则是当前指令访问内存时，由 CPU/MMU 发现地址翻译失败或权限不满足，于是进入内核异常处理路径。

例如：

```c
char *p = malloc(4096 * 1024);
p[0] = 1;
```

`malloc()` 返回一段虚拟地址，并不意味着对应物理页已经全部分配。第一次写 `p[0]` 时，CPU 查页表，发现对应页还没有建立有效映射，就触发 page fault。

缺页异常进入内核后，内核会根据当前任务的 `mm_struct` 和 VMA 判断：

```text
这个地址是否落在某个合法 VMA 内？
访问权限是否匹配？比如写只读页是否合法？
这是匿名页、文件映射页，还是 copy-on-write？
需要分配新物理页，还是从文件/page cache 建立映射？
```

如果合法，内核修好页表，然后返回到触发 fault 的那条指令，让它重新执行。用户程序通常感觉不到这件事发生过。

如果不合法，例如访问 `NULL` 或越界访问未映射区域，内核会向进程发送 `SIGSEGV`。

所以 page fault 不是简单的“程序崩了”。它有两种完全不同的含义：

```text
合法 fault   -> 内核补齐映射，程序继续
非法 fault   -> 发送 SIGSEGV，通常导致进程终止
```

后面学虚拟内存时，`mmap()`、lazy allocation、copy-on-write、page cache 都会回到这个路径上。

## 系统调用、异常、中断的区别

三类内核入口的区别：

| 入口 | 触发者 | 例子 | 是否同步 | 当前任务上下文 |
| --- | --- | --- | --- | --- |
| syscall | 用户程序主动触发 | `read()`、`write()`、`mmap()` | 同步 | 有 |
| exception | 当前指令触发 | page fault、除零、非法指令 | 同步 | 通常有 |
| interrupt | 外部设备触发 | 网卡收包、磁盘完成、定时器 | 异步 | 不一定代表当前任务 |

系统调用和 page fault 都和当前执行流强相关；中断则可能在任意任务运行时到来。网卡中断发生时，当前 CPU 上正在跑的任务未必和这个网络包有任何关系。

这也是为什么中断上下文和进程上下文限制不同。进程上下文里通常可以睡眠；中断上下文里不能随便睡眠，因为它不是代表某个普通任务在执行，也没有一个可以正常阻塞等待的进程语义。

## schedule() 连接了阻塞和 CPU 分配

前面说 `read()` 数据没准备好会调用 `schedule()`。这一步是连接 I/O 和调度器的关键。

简化的调度过程是：

```text
当前任务不再 runnable
  |
  v
调用 schedule()
  |
  v
调度器从当前 CPU 的 runqueue 里选下一个 runnable task
  |
  v
context switch
  |
  v
切到新任务继续执行
```

这里的 runqueue 是调度器维护的可运行任务集合。一个任务是否在 runqueue 上，取决于它当前是不是 runnable。等待 I/O、等待锁、等待事件时，它通常不在普通可运行队列里；被唤醒后才重新回去。

上下文切换要保存和恢复执行状态。它不只是换一个 `task_struct` 指针，还会涉及寄存器、栈、地址空间、调度统计，以及可能的 TLB/cache 影响。因此上下文切换是必要机制，但不是免费机制。

## 第一章的主线图

把 `read()`、page fault 和调度连起来，可以得到第一张 Linux 内核机制图：

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
  +-- page cache 命中 -> copy_to_user() -> 返回用户态
  |
  +-- 数据未准备好 -> wait queue -> schedule()
                              |
                              v
                        context switch
                              |
                              v
                        之后被唤醒继续执行

用户态访问内存
  |
  | load/store
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

本章留下四条路径：

```text
fd 路径：
current -> files_struct -> fdtable -> struct file -> VFS -> 具体实现

内存路径：
current -> mm_struct -> VMA -> page table -> struct page

阻塞路径：
task state -> wait queue -> schedule() -> wakeup -> runqueue

执行入口：
syscall / exception / interrupt -> kernel entry -> return to user
```

后面每一章都可以沿着这些路径继续挖。进程模型会展开 `task_struct`；虚拟内存会展开 `mm_struct`、VMA 和 page fault；文件系统会展开 VFS、inode、dentry 和 page cache；调度会展开 runqueue、调度类和上下文切换；BPF 和 tracing 会回到 syscall、tracepoint、kprobe、网络 hook 这些具体入口。

## 这一章先留下的源码锚点

源码锚点：

```text
arch/x86/entry/entry_64.S        x86-64 syscall/interrupt 入口
arch/x86/entry/common.c          syscall 进入通用 C 路径
fs/read_write.c                  read/write 系统调用与 VFS 入口
include/linux/sched.h            task_struct 相关定义
include/linux/fdtable.h          fd table 相关结构
include/linux/fs.h               struct file、inode、file_operations
mm/memory.c                      page fault 和内存映射核心路径之一
kernel/sched/core.c              schedule() 和核心调度逻辑
```

具体版本的函数名可能会变，但这些目录边界相对稳定。读 Linux 源码时，先抓“对象怎么连起来”和“路径怎么走”，比逐行读完整函数更有效。

## 本章参考

- [Linux kernel documentation: The Linux kernel user's and administrator's guide](https://docs.kernel.org/admin-guide/)
- [Linux kernel documentation: Adding a New System Call](https://docs.kernel.org/process/adding-syscalls.html)
- [Linux kernel documentation: Core API](https://docs.kernel.org/core-api/index.html)
- [Linux kernel documentation: Memory Management](https://docs.kernel.org/mm/index.html)
- [Linux kernel documentation: Filesystems](https://docs.kernel.org/filesystems/index.html)
- Remzi H. Arpaci-Dusseau and Andrea C. Arpaci-Dusseau, [Operating Systems: Three Easy Pieces](https://pages.cs.wisc.edu/~remzi/OSTEP/)
- Michael Kerrisk, *The Linux Programming Interface*
- Robert Love, *Linux Kernel Development*
