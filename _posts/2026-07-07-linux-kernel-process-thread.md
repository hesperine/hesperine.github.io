---
title: Linux 内核学习笔记：进程与线程阅读批注
date: 2026-07-07 17:35:00 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, Operating System, Process, Thread]
---

这一篇按小林 Code《图解系统》第四章“进程与线程”的顺序记：进程基础、线程、调度入口、进程间通信、多线程同步、死锁、锁类型。第四章内容很宽，本文先做主线批注；Linux 细节集中落到 `task_struct`、地址空间、文件表、调度状态、IPC 对象、futex 和等待队列。

## 问题索引

| 小林 Code 主题 | 本篇记录 |
| --- | --- |
| 进程 | 程序运行实例、地址空间、资源边界 |
| 进程状态 | 创建、就绪、运行、阻塞、结束、挂起；Linux `R/S/D/T/Z` |
| PCB | 教材 PCB 到 Linux `task_struct` |
| 进程控制 | 创建、终止、阻塞、唤醒；`fork()`、`clone()`、`execve()`、`exit()`、`wait()` |
| 上下文切换 | CPU 上下文、地址空间切换、内核栈、调度器 |
| 线程 | 共享进程资源的执行流；Linux 里对应 task 和线程组 |
| 调度入口 | 调度时机、调度原则、调度算法放到下一章细讲 |
| IPC | pipe、message queue、shared memory、semaphore、signal、socket |
| 多线程同步 | 竞争、互斥、同步、锁、信号量、futex |
| 死锁和锁类型 | 四个必要条件、排查入口、互斥锁/自旋锁/读写锁/乐观锁 |

## 1. 进程：程序的一次运行实例

进程是程序运行时形成的执行实体和资源容器。可执行文件在磁盘上只是静态文件；运行后，内核为它建立地址空间、打开文件表、凭据、信号状态、调度状态等运行时对象。

| 名词 | 记录 |
| --- | --- |
| program | 静态程序文件或代码集合 |
| process | 程序的一次运行实例，拥有地址空间和一组资源 |
| address space | 进程可见的虚拟地址范围 |
| resource boundary | 内存、文件描述符、权限、namespace、cgroup 等资源归属边界 |
| execution context | CPU 寄存器、栈、程序计数器等执行状态 |

OSTEP 的进程抽象可以压缩成两点：进程让程序看起来独占 CPU，地址空间让程序看起来独占一段连续内存。OS 通过调度和地址翻译实现这两个抽象。

Linux 批注：

| Linux 对象 | 作用 |
| --- | --- |
| `task_struct` | Linux 可调度实体和资源引用集合 |
| `mm_struct` | 用户态地址空间 |
| `files_struct` | 文件描述符表 |
| `fs_struct` | 当前目录、根目录、umask 等文件系统上下文 |
| `cred` | uid、gid、capability 等权限信息 |
| `nsproxy` | namespace 引用 |

进程主题里抓 `task_struct` 是为了定位创建、运行、阻塞、唤醒、退出这些动作。内存管理、文件系统、网络栈有各自的核心对象。

## 2. 进程状态：教材模型和 Linux 状态

教材里的基本状态是运行、就绪、阻塞。扩展后还会加入创建、结束、挂起。它们描述的是进程和 CPU、事件、内存驻留之间的关系。

| 教材状态 | 含义 | Linux 观察 |
| --- | --- | --- |
| running | 正在 CPU 上执行 | `R` 中正在运行的 task |
| ready | 可运行，等待 CPU | `R` 中在 runqueue 等待的 task |
| blocked | 等待 I/O、锁、事件 | `S` 或 `D` |
| stopped | 被作业控制或调试暂停 | `T`、`t` |
| zombie | 已退出，等待父进程回收 | `Z` |

Linux 的 `ps STAT` 字段是观察入口，但它是用户态展示，不能和教材状态一一硬套。

| Linux 状态 | 常见含义 |
| --- | --- |
| `R` | runnable 或 running |
| `S` | interruptible sleep，可被信号唤醒 |
| `D` | uninterruptible sleep，常见于等待内核 I/O 路径 |
| `T` / `t` | stopped 或 tracing stop |
| `Z` | zombie |

观察入口：

| 命令 / 路径 | 记录 |
| --- | --- |
| `ps -o pid,ppid,stat,wchan,comm -p <pid>` | 看状态和等待点 |
| `/proc/<pid>/status` | 看 `State`、`Tgid`、`Pid`、`Threads` |
| `/proc/<pid>/wchan` | 看睡眠时等待的内核符号 |
| `perf sched latency` | 看 runnable 后等待 CPU 的延迟 |

## 3. PCB 到 task_struct

教材用 PCB 描述进程控制块。PCB 保存进程标识、状态、寄存器上下文、调度信息、内存信息、打开文件、父子关系等。Linux 中主要落到 `task_struct`，再由它引用其他子系统对象。

| PCB 信息 | Linux 落点 |
| --- | --- |
| 进程标识 | pid、tgid、thread group |
| 进程状态 | `task_struct` 的 state / exit_state |
| CPU 上下文 | 架构相关 thread context、内核栈 |
| 调度信息 | priority、policy、sched entity、runqueue |
| 内存信息 | `mm_struct`、页表、VMA |
| 文件信息 | `files_struct`、fdtable、`struct file` |
| 父子关系 | parent、children、sibling |
| 信号 | signal、sighand、blocked、pending |

`task_struct` 适合按“执行状态 + 资源引用 + 关系 + 调度字段”四组记。源码入口是 `include/linux/sched.h`，但这个结构体很大，阅读时需要带着路径问题看字段。

## 4. 进程控制：创建、替换、退出、回收

进程控制在教材里通常包含创建、终止、阻塞、唤醒。Linux 里常见路径可以按 syscall 记。

| 动作 | 用户态接口 | Linux 主线 |
| --- | --- | --- |
| 创建进程 | `fork()` | 创建新 task，父子资源隔离较强，地址空间使用 COW |
| 创建线程 / 特定共享关系 | `clone()` / `clone3()` | 通过 flags 控制共享 `mm_struct`、`files_struct` 等 |
| 替换程序映像 | `execve()` | 当前 task 装载新 ELF，重建用户地址空间 |
| 退出 | `exit()` / `exit_group()` | 释放资源，留下退出状态 |
| 回收 | `wait()` / `waitpid()` / `wait4()` | 父进程读取退出状态，释放 zombie 记录 |

`fork()` 后父子进程逻辑上拥有独立地址空间，物理页常通过 COW 延迟复制。打开文件描述符会继承；父子 fd 可能指向同一个 `struct file`，因此共享文件偏移。

`execve()` 改的是当前 task 的用户态程序映像。pid 继续沿用，地址空间、用户栈、代码段、数据段会换成新程序；带 `FD_CLOEXEC` 的 fd 在 exec 时关闭。

`exit()` 后出现 zombie，是因为父进程还没有读取退出状态。zombie 的主要运行资源已经释放，保留 pid、退出码、统计信息等回收所需内容。

源码入口：

| 路径 | 内容 |
| --- | --- |
| `kernel/fork.c` | fork/clone 和 task 创建 |
| `fs/exec.c` | execve 和 ELF 装载 |
| `kernel/exit.c` | exit、wait、reparent |
| `kernel/signal.c` | signal 投递和处理 |

## 5. 上下文切换：CPU 状态和地址空间

上下文切换保存当前执行实体的必要状态，再恢复另一个执行实体的状态。CPU 上下文至少包括通用寄存器、栈指针、程序计数器、状态寄存器等。进程切换还可能涉及地址空间和 TLB。

| 类型 | 切换内容 |
| --- | --- |
| 进程上下文切换 | CPU 寄存器、内核栈、调度状态、地址空间、TLB 影响 |
| 同进程线程切换 | CPU 寄存器、栈、线程私有状态；通常共享地址空间 |
| 中断上下文切换 | 当前执行流被中断，CPU 进入中断处理路径 |

常见触发点：

| 场景 | 记录 |
| --- | --- |
| 时间片或调度周期 | 当前 task 让出 CPU |
| 主动睡眠 | `sleep()`、等待锁、等待 I/O、等待事件 |
| 唤醒抢占 | 更高优先级或更合适的 task 被唤醒 |
| 系统调用阻塞 | 进入内核后等待资源 |
| 中断 | CPU 转入中断处理，可能引发后续调度 |

Linux 入口：`schedule()`、`context_switch()`、`switch_to()`、`sched_switch` tracepoint。观察入口：`pidstat -w 1`、`vmstat 1`、`perf sched record`、`perf sched latency`。

## 6. 线程：共享资源的执行流

线程是进程内的一条执行流。多个线程共享同一进程的地址空间、代码段、数据段、打开文件等资源；每个线程有自己的寄存器、栈、线程局部状态和调度状态。

| 对象 | 同进程线程之间 |
| --- | --- |
| 地址空间 | 共享 |
| 全局变量 / 堆 | 共享 |
| 打开文件表 | 通常共享 |
| 当前工作目录等 fs 上下文 | 通常共享 |
| 寄存器 | 各自独立 |
| 用户栈 | 各自独立 |
| signal mask | 每线程独立 |

Linux 的线程是 task。一个多线程进程对应多个 `task_struct`，这些 task 共享 `mm_struct` 等资源，并处在同一个 thread group 中。

| 名词 | 记录 |
| --- | --- |
| pid | 单个 task 的标识 |
| tgid | thread group id，通常是用户态看到的进程 id |
| thread group | 同一进程内的一组 task |
| LWP | 轻量级进程，Linux 线程模型常用说法 |
| `CLONE_THREAD` | 创建同线程组 task 的关键 flag |

观察入口：

| 命令 / 路径 | 记录 |
| --- | --- |
| `ps -eLf` | 展开线程 |
| `top -H -p <pid>` | 看进程内线程 |
| `/proc/<pid>/task` | 线程目录 |
| `/proc/<pid>/status` | `Threads`、`Pid`、`Tgid` |

## 7. 调度入口：第四章只记接口

小林 Code 第四章已经引出调度时机、调度原则和调度算法。算法细节放到下一篇“调度算法”处理；本文只记进程/线程和调度器的接口。

| 问题 | 记录 |
| --- | --- |
| 谁被调度 | Linux 调度 task |
| 在哪里等待 CPU | 每 CPU runqueue |
| 什么状态能被调度 | runnable task |
| 阻塞后怎么回来 | 等待事件完成后 wakeup，重新进入 runnable |
| 调度策略在哪里体现 | scheduling class、priority、nice、policy |

进程/线程学习里需要记住的边界：阻塞等待事件和可运行但等待 CPU 是两种不同状态。前者在等 I/O、锁、条件；后者已经能运行，只是在 runqueue 上排队。

## 8. 进程间通信：六类入口

进程地址空间隔离后，需要 IPC 交换数据或事件。小林 Code 的顺序是管道、消息队列、共享内存、信号量、信号、Socket。

| IPC | 数据形态 | Linux 批注 |
| --- | --- | --- |
| pipe | 字节流 | 亲缘进程常见；匿名管道通过 fd 传递 |
| FIFO | 字节流 | 有路径名的管道 |
| message queue | 离散消息 | System V / POSIX 消息队列 |
| shared memory | 共享内存区域 | 数据不需要反复拷贝，必须配合同步 |
| semaphore | 计数和同步 | System V / POSIX semaphore；线程内也有信号量 |
| signal | 异步事件通知 | `kill()`、异常、终端事件等 |
| socket | 字节流或数据报 | 本机进程和跨机器通信都可用 |

Linux 里所有这些机制都能和“等待/唤醒”连起来。读空管道会睡眠，socket receive queue 没数据会睡眠，futex 等待锁会睡眠；事件到来后，内核唤醒等待队列上的 task。

## 9. 多线程同步：竞争、互斥、同步

多个线程共享地址空间，读写共享数据时会出现竞争。同步笔记先区分三个词。

| 名词 | 记录 |
| --- | --- |
| race condition | 执行结果依赖线程交错顺序 |
| mutual exclusion | 同一时刻只允许一个线程进入临界区 |
| synchronization | 按条件或顺序协调多个线程 |
| critical section | 访问共享资源的一段代码 |
| atomic operation | 不会被观察到中间状态的操作 |

Linux 批注：

| 用户态机制 | 内核落点 |
| --- | --- |
| pthread mutex | 无竞争时用户态 fast path；竞争时可进入 futex |
| condition variable | 配合 mutex；等待条件变化时睡眠和唤醒 |
| semaphore | 计数型同步 |
| rwlock | 读多写少场景 |
| futex | 用户态地址上的 fast userspace mutex，竞争时由内核挂等待队列 |

futex 是理解用户态锁和内核调度关系的关键点：锁状态放在用户态内存；抢锁失败时，线程通过 futex syscall 进入内核睡眠；解锁线程在需要时唤醒等待者。

## 10. 死锁：条件、排查、避免

死锁由多个执行流互相等待资源形成。经典四个必要条件需要直接记。

| 条件 | 含义 |
| --- | --- |
| 互斥 | 资源同一时刻只能被一个执行流持有 |
| 持有并等待 | 已持有资源时继续等待其他资源 |
| 不可剥夺 | 资源不能被外部强制抢走 |
| 环路等待 | 等待关系形成环 |

避免死锁常用方法是破坏环路等待：给锁规定全局顺序，所有线程按同一顺序加锁。还可以通过 try-lock、超时、锁粒度调整、减少持锁期间阻塞操作等方式降低风险。

排查入口：

| 工具 | 记录 |
| --- | --- |
| `pstack <pid>` | 快速看多线程调用栈 |
| `gdb -p <pid>` | 查看线程、栈、锁对象 |
| `info threads` | gdb 中列出线程 |
| `thread apply all bt` | 打印所有线程栈 |
| `perf lock` | 分析内核锁事件，依配置可用 |
| `/proc/<pid>/stack` | 看内核栈，权限和内核配置相关 |

用户态 pthread 死锁常用栈和锁 owner 定位；内核锁问题还需要结合 lockdep、ftrace、perf lock、hung task 日志。

## 11. 锁类型：成本和等待方式

小林 Code 第四章最后讲互斥锁、自旋锁、读写锁、乐观锁、悲观锁。这里按等待方式和适用条件整理。

| 锁 | 加锁失败后的行为 | 适合场景 |
| --- | --- | --- |
| mutex | 睡眠，等待唤醒 | 临界区可能较长，可以睡眠 |
| spinlock | 忙等，占 CPU | 临界区很短，不能睡眠的内核路径 |
| rwlock / rwsem | 区分读写 | 读多写少 |
| optimistic lock | 先操作或读取，再验证版本 | 冲突概率低，重试成本可接受 |
| pessimistic lock | 访问前先排他保护 | 冲突概率高或数据一致性要求强 |

Linux 内核里要特别区分能否睡眠。进程上下文通常可以睡眠；中断上下文不能随便睡眠。spinlock 保护的临界区里也不能调用可能睡眠的函数。

## 压缩表

| 概念 | 小林 Code / 八股 | OSTEP 模型 | Linux 落点 |
| --- | --- | --- | --- |
| 进程 | 程序运行实例 | CPU 和内存虚拟化的执行实体 | `task_struct`、`mm_struct`、`files_struct` |
| 线程 | 进程内执行流 | 共享地址空间的控制流 | task、thread group、pid/tgid |
| PCB | 进程控制块 | 保存状态和资源引用 | `task_struct` |
| 上下文切换 | 保存/恢复运行状态 | 受限直接执行和调度 | `schedule()`、`context_switch()` |
| IPC | 进程间通信方式 | 隔离后的通信机制 | pipe、shm、signal、socket、wait queue |
| 同步 | 互斥和协作 | 并发控制 | mutex、semaphore、futex、RCU |
| 死锁 | 四个必要条件 | 资源等待图 | lock order、pstack、gdb、lockdep |

## 检查点与参考回答

| 问题 | 参考回答 |
| --- | --- |
| 进程是什么？ | 进程是程序的一次运行实例，也是地址空间、文件描述符、权限、信号等资源的容器。Linux 中通常由一个或多个 task 组成。 |
| 线程是什么？ | 线程是进程内的一条执行流。同一进程内线程共享地址空间、全局数据和打开文件等资源，各自拥有寄存器、栈和调度状态。 |
| 进程和线程的区别是什么？ | 进程更强调资源边界，线程更强调执行流。同进程线程共享资源，所以创建和切换成本通常更低，但共享数据需要同步，一个线程的严重错误可能影响整个进程。 |
| PCB 在 Linux 中对应什么？ | 教材 PCB 在 Linux 中主要对应 `task_struct`，同时还要通过它引用 `mm_struct`、`files_struct`、signal、cred、namespace、cgroup 等对象。 |
| `fork()` 和 `execve()` 分别做什么？ | `fork()` 创建新进程，子进程继承父进程资源并通过 COW 延迟复制地址空间；`execve()` 在当前 task 上装载新程序映像，重建用户地址空间。 |
| 上下文切换切什么？ | 至少切 CPU 寄存器、栈指针、程序计数器等执行状态。进程切换还可能切地址空间和影响 TLB；同进程线程切换通常共享地址空间。 |
| 为什么同进程线程切换通常比进程切换便宜？ | 同进程线程共享 `mm_struct` 和页表，切换时通常不需要切换地址空间，TLB 影响较小，主要切换线程私有寄存器、栈和调度状态。 |
| IPC 有哪些常见方式？ | 管道、FIFO、消息队列、共享内存、信号量、信号、Socket。共享内存吞吐高，但需要额外同步。Socket 既能本机通信，也能跨机器通信。 |
| futex 解决什么问题？ | futex 让用户态锁在无竞争时不进入内核；竞争时线程通过 futex syscall 睡眠，解锁方按需唤醒等待者。 |
| 死锁的四个必要条件是什么？ | 互斥、持有并等待、不可剥夺、环路等待。破坏其中任一条件即可避免死锁，工程中常用全局锁顺序破坏环路等待。 |
| 互斥锁和自旋锁怎么选？ | 临界区可能较长或可以睡眠时用 mutex；临界区极短、不能睡眠的内核路径用 spinlock。自旋锁忙等会消耗 CPU。 |

## 本篇参考

- 小林 Code《图解系统》第四章：进程与线程
- Remzi H. Arpaci-Dusseau and Andrea C. Arpaci-Dusseau, *Operating Systems: Three Easy Pieces*
- Michael Kerrisk, *The Linux Programming Interface*
- W. Richard Stevens, Stephen A. Rago, *Advanced Programming in the UNIX Environment*
- Robert Love, *Linux Kernel Development*
- Linux Kernel Documentation: Scheduler, locking, futex, core API
