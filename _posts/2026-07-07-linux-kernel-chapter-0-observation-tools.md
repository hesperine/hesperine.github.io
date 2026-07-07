---
title: Linux 内核学习笔记（零）：环境与观察工具
date: 2026-07-07 17:10:00 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, strace, perf, ftrace, bpftrace]
---

环境与观察工具记录。系统调用、进程状态、地址空间、文件描述符、调度延迟、内核事件，都有对应的观察入口。

本章只解决一个问题：一台 Linux 机器上，哪些信息能直接看见。后续章节里的 `task_struct`、VMA、fd、runqueue、tracepoint、BPF hook，都需要先知道对应的用户态入口。

这章对应小林 Code 里“Linux 命令”和各系统模块的观测部分。后面看进程管理、内存管理、文件系统、设备管理、网络系统时，先从这些入口把现象落到机器上。

| 模块 | 第一批观察入口 |
| --- | --- |
| 进程管理 | `ps`、`/proc/<pid>/status`、`/proc/<pid>/task` |
| 调度系统 | `vmstat`、`pidstat -w`、`perf sched`、`sched_switch` |
| 内存管理 | `/proc/<pid>/maps`、`smaps`、`/proc/meminfo` |
| 文件系统 | `/proc/<pid>/fd`、`fdinfo`、`lsof`、`strace` |
| 设备管理 | `/proc/interrupts`、`/sys`、`lsblk` |
| 网络系统 | `ss`、`ip`、`/proc/net/dev`、`tcpdump` |

## 运行环境

不同 Linux 环境会影响能用哪些工具。

```bash
uname -a
cat /etc/os-release
id
```

`uname -a` 给出内核版本和架构。BPF、ftrace、perf 的可用能力都和内核版本、发行版配置、权限有关。`id` 用来确认当前用户权限；很多 tracing 工具需要 root 或额外 capability。

再看内核配置：

```bash
ls /boot
zcat /proc/config.gz 2>/dev/null | head
```

有些发行版把内核配置放在 `/boot/config-$(uname -r)`，有些提供 `/proc/config.gz`。工具不可用时，配置项经常是第一检查点。

WSL2 可以做很多用户态和部分内核观察。涉及内核模块、某些 BPF program type、硬件 perf event、网络驱动路径时，VM 或真机会更稳定。

## 术语表 / 八股检查点

| 名词 | 记录 |
| --- | --- |
| procfs | `/proc`，把进程和部分内核状态暴露成文件 |
| sysfs | `/sys`，把设备、驱动、内核对象层级暴露成文件 |
| debugfs | 调试用虚拟文件系统，很多内核调试接口挂在这里 |
| tracefs | tracing 专用文件系统，ftrace 和 trace events 的主要入口 |
| tracepoint | 内核源码里预定义的稳定观测点 |
| kprobe | 动态挂到内核函数或指令位置的探针 |
| uprobe | 动态挂到用户态函数或指令位置的探针 |
| perf event | perf 使用的性能事件抽象，可来自硬件计数器或内核事件 |
| BPF program | 加载到内核、经 verifier 检查后运行的小程序 |
| capability | Linux 权限拆分机制，部分 tracing 能力依赖特定 capability |

几个边界：

- `strace` 观察 syscall 边界，不观察任意内核函数。
- ftrace/tracefs 观察内核事件和函数，依赖内核配置和权限。
- `perf` 既能采样 CPU 热点，也能记录调度等内核事件。
- `bpftrace` 是 BPF tracing 的轻量入口，适合快速验证路径。

## /proc：进程和内核状态的窗口

`/proc` 是学习 Linux 的第一批入口。它由 procfs 暴露内核视图。

当前 shell 自己：

```bash
cat /proc/self/status
cat /proc/self/maps
ls -l /proc/self/fd
```

一个进程的典型入口：

| 路径 | 内容 |
| --- | --- |
| `/proc/<pid>/status` | 进程状态、线程数、内存概况 |
| `/proc/<pid>/maps` | 地址空间里的 VMA |
| `/proc/<pid>/smaps` | 每段映射的 RSS/PSS 等细节 |
| `/proc/<pid>/fd` | 打开的文件描述符 |
| `/proc/<pid>/fdinfo` | fd 的 offset、flags 等信息 |
| `/proc/<pid>/task` | 线程列表 |

进程、地址空间、fd、线程，都能从 `/proc/<pid>/` 找到入口。

## strace：看用户态如何请求内核

`strace` 追踪系统调用。它能回答一类很直接的问题：这个程序向内核请求了什么？

```bash
strace -o trace.log ls
strace -f -e openat,read,write,close cat /etc/hostname
```

常见选项：

| 选项 | 含义 |
| --- | --- |
| `-f` | 跟踪 fork/clone 出来的子进程或线程 |
| `-e read,write` | 只看指定 syscall |
| `-o file` | 输出到文件 |
| `-tt` | 打印时间戳 |
| `-T` | 打印每个 syscall 耗时 |

`strace` 的位置在用户态和内核态边界。它看不到内核函数内部怎么走，但能看到 syscall 名字、参数、返回值和错误码。

例子：

```text
openat(AT_FDCWD, "/etc/hostname", O_RDONLY) = 3
read(3, "myhost\n", 131072)                 = 7
close(3)                                    = 0
```

这里的 `3` 就是文件描述符。fd table 和 VFS 会从这几行继续展开。

## ps、top、pidstat：看 task 状态

进程和线程先从用户态工具看。

```bash
ps -eLf
ps -o pid,ppid,stat,comm -p <pid>
top -H -p <pid>
pidstat -w 1
```

`ps -eLf` 会显示线程。Linux 内核里调度的基本对象接近 task，线程也对应可调度实体。`top -H` 可以按线程看 CPU 使用。`pidstat -w` 可以看上下文切换。

`STAT` 字段很有用：

| 状态 | 含义 |
| --- | --- |
| `R` | running / runnable |
| `S` | interruptible sleep |
| `D` | uninterruptible sleep |
| `T` | stopped |
| `Z` | zombie |

`R/S/D/Z` 比“进程状态”这个词更具体。

## vmstat：看系统级活动

`vmstat 1` 每秒输出一次系统状态。

```bash
vmstat 1
```

关注几列：

| 列 | 含义 |
| --- | --- |
| `r` | runnable task 数量 |
| `b` | uninterruptible sleep task 数量 |
| `cs` | 每秒上下文切换次数 |
| `in` | 每秒中断次数 |
| `si/so` | swap in/out |
| `us/sy` | 用户态和内核态 CPU 占比 |
| `wa` | I/O wait |

`vmstat` 给出系统级状态，用来快速判断 CPU 忙、I/O 等待多、上下文切换多、中断多等情况。

## perf：采样和调度入口

`perf` 是 Linux 性能分析的主工具之一。先记住两类用法。

第一类是 CPU 采样：

```bash
perf top
perf record -g -- ./your_program
perf report
```

`perf top` 类似实时热点函数表。`perf record -g` 记录调用栈，`perf report` 查看结果。

第二类是调度观察：

```bash
perf sched record -- sleep 3
perf sched latency
```

这会记录调度事件，用来查看 task 的调度延迟。runqueue、wakeup、context switch 都能从这里接上。

## ftrace 和 tracefs

ftrace 是内核内置 tracing 框架，通常通过 tracefs 暴露。

常见挂载点：

```bash
mount | grep tracefs
ls /sys/kernel/tracing
```

有的系统路径是 `/sys/kernel/debug/tracing`。ftrace 可以看 tracepoint，也可以做 function tracing。它比 `strace` 更靠近内核内部，但使用时要注意权限和系统开销。

几个文件：

| 文件 | 含义 |
| --- | --- |
| `available_events` | 可用 tracepoint |
| `current_tracer` | 当前 tracer |
| `trace` | trace 输出 |
| `trace_pipe` | 实时读取 trace 输出 |
| `set_event` | 选择事件 |

本节暂不展开具体操作，只记录 ftrace/tracefs 是 Linux 内核自带的观测入口。

## bpftrace：最轻量的 BPF 入口

BPF 的轻量入口可以放在 bpftrace。它适合快速挂 tracepoint、kprobe、uprobe，观察 syscall、调度、I/O、网络等事件。

例子：

```bash
sudo bpftrace -e 'tracepoint:syscalls:sys_enter_openat { printf("%s %s\n", comm, str(args.filename)); }'
```

再看调度切换：

```bash
sudo bpftrace -e 'tracepoint:sched:sched_switch { @[comm] = count(); }'
```

bpftrace 的优势是短小，适合学习和排查；正式工具或生产长期运行通常会转向 libbpf、BCC 或专门观测系统。

## 工具地图

| 观察对象 | 工具 |
| --- | --- |
| 程序请求内核 | `strace` |
| 进程/线程状态 | `ps`、`top`、`pidstat`、`/proc/<pid>` |
| 地址空间 | `/proc/<pid>/maps`、`smaps`、`pmap` |
| 文件描述符 | `/proc/<pid>/fd`、`fdinfo`、`lsof` |
| 系统整体活动 | `vmstat` |
| CPU/调度热点 | `perf` |
| 内核事件 | ftrace、tracefs |
| BPF tracing | `bpftrace` |

后续笔记按主题使用对应工具。

## 本章检查点与参考回答

| 问题 | 参考回答 |
| --- | --- |
| 怎么确认当前 Linux 环境？ | 用 `uname -a` 看内核版本和架构，用 `/etc/os-release` 看发行版，用 `id` 看当前权限。tracing、BPF、perf 能力同时受内核版本、配置和权限影响。 |
| 怎么看一个进程的状态、线程、地址空间和 fd？ | `/proc/<pid>/status` 看状态和线程数，`/proc/<pid>/task` 看线程列表，`/proc/<pid>/maps` 看地址空间，`/proc/<pid>/fd` 和 `fdinfo` 看文件描述符。 |
| `strace` 能看到什么？ | `strace` 看到用户态进入内核的 syscall 边界，包括 syscall 名字、参数、返回值和错误码；它看不到任意内核函数内部路径。 |
| `perf`、ftrace、BPF tracing 怎么区分？ | `perf` 主要用于采样和性能事件分析；ftrace/tracefs 使用内核内置 tracing 设施看 tracepoint 或函数；BPF tracing 把小程序挂到 tracepoint、kprobe、uprobe 等 hook 上做过滤、聚合和输出。 |
| 工具不可用时先查什么？ | 先查权限，再查内核配置和运行环境。WSL、VM、真机、容器里的 tracing 能力不同；`/boot/config-*`、`/proc/config.gz`、tracefs 挂载状态都可能影响工具可用性。 |

## 本章参考

- [Linux Kernel Documentation](https://docs.kernel.org/)
- [perf wiki](https://perf.wiki.kernel.org/)
- [bpftrace documentation](https://bpftrace.org/docs/)
- [小林 Code：图解系统](https://xiaolincoding.com/os/)
- Brendan Gregg, *Systems Performance*
