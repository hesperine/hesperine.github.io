---
title: Linux 内核学习笔记：操作系统结构阅读批注
date: 2026-07-07 17:15:00 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, Operating System, System Call, ELF]
---

这一篇按小林 Code《图解系统》第二章“操作系统结构”做阅读批注。原章节的主线是 Linux 内核和 Windows 内核对照；这组 Linux 笔记只保留和后续内核学习直接相关的部分：内核能力、用户态/内核态、系统调用、Linux 的多任务/SMP/ELF/宏内核设计。

## 问题索引

| 小林 Code 主题 | 本篇记录 |
| --- | --- |
| 内核是什么 | 内核作为应用和硬件之间的管理层 |
| 内核有哪些能力 | 进程调度、内存管理、硬件通信、系统调用 |
| 内核怎么工作 | 用户空间、内核空间、用户态、内核态 |
| Linux 的设计 | MultiTask、SMP、ELF、Monolithic Kernel |
| Windows 设计 | NT、混合内核、PE 文件格式 |
| 内核架构类型 | 宏内核、微内核、混合内核 |

## 1. 内核：应用和硬件之间的管理层

应用程序不直接管理 CPU、内存、磁盘、网卡、键盘等硬件。内核负责把硬件能力包装成稳定接口，并负责隔离、调度、权限和错误处理。

可以先用这张表记内核能力：

| 能力 | 基础解释 | Linux 落点 |
| --- | --- | --- |
| 进程和线程管理 | 决定哪个执行流使用 CPU | `task_struct`、调度器、runqueue |
| 内存管理 | 分配、回收、隔离虚拟地址空间 | `mm_struct`、VMA、页表、page fault |
| 文件系统 | 把持久化数据组织成文件和目录 | VFS、dentry、inode、page cache |
| 设备管理 | 让进程通过统一接口访问硬件 | driver model、IRQ、DMA、`/sys` |
| 网络栈 | 管理 socket、协议栈、收发包 | `sk_buff`、NAPI、TCP/IP、qdisc |
| 系统调用 | 给用户态程序提供受控入口 | syscall table、syscall ABI、`copy_to_user()` |

这张表就是后续 Linux 笔记的骨架。每一个能力都会落到具体结构体、状态转换和源码路径。

## 2. 用户空间、内核空间、用户态、内核态

现代 OS 会把执行权限和地址空间分层。应用程序运行在用户态，内核运行在内核态。

| 名词 | 记录 |
| --- | --- |
| 用户空间 | 普通进程使用的虚拟地址空间区域 |
| 内核空间 | 内核代码和内核数据所在区域 |
| 用户态 | CPU 低权限级别，普通程序在这里执行 |
| 内核态 | CPU 高权限级别，内核可以访问核心资源和硬件 |

用户态程序不能随意访问硬件、改页表、关中断、读写任意内存。需要内核服务时，通过系统调用进入内核。

系统调用的最小路径：

```text
用户态程序
  -> libc 包装函数
  -> syscall 指令 / trap
  -> syscall entry
  -> 内核检查参数和权限
  -> 执行内核服务
  -> 返回用户态
```

Linux 批注：

| 问题 | Linux 入口 |
| --- | --- |
| syscall 从哪里进 | `arch/x86/entry/` |
| syscall 怎么分发 | syscall number、syscall table |
| 用户指针怎么访问 | `copy_from_user()`、`copy_to_user()` |
| 当前进程是谁 | `current`、`task_struct` |
| 参数错了怎么办 | `errno`、信号、失败返回 |

`read()`、`write()`、`mmap()`、`clone()`、`execve()`、`ioctl()` 都属于这条边界。

## 3. 系统调用、异常、中断

小林 Code 在这一章用“中断”描述用户程序进入内核的过程。内核学习里需要把三类入口分开记。

| 入口 | 来源 | 例子 | 和当前 task 的关系 |
| --- | --- | --- | --- |
| 系统调用 | 用户程序主动请求内核 | `read()`、`mmap()`、`clone()` | 当前 task 主动进入内核 |
| 异常 | 当前指令执行出问题或需要内核介入 | page fault、除零、非法指令 | 通常处理当前 task 的上下文 |
| 中断 | 外部硬件或定时器事件 | 网卡收包、磁盘完成、timer | 不一定属于当前 task |

这一区分会影响能不能睡眠。

| 上下文 | 能否睡眠 | 说明 |
| --- | --- | --- |
| 进程上下文 | 通常可以 | 内核代码代表某个 task 执行，可以被调度走再恢复 |
| 中断上下文 | 不能随便睡眠 | 没有普通进程上下文，路径要短，常把工作推给 softirq/workqueue |

后续设备管理、网络系统、BPF tracing 都会用到这个边界。

## 4. Linux 设计点：MultiTask

MultiTask 表示多任务。单核上多个任务交替运行，形成并发；多核上多个任务可以同时运行，形成并行。

| 概念 | 记录 |
| --- | --- |
| 并发 | 一段时间内多个任务都在推进，单核也可以做到 |
| 并行 | 同一时刻多个任务真的在不同 CPU 上执行 |
| 时间片 | 调度器给普通任务分配 CPU 时间的一种模型 |
| 抢占 | 当前任务运行中也可能被调度器换下 |

Linux 落点：

| 对象 | 作用 |
| --- | --- |
| `task_struct` | 调度和管理的执行实体 |
| runqueue | 每个 CPU 上的可运行任务集合 |
| scheduling class | 不同任务类型的调度策略 |
| `schedule()` | 调度入口之一 |
| `sched_switch` | 调度切换 tracepoint |

观测入口：

| 命令 | 记录 |
| --- | --- |
| `ps -eLf` | 进程和线程 |
| `vmstat 1` | runnable 数、上下文切换 |
| `pidstat -w 1` | 进程上下文切换 |
| `perf sched latency` | 调度延迟 |

## 5. Linux 设计点：SMP

SMP 是对称多处理。多个 CPU 地位相同，共享同一套内存和硬件资源，任务可以被调度到不同 CPU 上运行。

Linux 学习里 SMP 带来几个具体问题：

| 问题 | 说明 |
| --- | --- |
| 多 CPU runqueue | 每个 CPU 有自己的调度队列，需要负载均衡 |
| task migration | 任务迁移到别的 CPU 可能丢失 Cache 热数据 |
| 并发访问共享数据 | 需要锁、原子操作、RCU、per-CPU 数据 |
| 中断分布 | 硬件中断可能集中在某些 CPU 上 |
| NUMA | 多路机器上访问本地/远端内存成本不同 |

观测入口：

| 命令 / 路径 | 用途 |
| --- | --- |
| `lscpu` | CPU、核心、NUMA、Cache 信息 |
| `taskset -p <pid>` | CPU affinity |
| `/proc/interrupts` | 中断在 CPU 上的分布 |
| `mpstat -P ALL 1` | 各 CPU 使用率 |

## 6. Linux 设计点：ELF

ELF 是 Linux 上常见的可执行文件和共享库格式。源代码经过编译、汇编、链接后形成 ELF 文件；执行时，内核和动态链接器把它装载到进程地址空间。

最小链路：

```text
C 源码
  -> 编译
  -> 汇编
  -> 链接
  -> ELF 可执行文件
  -> execve()
  -> 装载到进程地址空间
```

Linux 批注：

| 概念 | Linux 落点 |
| --- | --- |
| `execve()` | 替换当前进程的用户态程序映像 |
| Program header | 描述运行时需要映射的段 |
| 动态链接器 | 装载共享库、处理动态符号 |
| 地址空间 | text、data、heap、mmap、stack |
| `/proc/<pid>/maps` | 查看 ELF 段和共享库映射 |

ELF 和后续进程模型、虚拟内存、`execve()` 路径直接相关。

## 7. Linux 设计点：宏内核

Linux 是宏内核。进程调度、内存管理、文件系统、网络栈、设备驱动等大部分核心服务运行在内核态。

| 架构 | 记录 |
| --- | --- |
| 宏内核 | 核心服务集中在内核态，函数调用路径短，性能好，内核内部错误影响面大 |
| 微内核 | 内核只保留最小能力，文件系统/驱动等服务可放用户态，隔离好，跨边界通信成本高 |
| 混合内核 | 结合两者设计，具体系统实现差异大 |

Linux 也支持动态加载模块。很多驱动可以作为内核模块加载和卸载，但模块加载后仍运行在内核态。

| 机制 | 记录 |
| --- | --- |
| kernel module | 动态加载内核代码 |
| Kconfig | 配置功能是否编进内核或作为模块 |
| `lsmod` | 查看已加载模块 |
| `modinfo` | 查看模块信息 |
| `dmesg` | 查看内核日志 |

宏内核对学习路径的影响：读 Linux 时经常需要跨子系统看调用链，例如 `read()` 会同时碰到 syscall、VFS、page cache、调度和设备 I/O。

## 8. Windows 对照：只保留边界

小林 Code 用 Windows NT 和 Linux 做对照。这里只记录三个边界。

| 对照点 | 记录 |
| --- | --- |
| 内核架构 | Linux 是宏内核；Windows NT 通常归为混合内核 |
| 可执行文件 | Linux 常见 ELF；Windows 常见 PE |
| 源码可得性 | Linux 内核源码开放，适合学习源码路径和做实验 |

这个系列后续只展开 Linux。Windows 对照用于理解不同 OS 可以采用不同内核组织方式。

## 压缩表

| 小林 Code 概念 | Linux 笔记落点 |
| --- | --- |
| 内核 | `kernel/`、`mm/`、`fs/`、`net/`、`drivers/` |
| 用户态/内核态 | syscall、exception、interrupt、权限边界 |
| MultiTask | `task_struct`、调度器、runqueue |
| SMP | per-CPU runqueue、负载均衡、锁、RCU、CPU affinity |
| ELF | `execve()`、程序装载、`/proc/<pid>/maps` |
| Monolithic Kernel | VFS、网络栈、驱动、内存管理都在内核态协作 |

## 检查点与参考回答

| 问题 | 参考回答 |
| --- | --- |
| 内核提供哪些基本能力？ | 进程和线程管理、内存管理、硬件设备管理、文件系统、网络栈和系统调用接口。 |
| 用户态和内核态怎么区分？ | 用户态运行普通应用，权限低；内核态运行内核代码，权限高，可以管理页表、设备、中断等核心资源。 |
| 系统调用是什么？ | 系统调用是用户态程序请求内核服务的受控入口，内核会检查参数、权限和用户地址，再执行对应服务。 |
| syscall、异常、中断有什么区别？ | syscall 是用户主动请求；异常来自当前指令，例如 page fault；中断来自外部硬件或定时器，和当前 task 不一定有关。 |
| Linux 的 MultiTask 和 SMP 分别是什么意思？ | MultiTask 表示支持多个任务并发/并行推进；SMP 表示多个 CPU 地位对称，共享内存和硬件资源。 |
| ELF 和 `execve()` 有什么关系？ | ELF 是可执行文件格式；`execve()` 会让当前进程装载新的 ELF 程序映像，替换原用户态地址空间内容。 |
| 宏内核对 Linux 学习有什么影响？ | 很多核心服务都在内核态，真实路径经常跨多个子系统，例如 `read()` 会穿过 syscall、VFS、page cache、调度和设备 I/O。 |

## 本篇参考

- 小林 Code《图解系统》第二章：操作系统结构
- Remzi H. Arpaci-Dusseau and Andrea C. Arpaci-Dusseau, *Operating Systems: Three Easy Pieces*
- Michael Kerrisk, *The Linux Programming Interface*
- Robert Love, *Linux Kernel Development*
- Linux Kernel Documentation
