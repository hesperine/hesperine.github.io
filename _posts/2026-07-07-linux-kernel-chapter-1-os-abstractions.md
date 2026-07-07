---
title: Linux 内核学习笔记（一）：OS 基本抽象复习
date: 2026-07-07 17:20:00 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, Operating System, OSTEP]
---

OS 基本抽象复习。这里暂时不追某一条 Linux 内核路径，只整理几个高频边界：`read()`、`fork()`、page fault、调度器、VFS、BPF 都会用到它们。

OSTEP 把操作系统的核心问题分成三类：虚拟化、并发、持久化。虚拟化让有限硬件看起来像多个程序各自拥有 CPU 和内存；并发让多个执行流同时存在，并处理同步、竞争和顺序问题；持久化让数据在程序结束、机器断电之后仍然存在。

Linux 内核把这些问题落成一组具体对象：

| 问题 | Linux 对象 |
| --- | --- |
| CPU 虚拟化 | `task_struct`、调度器、runqueue |
| 内存虚拟化 | `mm_struct`、VMA、页表、page fault |
| 持久化和 I/O | fd、`struct file`、inode、VFS、page cache |
| 并发和同步 | thread、futex、spinlock、mutex、RCU |
| 硬件事件 | interrupt、softirq、workqueue |

六大模块的抽象入口：

| 模块 | 抽象问题 | Linux 对象 |
| --- | --- | --- |
| 进程管理 | 执行实体和资源边界 | `task_struct`、pid/tgid、`clone()`、`execve()` |
| 调度系统 | CPU 分配和状态切换 | task state、runqueue、`schedule()` |
| 内存管理 | 地址空间和物理页 | `mm_struct`、VMA、页表、`struct page` |
| 文件系统 | 命名、fd、持久化 | fdtable、`struct file`、dentry、inode、VFS |
| 设备管理 | 硬件事件和 I/O | driver、IRQ、DMA、workqueue |
| 网络系统 | socket 和协议栈 | socket、`sk_buff`、NAPI、qdisc |

本章的写法是先确认概念边界，再给 Linux 对应物。名词需要记，但每个名词都绑定到后续能观察或阅读的对象上。

## 术语表 / 八股检查点

| 名词 | 简要定义 | Linux 对应入口 |
| --- | --- | --- |
| process | 资源组织边界和一次程序运行实例 | 一个或多个 `task_struct` 加资源引用 |
| thread | 同一进程内共享地址空间等资源的执行流 | 一个可调度 task |
| task | Linux 内核可调度、可阻塞、可唤醒的执行实体 | `task_struct` |
| coroutine | 用户态 runtime 管理的执行单元 | 内核通常只看到承载它的线程 |
| address space | 进程看到的虚拟内存布局 | `mm_struct`、VMA、页表 |
| virtual address | 程序指针使用的地址 | 由页表翻译 |
| physical page | 机器上的物理内存页 | `struct page` |
| fd | 进程局部的整数 handle | `files_struct`、fdtable |
| syscall | 用户态主动请求内核服务的入口 | syscall entry、syscall table |
| exception | 当前指令触发的异常入口 | page fault、divide error |
| interrupt | 外部设备或定时器触发的异步入口 | IRQ、softirq |
| context switch | CPU 从一个 task 切到另一个 task | `schedule()`、`context_switch()` |
| blocking | task 等事件而让出 CPU | wait queue、task state |
| wakeup | 事件发生后把 task 放回可运行集合 | `wake_up()`、runqueue |

当前边界问题记录：

- 进程和线程到底谁是内核调度对象？
- task 是进程还是线程？
- 协程和线程的调度边界在哪里？
- 地址空间和物理内存是什么关系？
- fd 为什么既能代表文件，也能代表 socket、epoll、BPF map？
- 系统调用、异常、中断都是进入内核，它们差在哪里？
- 进入内核态和上下文切换是什么关系？

本篇记录这些抽象边界。进入 Linux 源码后，名字会变成更具体的结构体和函数，但边界大体不变。

## 用户态和内核态

用户态是普通程序运行的位置。它能执行自己的代码，读写自己的虚拟地址空间，通过库函数组织逻辑，但不能直接管理硬件资源。

内核态是内核运行的位置。内核可以管理页表、调度 CPU、处理中断、访问设备、维护文件系统和网络栈。

用户态进入内核态主要有三类入口：

| 入口 | 来源 | 例子 |
| --- | --- | --- |
| syscall | 用户程序主动请求内核服务 | `read()`、`mmap()` |
| exception | 当前指令触发异常 | 缺页、除零 |
| interrupt | 外部设备或定时器打断当前执行 | 网卡收包、定时器 tick |

用户态和内核态对应 CPU 权限级别和执行路径。同一个进程在用户态执行自己的代码，通过 syscall 进入内核态执行内核代码，再返回用户态继续运行。

Linux 对应物：

| 对象 | 位置或接口 |
| --- | --- |
| 系统调用入口 | `arch/x86/entry/` |
| 系统调用表 | syscall number -> syscall implementation |
| 用户态地址检查 | `copy_from_user()` / `copy_to_user()` |

## 进程

进程是程序的一次运行实例，也是内核组织资源、地址空间和执行状态的单位。它包含：

- 执行状态：寄存器、程序计数器、栈。
- 地址空间：代码、数据、堆、栈、mmap 区域。
- 资源引用：打开文件、当前目录、信号处理、权限。
- 调度状态：是否 runnable、优先级、调度类。
- 隔离关系：namespace、cgroup、凭据。

Linux 里理解进程/线程的主要入口是 `task_struct`。用户态说的“进程”和“线程”，到 Linux 内核里都会落到一个个可调度的 task 上。

`fork()` 创建新进程，`execve()` 替换当前进程的用户态程序映像，`exit()` 结束当前 task，`wait()` 回收子进程退出状态。线程则通常由线程库通过 `clone()` / `clone3()` 创建共享资源的新 task。

## task

教学 OS 里的最小 task 模型：

```text
task
  |
  +-- status     RUNNING / RUNNABLE / BLOCKED / DEAD
  +-- context    被切走时保存的寄存器和执行位置
  +-- stack      这个执行流自己的栈
  +-- name/id    调试和管理用
```

这个模型比 Linux 的 `task_struct` 小很多，但已经包含“可调度执行实体”的核心：保存现场、恢复运行、标记是否还能被调度。

Linux 的 `task_struct` 是这个模型的工业版本。它除了保存执行流本身，还挂着地址空间、文件表、信号、权限、调度统计、cgroup、namespace 等大量资源引用。

```text
task_struct
  |
  +-- mm              地址空间
  +-- files           文件表
  +-- fs              当前目录、root 等
  +-- signal/sighand  信号
  +-- cred            权限
  +-- sched fields    调度状态
```

`task` 是 Linux 内核调度和管理的执行实体。内核调度器看到的是一个个 task；用户态按照资源共享关系把这些 task 组织成进程或线程。

一个 task 至少包含两类信息：执行流本身，包括寄存器状态、内核栈、调度状态、当前运行/睡眠/停止等状态；资源引用，包括地址空间 `mm_struct`、文件表 `files_struct`、信号、权限、namespace、cgroup。

普通进程和线程的核心差别在资源共享关系。

普通进程大致是：

```text
task A
  |
  +-- 自己的 mm_struct
  +-- 自己的 files_struct
  +-- 自己的信号和资源视图
```

同一进程里的多个线程大致是：

```text
task A
  |
  +-- 共享 mm_struct
  +-- 共享 files_struct
  +-- 同一个线程组

task B
  |
  +-- 共享同一个 mm_struct
  +-- 共享同一个 files_struct
  +-- 同一个线程组
```

`clone()` / `clone3()` 创建一个新 task，并用 flags 决定共享哪些资源。典型 flags 包括：

```text
CLONE_VM       共享地址空间
CLONE_FILES    共享文件描述符表
CLONE_FS       共享 cwd/root 等文件系统上下文
CLONE_SIGHAND  共享信号处理表
CLONE_THREAD   放进同一个线程组
```

`fork()` 可以理解为资源隔离程度更高的一类 task 创建；`pthread_create()` 是用户态线程库 API，底层会使用 `clone()` / `clone3()` 创建更像线程的新 task。

判断边界时直接看内核调度器能不能单独调度它。能被单独调度，至少对应一个 task；不能被单独调度，可能只是用户态 runtime 里的执行单元，例如协程。

## 线程

线程是同一进程里的多个执行流。它们共享同一份地址空间，因此一个线程写全局变量，另一个线程能看到。线程也可以共享打开文件表、信号处理等资源。

线程带来并发，也带来同步问题：

- 多个线程同时写同一变量。
- 一个线程等待另一个线程完成。
- 一个线程持锁时被调度走。
- 多个线程同时阻塞在同一个条件变量上。

OSTEP 的锁、条件变量、信号量主要是用户态并发抽象。Linux 里还要接到 pthread、`clone()` / `clone3()` 和 futex。很多 pthread 锁的快路径在用户态完成，只有竞争或等待时才通过 futex 进入内核。

Linux 对应物：

| 对象 | Linux 对应物 |
| --- | --- |
| 线程库 API | `pthread_create()` |
| 内核 task 创建 | `clone()` / `clone3()` |
| 用户态锁等待 | `futex()` |
| 线程列表 | `/proc/<pid>/task` |

## 协程

协程是用户态 runtime 管理的执行单元。内核调度器通常只看到承载协程的进程或线程。

几种常见关系：

| 模型 | 进程 | 内核可见执行实体 | 用户态执行单元 |
| --- | --- | --- | --- |
| 单线程 Python asyncio | 1 个进程 | 1 个内核 task | 多个 coroutine |
| 多线程 C 程序 | 1 个进程 | 多个 pthread / 内核 task | 线程函数 |
| Go 程序 | 1 个进程 | 若干内核线程 task | 大量 goroutine |

协程切换通常发生在用户态，成本低于内核线程上下文切换。但协程 runtime 仍然要和内核打交道：网络 I/O 通常依赖 `epoll`、`io_uring` 或类似机制；如果某个协程执行了阻塞 syscall，runtime 需要避免整个线程被卡住。

协程的调度权在语言 runtime 手里；内核调度承载这些协程的线程 task。一个协程阻塞在普通同步 `read()` 上，如果 runtime 没有特殊处理，可能卡住整个承载线程；使用非阻塞 I/O、`epoll`、`io_uring` 时，runtime 可以把等待 I/O 的协程挂起，切到其他协程继续运行。

层次记录：

| 名字 | 记录 |
| --- | --- |
| 进程 | 资源边界和地址空间 |
| 线程 | 内核可见、可调度的执行流 |
| 协程 | 用户态 runtime 可见、通常内核不可见的执行流 |
| task | Linux 内核看到的可调度执行实体 |

## 地址空间

地址空间是进程看到的虚拟内存布局。用户程序里的指针使用虚拟地址，CPU/MMU 通过页表把它翻译到物理页。

一个进程的地址空间通常包括：

代码段、只读数据、全局数据、堆、mmap 区域、用户栈、共享库映射。

Linux 用 `mm_struct` 描述整个地址空间，用 VMA 描述一段连续虚拟地址区域。

```text
mm_struct
  |
  +-- VMA: text, r-x
  +-- VMA: heap, rw-
  +-- VMA: libc mapping
  +-- VMA: stack, rw-
  +-- page table
```

页表把虚拟地址翻译成物理页。访问一个还没有建立映射、但属于合法 VMA 的地址时，会触发 page fault。内核可以分配新页、建立文件映射，或者处理 copy-on-write。

Linux 对应物：

| 对象 | 说明 |
| --- | --- |
| `/proc/<pid>/maps` | 查看 VMA |
| `/proc/<pid>/smaps` | 查看映射细节 |
| `mm_struct` | 进程地址空间 |
| `vm_area_struct` | VMA |

## 文件描述符

文件描述符是进程用来引用内核对象的整数。它可以指向普通文件，也可以指向 pipe、socket、eventfd、timerfd、epoll 实例。

```text
fd
  |
  v
files_struct
  |
  v
fdtable
  |
  v
struct file
```

`fd = 3` 在不同进程里可以指向完全不同的对象。fd 是进程局部的，真正的打开文件状态在 `struct file` 里。

`struct file` 记录当前 offset、打开 flags、引用计数、`file_operations`、底层 inode / socket / pipe 等对象。

文件描述符把很多不同对象统一到一套接口里：`read()`、`write()`、`poll()`、`close()`。Linux 里“一切皆文件”更接近真实含义的地方是：很多对象都能以 fd 形式进入统一 I/O 接口。

## 系统调用

系统调用是用户程序请求内核服务的正式入口。典型 syscall 包括 `openat()`、`read()`、`write()`、`close()`、`mmap()`、`clone()`、`execve()`、`wait4()`、`socket()`、`ioctl()`。

系统调用的边界很硬：参数来自用户态，内核必须检查。用户传来的指针不能直接当内核指针用，用户传来的 fd 也不一定有效。

Linux 对应物包括 syscall number、syscall entry、`copy_from_user()`、`copy_to_user()`、`errno`。

`strace` 是观察 syscall 的第一工具。

## 异常和中断

异常和中断都会让 CPU 进入内核，但来源不同。

异常来自当前指令：

- page fault
- divide error
- invalid opcode
- general protection fault

中断来自外部事件：

- timer interrupt
- network packet arrival
- disk I/O completion
- keyboard input

异常通常和当前进程有关。page fault 发生时，内核要看当前进程的地址空间，判断这个地址是否合法。

中断不一定和当前进程有关。网卡收包时，当前 CPU 上运行的可能是任意进程；内核只是被硬件事件打断，进入中断处理路径。

这一区分会影响能不能睡眠。进程上下文里通常可以睡眠；中断上下文里不能随便睡眠。

## 上下文切换

上下文切换是 CPU 从一个 task 切到另一个 task。用户态进入内核态是同一个 task 切换到内核执行路径。

| 动作 | 含义 |
| --- | --- |
| syscall | 同一个 task 从用户态进入内核态 |
| context switch | CPU 从 task A 切到 task B |

上下文切换可能发生在：

- 时间片用完。
- 当前 task 等 I/O。
- 当前 task 等锁。
- 更高优先级 task 被唤醒。
- 主动调用 sleep/yield。

切换时需要保存当前 task 的执行状态，恢复下一个 task 的执行状态。如果切到不同进程，还会涉及地址空间切换和 TLB 影响。

教学 OS 里经常能直接看到这个动作：当前 task 的 `context` 被保存，调度器从队列里拿出下一个 runnable task，再返回下一个 task 的 `context`。Linux 的实现更复杂，但核心动作仍然是保存当前执行状态、选择下一个 task、恢复它的执行状态。

进入内核态是同一个 task 换到内核代码路径执行；上下文切换是 CPU 从 task A 换到 task B。

Linux 对应物：

`schedule()`、runqueue、`context_switch()`、task state。

观察入口：

```bash
vmstat 1
pidstat -w 1
perf sched record -- sleep 3
perf sched latency
```

## 阻塞和唤醒

阻塞通常意味着当前 task 改变状态，挂到某个等待队列，然后让出 CPU。

```text
task 调用 read()
  |
  v
数据未准备好
  |
  v
加入 wait queue
  |
  v
schedule()
```

事件发生后，内核唤醒等待队列上的 task，把它放回 runqueue。调度器之后再选择它运行。

阻塞和唤醒会贯穿很多主题：I/O、锁、futex、网络、定时器、进程等待。

简化 OS 模型里的阻塞：把 task 从“可调度集合”里拿掉。比如信号量 `wait` 没有资源时，task 进入 blocked 状态，不再被调度；`signal` 或 I/O 完成后，它再回到 runnable 队列。Linux 里等待队列、唤醒函数和调度类更复杂，但这条状态转换主线不变：

```text
RUNNING -> BLOCKED -> RUNNABLE -> RUNNING
```

## 压缩表

| 抽象 | Linux 对应物 | 观察入口 |
| --- | --- | --- |
| task | `task_struct` | `ps -eLf`, `/proc/<pid>/task` |
| 进程 | 一个或多个 task 加资源边界 | `ps`, `/proc/<pid>/status` |
| 线程 | 共享地址空间等资源的 task | `ps -eLf`, `/proc/<pid>/task` |
| 协程 | 用户态 runtime 执行单元 | runtime 工具、日志、profiling |
| 地址空间 | `mm_struct`, VMA | `/proc/<pid>/maps` |
| 文件描述符 | `files_struct`, `struct file` | `/proc/<pid>/fd` |
| 系统调用 | syscall entry | `strace` |
| 上下文切换 | `schedule()`, runqueue | `vmstat`, `perf sched` |
| 阻塞 / 唤醒 | wait queue, task state | `ps`, `perf sched`, ftrace |

后续 `read()` 路径会用到这里的大部分对象：用户态进入内核、当前进程、fd table、VFS、用户地址检查、等待队列和调度器。

## 本章检查点与参考回答

| 问题 | 参考回答 |
| --- | --- |
| 进程、线程、task、协程怎么区分？ | 进程是资源边界，通常拥有独立地址空间和 fd 表；线程是同一进程内的执行流，共享地址空间等资源；task 是 Linux 内核可调度的执行实体；协程由用户态 runtime 调度，内核通常只看到承载协程的线程。 |
| 用户态进入内核态和上下文切换有什么区别？ | 用户态进入内核态是同一个 task 从用户代码进入内核代码，例如 syscall 或 page fault；上下文切换是 CPU 从 task A 切到 task B，需要保存 A 的执行状态并恢复 B 的执行状态。 |
| 地址空间、虚拟地址、物理页、页表是什么关系？ | 地址空间是进程看到的虚拟内存布局；程序指针是虚拟地址；页表把虚拟地址翻译到物理页；物理页是机器内存中的真实页框。 |
| fd、fdtable、`struct file`、inode 怎么分层？ | fd 是进程局部整数；fdtable 把 fd 映射到 `struct file`；`struct file` 表示一次打开文件对象，记录 offset、flags、操作表；inode 表示文件系统里的文件本体和元数据。 |
| syscall、exception、interrupt 的触发来源是什么？ | syscall 由用户程序主动触发；exception 由当前指令触发，例如 page fault；interrupt 来自外部设备或定时器，和当前 task 不一定有直接关系。 |
| 阻塞和唤醒的状态线怎么说？ | task 运行时等不到事件会进入 blocked/sleeping 状态并让出 CPU；事件发生后，唤醒路径把它变回 runnable；调度器选中后再回到 running。 |

## 本章参考

- [Operating Systems: Three Easy Pieces](https://pages.cs.wisc.edu/~remzi/OSTEP/)
- [Linux Kernel Documentation](https://docs.kernel.org/)
- [小林 Code：图解系统](https://xiaolincoding.com/os/)
- Randal E. Bryant, David R. O'Hallaron, *Computer Systems: A Programmer's Perspective*
- Michael Kerrisk, *The Linux Programming Interface*
- Robert Love, *Linux Kernel Development*
