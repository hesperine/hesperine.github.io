---
title: Linux 内核学习笔记（一）：OS 基本抽象复习
date: 2026-07-07 17:20:00 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, Operating System, OSTEP]
---

第 1 章只整理后续反复出现的基本抽象：进程、线程、task、地址空间、文件描述符、系统调用、异常、中断、上下文切换、阻塞和唤醒。

本章按三个层次记：

| 笔记单元 | 记录内容 |
| --- | --- |
| 基础与八股 | 高频问法、术语边界、能直接背出来的参考回答 |
| OS 模型 | OSTEP 的 CPU 虚拟化、内存虚拟化、并发、持久化 |
| Linux 实现 | `task_struct`、`mm_struct`、`files_struct`、fdtable、VFS、runqueue、wait queue |

## 1.1 基础与八股：问题索引

| 问题 | 短回答 | Linux 落点 |
| --- | --- | --- |
| 程序和进程是什么关系？ | 程序是磁盘上的静态文件；进程是程序被加载后的一次运行。 | ELF 装载、`execve()`、`task_struct`、`mm_struct` |
| 并发和并行怎么区分？ | 并发强调多个任务交替推进；并行强调同一时刻多个任务真正同时运行。 | 调度器、多核 runqueue、CPU affinity |
| 进程有哪些状态？ | 创建、就绪、运行、阻塞、结束是教材模型；Linux 还会看到 sleeping、uninterruptible sleep、zombie 等状态。 | task state、`ps STAT`、`/proc/<pid>/status` |
| PCB 是什么？ | PCB 是 OS 描述和管理进程的数据结构。 | Linux 主要落到 `task_struct` 及其引用对象 |
| 进程控制包括什么？ | 创建、终止、阻塞、唤醒。 | `fork()` / `clone()`、`execve()`、`exit()`、`wait()`、wait queue |
| 进程和线程区别？ | 进程是资源边界；线程是进程内的执行流，通常共享地址空间和打开文件等资源。 | `clone()` flags、pid/tgid、`/proc/<pid>/task` |
| task 是什么？ | task 是 Linux 内核可调度、可阻塞、可唤醒的执行实体。 | `struct task_struct` |
| 用户态和内核态区别？ | 用户态运行普通程序；内核态运行内核代码并管理硬件和核心资源。 | syscall entry、异常入口、中断入口 |
| 系统调用、异常、中断区别？ | syscall 是程序主动请求；exception 来自当前指令；interrupt 来自外部设备或定时器。 | `arch/x86/entry/`、page fault、IRQ |
| 上下文切换是什么？ | CPU 从一个 task 切到另一个 task，保存前者状态并恢复后者状态。 | `schedule()`、`context_switch()`、runqueue |
| 地址空间是什么？ | 进程看到的虚拟内存布局。 | `mm_struct`、VMA、页表、`/proc/<pid>/maps` |
| 文件描述符是什么？ | 进程局部的整数 handle，用来引用内核里的打开文件对象或其他 I/O 对象。 | `files_struct`、fdtable、`struct file` |

## 1.2 OS 模型：虚拟化、并发、持久化

OSTEP 的主线可以压缩成三组问题。

| 主线 | OS 做的事 | 典型机制 |
| --- | --- | --- |
| CPU 虚拟化 | 让多个进程共享 CPU，看起来都在推进 | 进程、调度、上下文切换、定时器中断 |
| 内存虚拟化 | 让每个进程拥有独立的虚拟地址空间 | 地址空间、页表、TLB、page fault、换页 |
| 持久化 | 把数据组织成断电后仍存在的对象 | 文件、目录、inode、文件系统、日志、缓存 |
| 并发 | 处理多个执行流同时访问共享状态的问题 | 线程、锁、条件变量、信号量、futex |

这张表后面会一直复用。`read()` 属于系统调用和持久化路径，但会碰到 fd、VFS、page cache、等待队列和调度；`fork()` 属于进程管理，但会碰到地址空间、COW、文件表和调度；BPF 是观测和扩展机制，但挂载点分布在 syscall、调度、网络、文件系统等路径上。

## 1.3 进程：运行中的程序

程序是磁盘上的静态文件，通常是 ELF 可执行文件或脚本。进程是程序被加载到内存后形成的运行实体。

一个进程至少包含这些内容：

| 内容 | 说明 |
| --- | --- |
| 指令流 | CPU 正在执行或将要执行的代码位置 |
| 寄存器状态 | 程序计数器、栈指针、通用寄存器等 |
| 地址空间 | 代码、数据、堆、共享库、mmap 区域、用户栈 |
| 资源引用 | 打开的 fd、当前目录、root、信号处理、权限 |
| 调度状态 | running、runnable、sleeping、优先级、调度类 |
| 隔离和控制 | namespace、cgroup、credential |

Linux 里单线程进程可以粗略看成：

```text
task_struct
  -> mm_struct       地址空间
  -> files_struct    文件描述符表
  -> fs_struct       cwd/root 等文件系统上下文
  -> sighand/signal  信号处理和线程组信号状态
  -> cred            权限
  -> sched fields    调度信息
```

观察入口：

| 命令 / 路径 | 重点字段 |
| --- | --- |
| `ps -o pid,ppid,stat,comm -p <pid>` | pid、父进程、状态、命令名 |
| `/proc/<pid>/status` | `State`、`Tgid`、`Pid`、`PPid`、`Threads`、`Vm*` |
| `/proc/<pid>/cmdline` | 启动参数 |
| `/proc/<pid>/cwd` | 当前工作目录 |
| `/proc/<pid>/exe` | 可执行文件路径 |

## 1.4 进程状态：教材状态到 Linux 状态

教材里的五状态模型：

| 状态 | 含义 |
| --- | --- |
| new | 正在创建 |
| ready | 已经具备运行条件，等待 CPU |
| running | 正在 CPU 上运行 |
| blocked | 等待 I/O、锁、事件等条件 |
| exit | 运行结束，等待清理或已经清理 |

核心状态转换：

```text
new -> ready -> running -> exit
             ^    |
             |    v
           ready <- blocked
```

Linux 用户态常见到的是 `ps STAT`：

| `ps` 状态 | 对应含义 | 常见原因 |
| --- | --- | --- |
| `R` | running 或 runnable | 正在 CPU 上运行，或在 runqueue 等 CPU |
| `S` | interruptible sleep | 等待事件，可被信号打断 |
| `D` | uninterruptible sleep | 常见于某些 I/O 等待或内核不可中断等待 |
| `T` | stopped | job control 或 ptrace 停住 |
| `Z` | zombie | task 已退出，父进程还没有 `wait()` |

这里要记住两个边界：

| 边界 | 记录 |
| --- | --- |
| running 和 runnable | `R` 可能表示正在运行，也可能表示可运行但正在等 CPU |
| blocked 和 sleeping | 教材的 blocked 在 Linux 上会分化成可中断睡眠、不可中断睡眠、等待锁、等待 I/O 等具体状态 |

## 1.5 PCB：进程控制块到 `task_struct`

教材里的 PCB 保存 OS 管理进程需要的信息：

| PCB 信息 | Linux 对应 |
| --- | --- |
| 进程标识 | `pid`、`tgid`、`thread_pid` |
| 当前状态 | task state、exit state |
| CPU 上下文 | thread context、kernel stack、寄存器保存区 |
| 调度信息 | priority、policy、scheduler class、`sched_entity` |
| 地址空间 | `mm_struct` |
| 文件资源 | `files_struct`、fdtable |
| 信号 | `signal_struct`、`sighand_struct` |
| 权限 | `cred` |
| 父子关系 | `parent`、`real_parent`、children list |

Linux 的 `task_struct` 比教材 PCB 大得多。它既描述一个可调度执行实体，也挂着进程关系、资源引用、调度统计、namespace、cgroup、signal、security 等信息。

源码入口：

| 路径 | 内容 |
| --- | --- |
| `include/linux/sched.h` | `task_struct` 主体定义 |
| `kernel/fork.c` | `fork()` / `clone()` 创建 task 的主要路径 |
| `kernel/exit.c` | 退出和回收 |
| `kernel/sched/` | 调度器 |

## 1.6 进程控制：创建、终止、阻塞、唤醒

进程控制记录 OS 如何改变进程生命周期。教材里通常写成创建、终止、阻塞、唤醒四类操作。

| 控制动作 | OS 抽象 | Linux 对应路径 |
| --- | --- | --- |
| 创建 | 分配进程标识，初始化 PCB，进入就绪队列 | `fork()` / `clone()` 创建 task，`execve()` 替换用户态程序映像 |
| 终止 | 结束执行，释放资源，保留退出状态供父进程回收 | `exit()`、`do_exit()`、zombie、`wait()` |
| 阻塞 | 当前执行实体等待事件，离开可运行集合 | task state、wait queue、`schedule()` |
| 唤醒 | 等待事件发生，重新进入可运行集合 | `wake_up()`、`try_to_wake_up()`、runqueue |

创建进程时，Linux 通常不会完整复制一份资源。`fork()` 后地址空间通常依赖 copy-on-write；线程创建则通过 `clone()` flags 共享地址空间、文件表、信号处理等资源。`execve()` 不创建新 pid，它替换当前进程的用户态地址空间和程序映像。

进程退出后不一定立刻从系统视图里消失。子进程退出时，内核需要保存退出状态，父进程通过 `wait()` 系列调用回收。父进程没有回收前，用户态会看到 zombie。

阻塞和唤醒是后续 `read()`、futex、网络 socket、设备 I/O 的共同状态线：

```text
RUNNING -> SLEEPING -> RUNNABLE -> RUNNING
```

这条线在 Linux 里对应 wait queue、task state、`schedule()` 和 wakeup 路径。

## 1.7 线程：共享资源的执行流

线程是同一进程内的执行流。多线程的价值主要有三点：

| 价值 | 说明 |
| --- | --- |
| 并发 | 一个线程等待 I/O 时，其他线程还能继续执行 |
| 并行 | 多核机器上多个线程可以同时运行 |
| 共享数据方便 | 同一地址空间内共享堆、全局变量、mmap 区域 |

代价也直接来自共享：多个线程同时读写同一份数据，需要锁、条件变量、原子操作或其他同步机制。

Linux 里线程也是 task。线程和进程的差别主要由 `clone()` / `clone3()` 的 flags 决定：

| flag | 含义 |
| --- | --- |
| `CLONE_VM` | 共享地址空间 |
| `CLONE_FILES` | 共享文件描述符表 |
| `CLONE_FS` | 共享 cwd/root 等文件系统上下文 |
| `CLONE_SIGHAND` | 共享信号处理表 |
| `CLONE_THREAD` | 放进同一个线程组 |

用户态的 `pthread_create()` 通常会走到 `clone()` / `clone3()`。同一线程组里的 task 共享 `tgid`，每个 task 仍有自己的内核调度身份。

观察入口：

| 命令 / 路径 | 说明 |
| --- | --- |
| `ps -eLf` | 以 LWP 视角看线程 |
| `top -H -p <pid>` | 按线程看 CPU |
| `/proc/<pid>/task` | 一个线程一个目录 |
| `/proc/<pid>/task/<tid>/status` | 单个线程状态 |

## 1.8 task：Linux 调度器看到的实体

`task` 是 Linux 内核的执行实体。它能被调度、能睡眠、能被唤醒、能退出。

简化模型：

| 字段 | 含义 |
| --- | --- |
| id/name | 标识和调试 |
| state | running、sleeping、stopped、zombie 等 |
| context | 被切走时保存的 CPU 执行状态 |
| kernel stack | 进入内核后使用的栈 |
| scheduling fields | 优先级、调度类、运行时间统计 |
| resource refs | 地址空间、文件表、信号、权限等引用 |

单线程进程、同一进程内的多个线程，在 Linux 里都会体现为 task。用户态按资源共享关系把它们称为进程或线程；调度器按 task 排队和切换。

## 1.9 协程：用户态 runtime 的执行单元

协程由用户态 runtime 管理。内核通常只看到承载协程的线程 task。

| 模型 | 内核看到什么 | runtime 管什么 |
| --- | --- | --- |
| 单线程事件循环 | 一个 task | 多个 coroutine / callback |
| Go 程序 | 多个内核线程 task | 大量 goroutine |
| 用户态线程库 | 少量内核线程 | 多个用户态执行单元 |

协程切换通常不需要进入内核，成本低。协程遇到 I/O 时，runtime 通常依赖非阻塞 fd、`epoll`、`io_uring` 等机制，把等待 I/O 的协程挂起，再调度其他协程。

边界：内核调度的是承载协程的线程。某个协程执行阻塞 syscall 时，如果 runtime 没有处理，承载线程会一起阻塞。

## 1.10 用户态、内核态、系统调用

用户态运行普通程序。内核态运行内核代码，拥有更高权限，可以管理页表、调度 CPU、访问设备、维护文件系统和网络栈。

进入内核的三类入口：

| 入口 | 来源 | 例子 | 和当前 task 的关系 |
| --- | --- | --- | --- |
| syscall | 用户程序主动请求 | `read()`、`write()`、`mmap()`、`clone()` | 当前 task 主动进入内核 |
| exception | 当前指令触发异常 | page fault、divide error、invalid opcode | 通常需要处理当前 task 的上下文 |
| interrupt | 外部事件触发 | timer、网卡收包、磁盘完成中断 | 当前 CPU 被打断，事件不一定属于当前 task |

系统调用的参数来自用户态，内核不能直接信任。用户指针需要通过 `copy_from_user()` / `copy_to_user()` 这类接口访问，fd 需要从当前 task 的文件表里解析。

观察入口：

| 工具 | 用途 |
| --- | --- |
| `strace` | 看 syscall 名字、参数、返回值、错误码 |
| `perf trace` | 类似 syscall trace，也能接 perf 事件 |
| tracepoint | `syscalls:sys_enter_*`、`syscalls:sys_exit_*` |

## 1.11 地址空间：进程看到的内存布局

地址空间是进程看到的虚拟内存布局。程序里的指针是虚拟地址，CPU/MMU 借助页表把虚拟地址翻译成物理页。

一个典型进程的虚拟地址空间包括：

| 区域 | 内容 |
| --- | --- |
| text | 程序代码 |
| rodata | 只读数据 |
| data/bss | 全局变量、静态变量 |
| heap | `malloc()` 等动态分配区域 |
| mmap 区域 | 共享库、文件映射、匿名映射 |
| stack | 用户栈 |

Linux 对应：

```text
mm_struct
  -> vm_area_struct: text
  -> vm_area_struct: heap
  -> vm_area_struct: shared library
  -> vm_area_struct: stack
  -> page table
```

观察入口：

| 路径 | 说明 |
| --- | --- |
| `/proc/<pid>/maps` | 每段 VMA 的地址范围、权限、文件来源 |
| `/proc/<pid>/smaps` | RSS、PSS、匿名页、文件页等细节 |
| `/proc/<pid>/statm` | 进程内存概览 |

详细的 VMA、page fault、COW、mmap 放到第 5 章。

## 1.12 文件描述符：进程局部的整数 handle

fd 是进程局部的整数，用来引用内核里的打开文件对象。普通文件、pipe、socket、eventfd、timerfd、epoll 实例都可以通过 fd 暴露给用户态。

对象链：

```text
fd
  -> files_struct
  -> fdtable
  -> struct file
  -> file_operations
  -> inode / socket / pipe / eventfd ...
```

`fd = 3` 在不同进程里可以指向完全不同的对象。真正记录打开状态的是 `struct file`，包括 offset、flags、引用计数、操作表等。

观察入口：

| 路径 | 说明 |
| --- | --- |
| `/proc/<pid>/fd` | fd 指向的对象 |
| `/proc/<pid>/fdinfo/<fd>` | offset、flags、部分对象的额外信息 |
| `lsof -p <pid>` | 按进程列出打开对象 |

详细的 fd、VFS、inode、page cache 放到第 2 章和第 7 章。

## 1.13 上下文切换、阻塞、唤醒

上下文切换是 CPU 从一个 task 切到另一个 task。进入内核态是同一个 task 进入内核执行路径。

| 动作 | 含义 |
| --- | --- |
| syscall / exception | 当前 task 从用户态进入内核态 |
| context switch | CPU 从 task A 切到 task B |

上下文切换通常发生在：

| 场景 | 说明 |
| --- | --- |
| 时间片用完 | 当前 task 被放回 runnable 集合 |
| 等待 I/O | 当前 task 进入 sleep，等待设备或文件系统事件 |
| 等待锁 | 当前 task 进入等待队列 |
| 高优先级 task 唤醒 | 触发抢占或后续调度 |
| 主动让出 | `sched_yield()`、sleep 等 |

阻塞和唤醒的最小状态线：

```text
RUNNING -> SLEEPING/BLOCKED -> RUNNABLE -> RUNNING
```

Linux 里会落实到 task state、wait queue、`schedule()`、`try_to_wake_up()`、runqueue。

观察入口：

| 命令 | 说明 |
| --- | --- |
| `vmstat 1` | `r` 看 runnable，`b` 看不可中断等待，`cs` 看上下文切换 |
| `pidstat -w 1` | 按进程看上下文切换 |
| `perf sched record -- sleep 3` | 记录调度事件 |
| `perf sched latency` | 看调度延迟 |
| `bpftrace -e 'tracepoint:sched:sched_switch { @[comm] = count(); }'` | 统计调度切换 |

## 1.14 调度时机和调度原则

调度本身放到第 4 章细写。这里先记最基础的调度触发条件和评价指标。

常见调度时机：

| 状态变化 | 说明 |
| --- | --- |
| ready -> running | 调度器从可运行集合里选一个 task 上 CPU |
| running -> blocked | 当前 task 等 I/O、锁、事件，让出 CPU |
| running -> exit | 当前 task 结束，CPU 需要给别的 task |
| running -> ready | 时间片用完或被抢占 |
| blocked -> ready | 等待事件完成，task 被唤醒 |

抢占式和非抢占式的边界：

| 类型 | 记录 |
| --- | --- |
| 非抢占式 | task 一直运行到主动阻塞或退出，调度器再选择下一个 |
| 抢占式 | task 运行中也可能因为时间片、优先级、唤醒事件等被打断 |

调度原则可以压缩成五个指标：

| 指标 | 关注点 |
| --- | --- |
| CPU 利用率 | CPU 尽量不要空闲 |
| 吞吐量 | 单位时间完成的任务数量 |
| 周转时间 | 从提交到完成的总时间 |
| 等待时间 | 在 ready 队列里等待 CPU 的时间 |
| 响应时间 | 用户提交请求到第一次响应的时间 |

Linux 里这些指标不会直接变成一个简单算法。调度器还要处理多核、NUMA、实时任务、cgroup、CPU affinity、负载均衡、唤醒延迟等问题。第 4 章再把教材算法和 Linux CFS/EEVDF 分开记。

## 1.15 压缩表

| 抽象 | OS 侧含义 | Linux 对应物 | 观察入口 |
| --- | --- | --- | --- |
| 进程 | 运行中的程序和资源边界 | 一个或多个 task 加资源引用 | `ps`、`/proc/<pid>/status` |
| 线程 | 同一进程内的执行流 | 共享资源的一组 task | `ps -eLf`、`/proc/<pid>/task` |
| task | 内核可调度实体 | `task_struct` | `sched_switch`、`/proc/<pid>/task` |
| 地址空间 | 进程看到的虚拟内存布局 | `mm_struct`、VMA、页表 | `/proc/<pid>/maps` |
| fd | 进程局部 handle | `files_struct`、fdtable、`struct file` | `/proc/<pid>/fd` |
| syscall | 用户态请求内核服务 | syscall entry、syscall table | `strace` |
| exception | 当前指令触发的异常 | page fault 等异常入口 | fault tracepoint、perf |
| interrupt | 外部异步事件 | IRQ、softirq | `/proc/interrupts` |
| context switch | CPU 切换 task | `schedule()`、runqueue | `vmstat`、`perf sched` |
| 阻塞 / 唤醒 | 等事件、回到可运行 | wait queue、`try_to_wake_up()` | `ps STAT`、sched tracepoint |

## 本章检查点与参考回答

| 问题 | 参考回答 |
| --- | --- |
| 程序和进程怎么区分？ | 程序是磁盘上的静态代码和数据；进程是程序运行后的实体，包含执行状态、地址空间、打开文件、权限、信号和调度状态。 |
| 进程和线程怎么区分？ | 进程是资源边界，通常有独立地址空间；线程是同一进程内的执行流，通常共享地址空间、文件表等资源。Linux 里二者都落到 task，只是共享资源不同。 |
| PCB 和 `task_struct` 是什么关系？ | PCB 是教材里的进程控制块概念；Linux 用 `task_struct` 作为核心任务描述结构，并通过指针引用地址空间、文件表、信号、权限、调度信息等对象。 |
| 进程控制包括哪些动作？ | 创建、终止、阻塞、唤醒。Linux 里创建主要看 `fork()` / `clone()` 和 `execve()`，终止和回收看 `exit()` / `wait()`，阻塞和唤醒看 wait queue、`schedule()`、`try_to_wake_up()`。 |
| `R`、`S`、`D`、`Z` 怎么理解？ | `R` 表示正在运行或可运行；`S` 表示可中断睡眠；`D` 表示不可中断睡眠，常见于某些 I/O 等待；`Z` 表示僵尸进程，已经退出但父进程尚未回收。 |
| 用户态进入内核态和上下文切换有什么区别？ | 用户态进入内核态是同一个 task 进入内核代码路径，例如 syscall 或 page fault；上下文切换是 CPU 从 task A 切到 task B。 |
| syscall、exception、interrupt 怎么区分？ | syscall 是用户程序主动请求内核；exception 是当前指令触发的异常，例如 page fault；interrupt 是外部设备或定时器触发的异步事件。 |
| fd、fdtable、`struct file` 怎么分层？ | fd 是进程局部整数；fdtable 把整数映射到 `struct file`；`struct file` 表示一次打开对象，记录 offset、flags、操作表和底层文件、socket、pipe 等对象。 |
| 协程和线程的边界在哪里？ | 线程是内核可见、可调度的 task；协程由用户态 runtime 调度，内核通常只看到承载协程的线程。协程 I/O 通常依赖非阻塞 fd、`epoll` 或 `io_uring`。 |

## 本章参考

- 小林 Code《图解系统》4.1 进程、线程基础知识
- [小林 Code：进程、线程基础知识](https://xiaolincoding.com/os/4_process/process_base.html)
- [小林 Code：为什么要有虚拟内存？](https://xiaolincoding.com/os/3_memory/vmem.html)
- [Operating Systems: Three Easy Pieces](https://pages.cs.wisc.edu/~remzi/OSTEP/)
- [Linux Kernel Documentation](https://docs.kernel.org/)
- Michael Kerrisk, *The Linux Programming Interface*
- Robert Love, *Linux Kernel Development*
