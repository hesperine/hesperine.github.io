---
title: Linux 内核学习路线：从 OS 抽象到真实机制
date: 2026-07-07 17:00:00 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, Operating System, OSTEP, BPF]
---

这组笔记按小林 Code《图解系统》的系统方向目录推进。正文采用阅读批注写法：先整理基础概念、图解脉络和八股问法，再补 OSTEP 的抽象模型、Linux 的真实对象、源码路径和观测入口。

单篇文章不强制覆盖一个完整章节。一个小林 Code 章节可以拆成多篇笔记：基础问题一篇，OSTEP 对照一篇，Linux 实现路径一篇，源码或实验再单独成篇。

## 写法

每篇笔记从小林 Code 的问题顺序出发，再按需要追加两层批注。

| 层次 | 作用 | 写进笔记里的形式 |
| --- | --- | --- |
| 小林 Code / 八股 | 确定章节顺序、基础概念、常见问法 | 问题索引、术语表、参考回答 |
| OSTEP / 教材 | 补 OS 抽象、机制边界、算法模型 | 模型对照、状态转换、机制/策略区分 |
| Linux 实现 | 落到真实结构体、函数路径和观察入口 | Linux 对象、源码入口、`/proc`、tracepoint、实验命令 |

每篇笔记至少回答三个问题：

| 问题 | 说明 |
| --- | --- |
| 小林 Code 在讲什么？ | 这一节的基础问题和八股入口是什么 |
| OS 教材里对应什么抽象？ | 进程、地址空间、调度、文件、I/O、同步等模型怎么解释 |
| Linux 里落到什么对象？ | 结构体、函数、状态、tracepoint、命令入口是什么 |

## 总体顺序

整体章节安排按小林 Code《图解系统》系统方向目录走。前九个模块是主线，Linux 内核专项内容放在主线之后。

| 顺序 | 小林 Code 主线 | 本系列写法 | 当前入口 / 后续拆分 |
| --- | --- | --- | --- |
| 0 | 阅读准备 | 环境、观测工具、如何读 Linux 机器状态 | [环境与观察工具](/posts/linux-kernel-chapter-0-observation-tools/) |
| 1 | 硬件结构 | CPU 执行、存储层次、Cache、中断的 OS 背景 | [硬件结构阅读批注](/posts/linux-kernel-hardware-structure/) |
| 2 | 操作系统结构 | 内核、系统调用、Linux/Windows 内核结构对照 | [操作系统结构阅读批注](/posts/linux-kernel-os-structure/) |
| 3 | 内存管理 | 虚拟内存、分段、分页、多级页表、TLB、Linux 内存管理 | [内存管理阅读批注](/posts/linux-kernel-memory-management/)、[虚拟内存、VMA 与 page fault](/posts/linux-kernel-chapter-5-virtual-memory/)、[物理内存管理](/posts/linux-kernel-chapter-6-physical-memory/) |
| 4 | 进程与线程 | 进程状态、PCB、上下文切换、线程、IPC、同步、死锁 | [进程与线程阅读批注](/posts/linux-kernel-process-thread/)、[进程模型与 task 生命周期](/posts/linux-kernel-chapter-3-process-model/)、[同步、futex 与 RCU](/posts/linux-kernel-chapter-8-synchronization-futex-rcu/) |
| 5 | 调度算法 | 进程调度、页面置换、磁盘调度；Linux 调度器放在批注里 | [调度算法阅读批注](/posts/linux-kernel-scheduling-algorithms/)、[调度器、runqueue 与唤醒路径](/posts/linux-kernel-chapter-4-scheduler/) |
| 6 | 文件系统 | VFS、fd、inode、目录项、page cache、文件 I/O | [文件系统阅读批注](/posts/linux-kernel-filesystem/)、[文件系统、VFS 与 page cache](/posts/linux-kernel-chapter-7-filesystem-vfs/)、[read 路径](/posts/linux-kernel-chapter-2-read-path/) |
| 7 | 设备管理 | 设备控制器、驱动、中断、块层、I/O 软件分层 | [设备管理阅读批注](/posts/linux-kernel-device-management/)、[设备管理、中断与 deferred work](/posts/linux-kernel-chapter-9-device-interrupts/) |
| 8 | 网络系统 | Linux 收发包、socket、I/O 多路复用、Reactor/Proactor | [网络系统阅读批注](/posts/linux-kernel-network-system/)、[网络系统、socket 与收发包路径](/posts/linux-kernel-chapter-10-network-stack/) |
| 9 | Linux 命令 | 系统、进程、内存、文件、网络观测命令 | [Linux 命令阅读批注](/posts/linux-kernel-commands/)、[环境与观察工具](/posts/linux-kernel-chapter-0-observation-tools/) |
| 10 | 额外 Linux 内核专题 | namespace/cgroup、tracing/perf/BPF、内核源码开发、横切路径实验 | [额外专题总览](/posts/linux-kernel-extra-topics/)、[namespace/cgroup](/posts/linux-kernel-chapter-11-namespace-cgroup/)、[tracing/perf/BPF](/posts/linux-kernel-chapter-12-tracing-bpf/)、[内核开发方法](/posts/linux-kernel-chapter-13-kernel-development/) |

现有入口文章后续会按这个顺序重排和拆分。当前文件名里的编号仅用于链接兼容。

## 章节拆分原则

小林 Code 的每个大章节可以拆成几类笔记。

| 类型 | 内容 | 例子 |
| --- | --- | --- |
| 基础笔记 | 按小林 Code 的问题顺序整理概念和八股 | 进程是什么、线程是什么、PCB 是什么 |
| 模型批注 | 对照 OSTEP 或教材模型，补机制边界 | ready/running/blocked、机制与策略、调度指标 |
| Linux 批注 | 补 Linux 对象、源码路径、命令入口 | `task_struct`、`mm_struct`、VFS、runqueue |
| 路径笔记 | 用一条真实路径串对象 | `read()`、`fork()`、page fault、收包路径 |
| 实验笔记 | 用命令、trace、最小代码验证 | `strace`、`perf sched`、`bpftrace`、`/proc` |

正文里不要把所有内容都堆进同一篇。基础问题讲清楚后，Linux 实现和源码路径可以独立成篇。

## 各章批注重点

## 0. 阅读准备：环境与观察工具

小林 Code 后面很多章节会用到 Linux 命令和现象观察。这里先记录一组最小工具。

| 方向 | 入口 |
| --- | --- |
| 系统信息 | `uname -a`、`/etc/os-release`、内核配置 |
| 进程线程 | `ps`、`top -H`、`/proc/<pid>/status`、`/proc/<pid>/task` |
| 地址空间 | `/proc/<pid>/maps`、`smaps` |
| 文件描述符 | `/proc/<pid>/fd`、`fdinfo`、`lsof` |
| 系统调用 | `strace`、`perf trace` |
| 调度 | `vmstat`、`pidstat -w`、`perf sched` |
| 内核事件 | ftrace、tracefs、`bpftrace` |

## 1. 硬件结构

这一部分作为 OS/Linux 的硬件背景，不单独追求硬件细节大全。

| 小林 Code 主题 | 本系列批注 |
| --- | --- |
| CPU 如何执行程序 | 指令执行、寄存器、程序计数器、上下文保存 |
| 存储器层次结构 | 寄存器、Cache、内存、SSD/HDD 与 OS 缓存 |
| CPU Cache | cache line、局部性、伪共享、同步原语成本 |
| CPU 如何选择线程 | 从硬件执行切到 OS 调度入口 |
| 软中断 | 中断、软中断、网络收包和 deferred work |

Linux 落点：`/proc/interrupts`、softirq、NAPI、调度中断、Cache 对锁和调度的影响。

## 2. 操作系统结构

小林 Code 这里主要讲内核、Linux 内核特征、Windows 内核对照。批注重点放在 Linux 内核的边界。

| 问题 | Linux 批注 |
| --- | --- |
| 内核是什么 | 管理 CPU、内存、文件系统、设备、网络和安全边界 |
| syscall 是什么 | 用户态进入内核态的正式入口 |
| Linux 内核有什么特点 | 多任务、SMP、ELF、宏内核、模块化 |
| 用户态/内核态怎么分 | 权限级别、地址空间隔离、入口路径 |

后续 `read()`、`fork()`、page fault、网络收包都从这里的边界展开。

## 3. 内存管理

按小林 Code 的顺序：虚拟内存、内存分段、内存分页、多级页表、TLB、段页式内存管理、Linux 内存管理。

| 小林 Code 主题 | Linux 批注 |
| --- | --- |
| 为什么要有虚拟内存 | 进程地址空间、隔离、权限、按需分配 |
| 内存分段 | 历史模型；现代 Linux 主要依赖分页 |
| 内存分页 | page table、PTE、page frame |
| 多级页表 | 节省页表内存，配合硬件页表遍历 |
| TLB | 地址翻译缓存、TLB shootdown |
| Linux 内存管理 | `mm_struct`、VMA、page fault、COW、page cache |

额外补：`mmap` 区域、匿名页/文件页、RSS/PSS、buddy/slub、reclaim、OOM。

## 4. 进程与线程

这一章是整个系列的核心基础。按小林 Code 的顺序拆。

| 小林 Code 主题 | Linux 批注 |
| --- | --- |
| 进程 | 程序运行实例、资源边界、`task_struct` |
| 进程状态 | ready/running/blocked 到 Linux `R/S/D/T/Z` |
| 进程控制结构 | PCB 到 `task_struct`、`mm_struct`、`files_struct` |
| 进程控制 | `fork()`、`clone()`、`execve()`、`exit()`、`wait()` |
| 上下文切换 | `schedule()`、runqueue、线程/进程切换成本 |
| 线程 | Linux 线程也是 task；pid/tgid、`clone()` flags |
| IPC | pipe、message queue、shared memory、signal、socket |
| 多线程同步 | mutex、semaphore、condition variable、futex、RCU |
| 死锁 | 四个条件、排查、锁顺序 |

额外补：Linux task 生命周期、等待队列、信号、线程组、调度类。

## 5. 调度算法

小林 Code 会集中讲进程调度、页面置换、磁盘调度。这里不把教材算法当术语堆砌，而是先讲清楚适用问题。

| 小林 Code 主题 | Linux 批注 |
| --- | --- |
| FCFS/SJF/HRRN/RR/优先级/多级反馈队列 | 教材调度算法的目标和代价 |
| 页面置换算法 | FIFO、LRU、Clock、LFU 与 Linux reclaim 的关系 |
| 磁盘调度算法 | 机械磁盘模型、块层、电梯调度的历史背景 |
| Linux 调度器 | CFS/EEVDF、实时调度、runqueue、wakeup latency |

调度模块会拆成两类：教材算法笔记和 Linux 调度器笔记。

## 6. 文件系统

按小林 Code 的顺序：文件系统基本组成、VFS、文件使用、文件存储、文件系统结构、文件 I/O。

| 小林 Code 主题 | Linux 批注 |
| --- | --- |
| 文件系统基本组成 | inode、目录项、超级块、数据块 |
| 虚拟文件系统 | VFS、`struct file`、dentry、inode、`file_operations` |
| 文件使用 | `open()`、fd、`read()`、`write()`、`close()` |
| 文件存储 | 连续/链式/索引分配，Ext 系列实现背景 |
| 文件系统结构 | 挂载、块组、元数据、日志 |
| 文件 I/O | buffered/direct、blocking/nonblocking、sync/async、page cache |

额外补：`fork()` 后 fd 继承、file offset 共享、page cache、writeback。

## 7. 设备管理

小林 Code 从“键盘敲入 A 字母发生了什么”切入。这个模块按一次设备事件展开。

| 小林 Code 主题 | Linux 批注 |
| --- | --- |
| 设备控制器 | MMIO/PIO、寄存器、DMA |
| 设备驱动程序 | driver model、字符设备、块设备 |
| I/O 软件分层 | VFS、block layer、request queue |
| 中断处理 | IRQ、softirq、tasklet、workqueue |

额外补：中断上下文不能随便睡眠，deferred work 为什么存在。

## 8. 网络系统

小林 Code 的网络系统部分适合直接作为网络栈笔记主线。

| 小林 Code 主题 | Linux 批注 |
| --- | --- |
| Linux 如何收发网络包 | NIC、DMA、IRQ、NAPI、`sk_buff`、协议栈 |
| 文件传输性能 | page cache、零拷贝、`sendfile()`、`splice()` |
| I/O 多路复用 | select/poll/epoll、wait queue、ready list |
| Reactor/Proactor | 事件循环模型、同步/异步 I/O 边界 |
| 网络性能指标 | `ss`、`ip`、`sar`、`tcpdump`、BPF |

额外补：XDP、tc BPF、netfilter、qdisc。

## 9. Linux 命令

命令部分不单独做成工具清单，而是给每个模块配观察入口。

| 模块 | 命令入口 |
| --- | --- |
| 进程线程 | `ps`、`top`、`pidstat`、`/proc/<pid>` |
| 内存 | `free`、`vmstat`、`/proc/meminfo`、`/proc/<pid>/smaps` |
| 文件系统 | `ls -li`、`stat`、`lsof`、`df`、`mount` |
| I/O | `iostat`、`pidstat -d`、`blktrace` |
| 网络 | `ss`、`ip`、`tcpdump`、`sar -n` |
| 内核事件 | `perf`、ftrace、`bpftrace` |

## 10. 额外 Linux 内核专题

这些内容作为扩展专题放在最后。

| 专题 | 内容 |
| --- | --- |
| `read()` 横切路径 | syscall、fd、VFS、用户地址、page cache、wait queue、调度 |
| namespace / cgroup | 容器的隔离和资源控制机制 |
| tracing / perf / BPF | tracepoint、kprobe、uprobe、BPF map、verifier、BTF、CO-RE |
| Linux 内核源码阅读 | 源码树、Kconfig、module、QEMU、oops/panic、patch workflow |
| 最小实验 | 用小代码或命令验证进程、调度、内存、文件、网络路径 |

## 参考资料

- 小林 Code《图解系统》
- [Operating Systems: Three Easy Pieces](https://pages.cs.wisc.edu/~remzi/OSTEP/)
- [Linux Kernel Documentation](https://docs.kernel.org/)
- [Linux Kernel Labs](https://linux-kernel-labs.github.io/refs/heads/master/)
- Michael Kerrisk, *The Linux Programming Interface*
- Robert Love, *Linux Kernel Development*
- Brendan Gregg, *Systems Performance*
- W. Richard Stevens, Stephen A. Rago, *Advanced Programming in the UNIX Environment*
- Randal E. Bryant, David R. O'Hallaron, *Computer Systems: A Programmer's Perspective*
