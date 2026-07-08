---
title: Linux 内核学习笔记：额外专题总览
date: 2026-07-07 17:59:50 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, Operating System, BPF, Container]
---

小林 Code《图解系统》的系统方向主线到 Linux 命令结束。这一篇作为系列收尾，把额外 Linux 内核专题摊开：横切路径、namespace/cgroup、tracing/perf/BPF、源码阅读、最小实验。它们不再按教材章节推进，而是把前面学过的进程、内存、文件、设备、网络机制串到真实工程问题上。

## 问题索引

| 专题 | 记录 |
| --- | --- |
| 横切路径 | 一次 `read()`、一次 `fork()`、一次 page fault、一次收包 |
| namespace / cgroup | 容器隔离、资源限制、运行时视图 |
| tracing / perf / BPF | 内核事件观测、动态追踪、eBPF 程序 |
| Linux 内核源码阅读 | 源码树、Kconfig、模块、文档、补丁流 |
| 最小实验 | 用命令和小程序验证机制 |

## 1. 横切路径：把对象串起来

单个子系统学完后，需要用横切路径确认对象之间的连接。

| 路径 | 串到的对象 |
| --- | --- |
| `read(fd, buf, count)` | syscall、`current`、fdtable、`struct file`、VFS、page cache、用户地址、wait queue |
| `fork()` | `task_struct`、`mm_struct`、COW、fd 继承、父子关系 |
| page fault | VMA、页表、匿名页、文件页、COW、signal |
| 网络收包 | NIC、DMA、IRQ、NAPI、softirq、`sk_buff`、socket queue |
| futex wait/wake | 用户态原子变量、futex hash、wait queue、调度器 |

横切路径的价值在于暴露边界：系统调用和上下文切换的边界，fd 和 inode 的边界，page cache 和文件系统的边界，硬中断和软中断的边界，睡眠等待和 runnable 等 CPU 的边界。

## 2. namespace / cgroup：容器机制

容器由多种 Linux 机制组合出来。namespace 提供资源视图隔离，cgroup 提供资源限制和统计，capability、seccomp、LSM、rootfs、mount 共同收紧权限和文件系统视图。

| 机制 | 作用 |
| --- | --- |
| PID namespace | 隔离 PID 视图 |
| mount namespace | 隔离挂载点 |
| network namespace | 隔离网络设备、路由、端口 |
| user namespace | 隔离 uid/gid 和 capability 映射 |
| cgroup v2 | CPU、内存、I/O、pids 等资源控制 |
| seccomp | 限制 syscall |
| capability | 拆分 root 特权 |

观察入口：

| 命令 / 路径 | 记录 |
| --- | --- |
| `/proc/<pid>/ns` | 进程所属 namespace |
| `/proc/<pid>/cgroup` | 进程所属 cgroup |
| `findmnt -t cgroup2` | cgroup v2 挂载点 |
| `nsenter -t <pid> -p -m -n sh` | 进入目标进程 namespace |

对应深挖：[namespace、cgroup 与容器机制](/posts/linux-kernel-chapter-11-namespace-cgroup/)。

## 3. tracing / perf / BPF：把内核变成可观察对象

内核学习需要观测入口。`perf` 适合采样、计数和调度分析；ftrace/tracefs 适合内核 tracepoint；BPF 适合把小程序挂到内核事件上做过滤、聚合和统计。

| 入口 | 用途 |
| --- | --- |
| tracepoint | 内核静态事件点，稳定性相对更好 |
| kprobe | 动态挂内核函数 |
| uprobe | 动态挂用户态函数 |
| perf event | 采样、硬件计数器、软件事件 |
| BPF map | BPF 程序和用户态交换数据 |
| verifier | 检查 BPF 程序安全性 |
| BTF / CO-RE | 类型信息和跨内核版本可移植 |

最小观测例子：

| 问题 | 入口 |
| --- | --- |
| 谁在发生上下文切换 | `sched:sched_switch` |
| 哪些进程在调用 `read()` | syscall tracepoint |
| TCP 重传是否增加 | TCP tracepoint 或 `ss -ti` |
| 某函数是否成为热点 | `perf top`、kprobe |

对应深挖：[tracing、perf 与 BPF](/posts/linux-kernel-chapter-12-tracing-bpf/)。

## 4. 源码阅读和实验环境

源码阅读按问题找入口，不从源码树第一行顺序读。

| 子系统 | 入口 |
| --- | --- |
| 进程 | `kernel/fork.c`、`kernel/exit.c`、`kernel/signal.c` |
| 调度 | `kernel/sched/core.c`、`kernel/sched/fair.c` |
| 内存 | `mm/memory.c`、`mm/mmap.c`、`mm/vmscan.c` |
| 文件系统 | `fs/open.c`、`fs/namei.c`、`fs/read_write.c` |
| 块层 | `block/` |
| 网络 | `net/`、`net/core/`、`net/ipv4/` |
| 驱动 | `drivers/` |
| 文档 | `Documentation/` |

实验环境优先 VM/QEMU。内核开发最小闭环是：改配置、编译、启动、触发路径、收集日志、定位 oops/panic、回滚重试。

对应深挖：[源码阅读、实验环境与内核开发方法](/posts/linux-kernel-chapter-13-kernel-development/)。

## 5. 最小实验清单

| 模块 | 实验 |
| --- | --- |
| 进程 | 写一个 `fork()` + `execve()` + `wait()` 小程序，用 `strace -f` 看路径 |
| 线程 | 写多线程共享变量，观察 race，再加 mutex/futex |
| 内存 | 用 `mmap()` 建匿名映射和文件映射，看 `/proc/<pid>/maps` |
| 文件 | `open()` 同一文件两次，对比 fd offset；`fork()` 后观察 offset 共享 |
| 调度 | 用 `perf sched record` 观察 sleep/wakeup/switch |
| 网络 | 起一个 TCP server，用 `ss -antp`、`tcpdump` 看连接和包 |
| 设备 | 观察 `/proc/interrupts`、`/proc/softirqs` 中网卡或块设备变化 |
| BPF | 用 `bpftrace` 统计 syscall 或调度 tracepoint |

这些实验不追求一次写成完整项目。每个实验只验证一个机制：对象在哪里、状态怎么变、事件怎么观察。

## 压缩表

| 额外专题 | 前置主线 | 学习产出 |
| --- | --- | --- |
| 横切路径 | syscall、fd、VMA、page cache、wait queue | 能把一次真实调用串到多个子系统 |
| namespace / cgroup | 进程、文件系统、网络、权限 | 能解释容器隔离和限制 |
| tracing / BPF | syscall、调度、网络、文件系统 | 能写最小观测脚本 |
| 源码阅读 | 各子系统对象 | 能按问题找入口函数和结构体 |
| 最小实验 | 命令和小程序 | 能用现象验证机制 |

## 检查点与参考回答

| 问题 | 参考回答 |
| --- | --- |
| 为什么额外专题放在主线之后？ | namespace/cgroup、BPF、源码实验都依赖前面的进程、内存、文件、设备、网络基础。主线先建立对象和路径，额外专题再做组合。 |
| 容器主要依赖哪些内核机制？ | namespace 提供视图隔离，cgroup 提供资源限制，capability/seccomp/LSM/rootfs/mount 等机制提供权限和文件系统边界。 |
| BPF 学习从哪里开始？ | 从 tracepoint 和 `bpftrace` 开始，先统计 syscall、调度、网络事件，再看 BPF map、verifier、BTF、CO-RE。 |
| 源码阅读怎么选入口？ | 按路径选入口。进程创建看 `kernel/fork.c`，缺页看 `mm/memory.c`，路径解析看 `fs/namei.c`，收包看 `net/` 和驱动/NAPI 路径。 |
| 最小实验有什么用？ | 最小实验把概念变成可观察现象。能用命令或 trace 看到状态变化，机制才算真正落地。 |

## 本篇参考

- Linux Kernel Documentation
- Linux Kernel Labs
- Michael Kerrisk, *The Linux Programming Interface*
- Robert Love, *Linux Kernel Development*
- Brendan Gregg, *Systems Performance*
