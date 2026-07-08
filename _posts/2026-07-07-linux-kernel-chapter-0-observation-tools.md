---
title: Linux 内核学习笔记（零）：环境与观察工具
date: 2026-07-07 17:10:00 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, strace, perf, ftrace, bpftrace]
---

第 0 章记录 Linux 机器上的观察入口。后面写进程、调度、内存、文件系统、设备、网络和 BPF 时，先从这些入口确认现象，再去追内核对象和源码路径。

本章分三组笔记：

| 笔记单元 | 记录内容 |
| --- | --- |
| 基础与八股 | 常用 Linux 观察命令、进程/内存/文件/网络指标的查看入口 |
| OS 模型 | 观察结果如何对应进程、地址空间、文件、调度、I/O、并发这些抽象 |
| Linux 实现 | `/proc`、`/sys`、tracefs、perf event、tracepoint、BPF hook 的边界 |

## 0.1 基础与八股：环境确认

环境、权限、内核配置会直接决定工具能不能用。环境记录项：

| 问题 | 命令 / 路径 | 记录点 |
| --- | --- | --- |
| 当前内核版本和架构 | `uname -a` | BPF、perf、ftrace 能力和内核版本相关 |
| 当前发行版 | `cat /etc/os-release` | 包管理器、默认工具、内核配置路径不同 |
| 当前权限 | `id` | tracing、perf、BPF 常受 root 或 capability 限制 |
| 内核配置 | `/boot/config-$(uname -r)`、`/proc/config.gz` | `CONFIG_FTRACE`、`CONFIG_BPF`、`CONFIG_PERF_EVENTS` 等配置项 |
| tracefs 是否挂载 | `mount | grep tracefs`、`ls /sys/kernel/tracing` | ftrace、trace event 的文件入口 |

常见八股问题可以直接和工具对应：

| 问法 | 第一观察入口 | 后续章节 |
| --- | --- | --- |
| 怎么看一个进程有多少线程？ | `/proc/<pid>/status`、`/proc/<pid>/task`、`ps -eLf` | 进程模型 |
| 怎么看进程地址空间？ | `/proc/<pid>/maps`、`/proc/<pid>/smaps` | 虚拟内存 |
| 怎么看进程打开了哪些文件？ | `/proc/<pid>/fd`、`/proc/<pid>/fdinfo`、`lsof` | 文件系统 / VFS |
| 怎么看上下文切换多不多？ | `vmstat 1`、`pidstat -w 1`、`perf sched` | 调度器 |
| 怎么看 CPU 热点？ | `perf top`、`perf record -g`、`perf report` | 性能分析 |
| 怎么看网络连接？ | `ss -antp`、`ip -s link`、`/proc/net/dev` | 网络栈 |
| 怎么看中断？ | `/proc/interrupts`、`vmstat 1` 的 `in` 列 | 设备和中断 |

几个高频名词：

| 名词 | 记录 |
| --- | --- |
| procfs | `/proc`，把进程和部分内核状态暴露成文件 |
| sysfs | `/sys`，把设备、驱动、总线、内核对象层级暴露成文件 |
| debugfs | 调试用虚拟文件系统，接口稳定性弱于正式 ABI |
| tracefs | tracing 专用文件系统，ftrace 和 trace events 的主要入口 |
| tracepoint | 内核源码中预先定义的观测点，字段相对稳定 |
| kprobe | 动态挂到内核函数或指令位置的探针 |
| uprobe | 动态挂到用户态函数或指令位置的探针 |
| perf event | perf 使用的事件抽象，可来自硬件计数器、软件事件、tracepoint |
| BPF program | 加载到内核、经 verifier 检查后运行的小程序 |
| capability | Linux 把 root 权限拆成更细粒度能力后的权限单位 |

## 0.2 OS 模型：观察值对应哪些抽象

OSTEP 主要把 OS 分成三条主线：虚拟化、并发、持久化。观察工具的作用是把这三条主线落到运行中的机器。

虚拟化对应“进程看到什么资源”。CPU 被虚拟化后，多个 task 轮流运行；内存被虚拟化后，每个进程看到自己的虚拟地址空间；存储被虚拟化后，进程通过 fd、路径名和文件系统访问持久化对象。

并发对应“多个执行流如何交错”。`ps`、`top -H`、`pidstat -w`、`perf sched` 看到的是线程、上下文切换、阻塞、唤醒、调度延迟。后面写锁、futex、RCU 时，仍然要回到这些现象。

持久化对应“数据如何从进程走到文件系统和设备”。`strace` 能看到 `openat()`、`read()`、`write()`、`fsync()` 这些系统调用；`/proc/<pid>/fd` 能看到 fd；`iostat`、`lsblk`、`/sys/block` 能把路径继续接到块设备。

同一个现象通常需要两层观察：

| 现象 | 用户态边界 | 内核内部事件 |
| --- | --- | --- |
| 程序读文件变慢 | `strace -T -e read,openat` | page cache miss、block I/O、调度等待 |
| 进程 CPU 高 | `top -H`、`perf top` | 热点函数、系统调用比例、锁竞争 |
| 延迟抖动 | `pidstat -w`、`perf sched latency` | wakeup latency、runqueue 等待、多核迁移 |
| 内存涨高 | `/proc/<pid>/smaps` | VMA、匿名页、文件页、COW、reclaim |
| 网络收包慢 | `ss`、`ip -s link` | NAPI、softirq、TCP 栈、socket wait queue |

## 0.3 Linux 实现：这些入口从哪里来

Linux 里的很多“文件”是内核对象的文本接口。读 `/proc/<pid>/status` 时，内核调用 procfs 对应的回调，把 `task_struct`、`mm_struct`、`files_struct` 等状态格式化出来。

几个入口的边界：

| 入口 | Linux 侧含义 | 适合回答的问题 |
| --- | --- | --- |
| `/proc/<pid>` | 进程视图，围绕 task、地址空间、fd、线程展开 | 当前进程是谁、打开了什么、映射了什么、线程有哪些 |
| `/proc/sys` | sysctl 参数 | 内核运行参数如何影响网络、VM、调度等行为 |
| `/sys` | kobject、设备模型、驱动模型 | 设备、总线、驱动、块设备、网络设备的层级关系 |
| tracefs | ftrace、trace events | 内核事件何时发生，字段是什么 |
| perf event | 性能事件和采样接口 | CPU 周期、cache miss、tracepoint、调度事件 |
| BPF hook | tracepoint、kprobe、uprobe、XDP、tc、LSM 等挂载点 | 在内核路径上过滤、聚合、统计、扩展行为 |

源码阅读时可以先记这些目录：

| 路径 | 主要内容 |
| --- | --- |
| `fs/proc/` | procfs 实现 |
| `fs/sysfs/` | sysfs 实现 |
| `kernel/trace/` | ftrace、trace event、部分 tracing 基础设施 |
| `kernel/events/` | perf event |
| `kernel/bpf/` | BPF verifier、map、program 管理等核心逻辑 |
| `tools/perf/` | perf 用户态工具 |
| `tools/bpf/`、`tools/testing/selftests/bpf/` | BPF 工具和自测 |

`strace`、`perf`、ftrace、BPF 的位置也不一样：

| 工具 | 观察层级 | 典型用途 |
| --- | --- | --- |
| `strace` | syscall 边界 | 程序调用了哪些系统调用，参数和返回值是什么 |
| `perf` | 采样、计数、trace event | CPU 热点、调用栈、调度延迟、硬件事件 |
| ftrace | 内核 trace event 和函数 tracing | 内核路径上的事件序列 |
| `bpftrace` | BPF tracing 快速脚本 | 对 tracepoint/kprobe/uprobe 做过滤和聚合 |

## 0.4 `/proc`：进程、地址空间和 fd

`/proc/<pid>` 是后续章节最常用的入口。

| 路径 | 对应抽象 | 后续会展开到 |
| --- | --- | --- |
| `/proc/<pid>/status` | 进程状态、线程数、内存概况 | `task_struct`、task state、signal |
| `/proc/<pid>/task` | 线程列表 | thread group、pid/tgid、调度实体 |
| `/proc/<pid>/maps` | 地址空间映射 | `mm_struct`、VMA、`mmap()`、page fault |
| `/proc/<pid>/smaps` | 每段映射的 RSS/PSS/权限等细节 | 匿名页、文件页、COW、page cache |
| `/proc/<pid>/fd` | 文件描述符表 | `files_struct`、fdtable、`struct file` |
| `/proc/<pid>/fdinfo` | fd flags、offset 等信息 | open file description、文件偏移 |
| `/proc/<pid>/stack` | 内核栈回溯，受权限和配置限制 | 阻塞点、等待队列 |

简单命令组合：

```bash
cat /proc/self/status
cat /proc/self/maps
ls -l /proc/self/fd
cat /proc/self/fdinfo/0
```

这里的 `self` 指当前进程。它适合确认 procfs 路径含义，不需要另找 pid。

## 0.5 `strace`：系统调用边界

`strace` 使用 ptrace 机制观察系统调用进入和返回。它能看到 syscall 名字、参数、返回值、错误码和耗时。

| 需求 | 命令 |
| --- | --- |
| 记录一个命令的 syscall | `strace -o trace.log ls` |
| 跟踪子进程/线程 | `strace -f ./program` |
| 只看文件相关 syscall | `strace -f -e openat,read,write,close ./program` |
| 看 syscall 耗时 | `strace -T ./program` |
| 打印时间戳 | `strace -tt ./program` |

一段典型输出：

```text
openat(AT_FDCWD, "/etc/hostname", O_RDONLY) = 3
read(3, "myhost\n", 131072)                 = 7
close(3)                                    = 0
```

这三行已经接上三个后续主题：`3` 是 fd，`read()` 会进入 VFS 和 page cache，返回值 `7` 是成功拷贝到用户缓冲区的字节数。

`strace` 的边界也要记住：它不显示任意内核函数，不显示调度器内部事件，也不直接说明 page fault、锁竞争或设备中断。它适合作为“程序向内核请求了什么”的入口。

## 0.6 进程状态、调度和系统负载

进程状态先看 `ps` 和 `/proc`：

| 命令 | 用途 |
| --- | --- |
| `ps -eLf` | 展示进程和线程 |
| `ps -o pid,ppid,stat,comm -p <pid>` | 看指定进程状态 |
| `top -H -p <pid>` | 按线程看 CPU 使用 |
| `pidstat -w 1` | 看上下文切换 |
| `vmstat 1` | 看系统 runnable、blocked、中断、上下文切换、CPU 占比 |

`ps` 的 `STAT` 字段：

| 状态 | 记录 |
| --- | --- |
| `R` | running 或 runnable，正在运行或在 runqueue 等 CPU |
| `S` | interruptible sleep，等待事件，可被信号打断 |
| `D` | uninterruptible sleep，常见于某些 I/O 等待 |
| `T` | stopped，被 job control 或 ptrace 停住 |
| `Z` | zombie，已退出但父进程尚未 wait |

`vmstat 1` 中几列值得长期记：

| 列 | 记录 |
| --- | --- |
| `r` | runnable task 数量 |
| `b` | uninterruptible sleep task 数量 |
| `cs` | 每秒上下文切换次数 |
| `in` | 每秒中断次数 |
| `us/sy` | 用户态 / 内核态 CPU 占比 |
| `wa` | I/O wait |
| `si/so` | swap in / swap out |

调度延迟继续用 perf：

```bash
perf sched record -- sleep 3
perf sched latency
```

这组命令记录 `sched_switch`、`sched_wakeup` 等事件，用来分析 task 从被唤醒到真正运行之间等了多久。

## 0.7 perf、ftrace 和 BPF tracing

`perf` 的两条主线是采样和事件记录。

| 用法 | 命令 |
| --- | --- |
| 实时 CPU 热点 | `perf top` |
| 记录调用栈 | `perf record -g -- ./program` |
| 查看记录结果 | `perf report` |
| 查看可用事件 | `perf list` |
| 记录调度事件 | `perf sched record -- sleep 3` |

ftrace 通过 tracefs 使用。常见路径是 `/sys/kernel/tracing`，有些系统在 `/sys/kernel/debug/tracing`。

| tracefs 文件 | 记录 |
| --- | --- |
| `available_events` | 可用 tracepoint |
| `set_event` | 选择启用哪些事件 |
| `current_tracer` | 当前 tracer |
| `trace` | 当前 trace buffer 内容 |
| `trace_pipe` | 实时读取 trace 输出 |

BPF tracing 可以从 `bpftrace` 入门。它适合写短脚本确认事件是否发生、按进程名聚合、按 syscall 计数。

```bash
sudo bpftrace -e 'tracepoint:syscalls:sys_enter_openat { printf("%s %s\n", comm, str(args.filename)); }'
sudo bpftrace -e 'tracepoint:sched:sched_switch { @[comm] = count(); }'
```

BPF 程序进入内核前要经过 verifier 检查。短期学习用 `bpftrace` 看事件，后面再把 verifier、map、helper、BTF、CO-RE、libbpf 放到第 12 章。

## 0.8 一条最小排查路径

例子：一个程序读配置文件很慢。

第一步看 syscall 边界：`strace -T -e openat,read,close ./program`。如果 `openat()` 或 `read()` 耗时高，说明慢点至少出现在用户态请求内核之后。

第二步看 fd 和路径：`ls -l /proc/<pid>/fd`，确认程序实际读的是哪个文件。很多“读配置慢”最后是路径、符号链接、网络文件系统或容器挂载导致的。

第三步看系统状态：`vmstat 1`。如果 `b`、`wa` 很高，I/O 等待需要继续查。如果 `cs` 很高，可能是调度或锁竞争。如果 `sy` 很高，内核态开销需要展开。

第四步看热点或调度：CPU 高用 `perf top` 或 `perf record -g`；怀疑调度延迟用 `perf sched record` 和 `perf sched latency`。

第五步再进 tracing：用 ftrace 或 `bpftrace` 观察 syscall、调度、block I/O、网络等 tracepoint。到这一步再读源码，路径会清楚很多。

## 本章检查点与参考回答

| 问题 | 参考回答 |
| --- | --- |
| 怎么确认当前 Linux 环境是否适合做内核观察？ | 先看 `uname -a`、`/etc/os-release`、`id`，再看内核配置和 tracefs 挂载。perf、ftrace、BPF 同时受内核版本、配置、权限、虚拟化环境影响。 |
| `/proc/<pid>/maps` 和 `/proc/<pid>/fd` 分别看什么？ | `maps` 看进程地址空间里的 VMA，后续对应 `mm_struct` 和 `vm_area_struct`；`fd` 看文件描述符表，后续对应 `files_struct`、fdtable 和 `struct file`。 |
| `strace` 能解决什么问题？ | 它能确认程序发起了哪些 syscall、参数是什么、返回值和错误码是什么、每个 syscall 大概耗时多少。它不能直接显示任意内核函数内部路径。 |
| `perf`、ftrace、BPF tracing 的区别是什么？ | `perf` 适合采样、硬件/软件事件和调度分析；ftrace 是内核内置 tracing 设施，直接使用 tracefs；BPF tracing 把小程序挂到 tracepoint、kprobe、uprobe 等位置做过滤和聚合。 |
| 为什么很多内核状态能用文件读取？ | procfs、sysfs、tracefs 是虚拟文件系统。读这些路径时，内核执行对应回调，把内核对象状态格式化给用户态，不等同于读取磁盘文件。 |
| 看到程序慢，应该先读源码还是先观测？ | 先观测 syscall、进程状态、CPU/调度/I/O 指标，确认慢点在用户态、syscall 边界、调度等待、I/O 还是内核热点，再选择源码入口。 |

## 本章参考

- [Linux Kernel Documentation](https://docs.kernel.org/)
- [perf wiki](https://perf.wiki.kernel.org/)
- [bpftrace documentation](https://bpftrace.org/docs/)
- [小林 Code：图解系统](https://xiaolincoding.com/os/)
- Remzi H. Arpaci-Dusseau, Andrea C. Arpaci-Dusseau, *Operating Systems: Three Easy Pieces*
- Brendan Gregg, *Systems Performance*
