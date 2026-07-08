---
title: Linux 内核学习笔记：Linux 命令阅读批注
date: 2026-07-07 17:59:30 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, Operating System, Linux Commands, Observability]
---

这一篇按小林 Code《图解系统》第九章“Linux 命令”的顺序记：网络性能指标、网络配置、socket 信息、吞吐率和 PPS、连通性和延迟、日志 PV/UV 分析。结合这组 OS/Linux 笔记，命令部分扩成各模块的观测入口：进程、内存、文件、设备、网络、内核事件。

## 问题索引

| 小林 Code 主题 | 本篇记录 |
| --- | --- |
| 网络性能指标 | 带宽、延迟、吞吐、PPS、错误、丢包 |
| 网络配置 | `ip`、`ifconfig`、MTU、网卡状态 |
| socket 信息 | `ss`、连接状态、队列、backlog |
| 吞吐率和 PPS | `sar -n`、`ip -s link` |
| 连通性和延迟 | `ping`、`traceroute`、`mtr` |
| 日志 PV/UV | `wc`、`awk`、`sort`、`uniq`、`head` |
| Linux 观测入口 | `/proc`、`/sys`、`perf`、ftrace、BPF |

## 1. 命令作为观察入口

系统问题通常要先定位对象：进程、地址空间、fd、文件系统、块设备、网卡、socket、调度事件。命令的作用是把这些对象的状态拿出来。

| 问题 | 入口 |
| --- | --- |
| 当前进程在做什么 | `ps`、`top`、`pidstat`、`strace` |
| 内存压力在哪里 | `free`、`vmstat`、`/proc/meminfo`、`smaps` |
| 文件和 fd 怎么连 | `/proc/<pid>/fd`、`lsof`、`stat` |
| 磁盘 I/O 是否慢 | `iostat`、`pidstat -d`、`/proc/diskstats` |
| 网络是否丢包 | `ip -s link`、`ss`、`sar -n`、`tcpdump` |
| 内核路径在哪里慢 | `perf`、ftrace、`bpftrace` |

先选对象，再选命令。只看单个指标容易误判，例如 CPU 高可能是用户态计算、内核态系统调用、软中断、I/O 等待或调度抖动。

## 2. 网络性能指标

小林 Code 先讲网络指标。常用四个基础指标是带宽、延迟、吞吐率、PPS。

| 指标 | 含义 | 观察入口 |
| --- | --- | --- |
| bandwidth | 链路理论或配置能力 | `ethtool <dev>`、云厂商规格 |
| latency | 往返延迟或服务响应时间 | `ping`、`mtr`、应用指标 |
| throughput | 实际传输速率 | `sar -n DEV 1`、`ip -s link` |
| PPS | 每秒包数 | `sar -n DEV 1`、网卡统计 |
| errors | 错误包 | `ip -s link`、`ethtool -S` |
| drops | 丢包 | `ip -s link`、`ss -s`、驱动统计 |
| retrans | TCP 重传 | `ss -s`、`sar -n TCP,ETCP 1` |

网络排查要同时看链路、协议栈和应用。链路层丢包、TCP 重传、accept 队列满、应用读慢，表现都可能是“请求慢”。

## 3. 网络配置和 socket 信息

`ip` 是现代 Linux 查看网络配置的主要入口。

| 命令 | 记录 |
| --- | --- |
| `ip addr` | 地址、网卡状态 |
| `ip -s link` | 网卡收发包、错误、丢包 |
| `ip route` | 路由表 |
| `ethtool <dev>` | 链路速度、duplex、offload 等 |
| `ethtool -S <dev>` | 网卡驱动统计 |

socket 信息优先用 `ss`。

| 命令 | 记录 |
| --- | --- |
| `ss -antp` | TCP 连接、状态、进程 |
| `ss -lntp` | 监听端口 |
| `ss -s` | socket 汇总 |
| `ss -ti` | TCP 详细信息，如重传、拥塞控制 |

`Recv-Q` 和 `Send-Q` 要结合状态看。监听 socket 上的队列和已建立连接上的队列含义不同；服务端 backlog、accept 速度、应用读取速度都会影响队列表现。

## 4. 连通性、延迟、抓包

| 命令 | 用途 |
| --- | --- |
| `ping <host>` | 基础连通性和 RTT |
| `traceroute <host>` | 路径跳数和中间节点 |
| `mtr <host>` | 连续路径质量观察 |
| `tcpdump -i <dev> host <ip>` | 抓包确认真实收发 |
| `nc -vz <host> <port>` | TCP 端口连通性 |

`ping` 通不代表 TCP 服务可用；TCP 端口通也不代表应用层协议正常。网络排查通常从 L3 连通性、L4 端口、L7 应用日志逐层确认。

## 5. 日志 PV/UV 分析

小林 Code 的日志分析小节适合保留为文本处理入口。大日志先看大小和格式，再做流式处理。

| 目标 | 命令入口 |
| --- | --- |
| 看文件大小 | `ls -lh access.log` |
| 看最新内容 | `tail -n 100 access.log` |
| 统计 PV | `wc -l access.log` |
| 按日期分组 | `awk` 提取时间字段后 `sort | uniq -c` |
| 统计 UV | 提取 IP 或用户标识后 `sort -u | wc -l` |
| Top N | `sort | uniq -c | sort -nr | head` |

大文件处理避免无目的 `cat`。优先用 `head`、`tail`、`less`、`awk`、`grep`、`sort` 这类流式工具。需要多次分析时，可以先抽取必要字段生成中间文件。

## 6. 进程、线程、调度

| 目标 | 命令 / 路径 |
| --- | --- |
| 看进程 | `ps -ef`、`ps -o pid,ppid,stat,comm` |
| 展开线程 | `ps -eLf`、`top -H -p <pid>` |
| 看状态 | `/proc/<pid>/status` |
| 看等待点 | `ps -o pid,stat,wchan,comm -p <pid>`、`/proc/<pid>/wchan` |
| 看上下文切换 | `pidstat -w 1`、`vmstat 1` |
| 看调度延迟 | `perf sched record`、`perf sched latency` |

进程状态要区分 sleeping 和 runnable。`D` 状态常指不可中断睡眠，可能和 I/O、文件系统、驱动路径相关；`R` 可能正在运行，也可能在 runqueue 等 CPU。

## 7. 内存和地址空间

| 目标 | 命令 / 路径 |
| --- | --- |
| 系统内存 | `free -h`、`cat /proc/meminfo` |
| 内存压力 | `vmstat 1` |
| 进程映射 | `cat /proc/<pid>/maps` |
| VMA 统计 | `cat /proc/<pid>/smaps` |
| 缺页统计 | `ps -o pid,min_flt,maj_flt,comm -p <pid>` |
| slab | `slabtop`、`cat /proc/slabinfo` |

RSS、VSS、PSS 的含义不同。共享库、page cache、mmap 文件都会影响看到的数值。只看 `top` 的 RES 不足以解释所有内存问题。

## 8. 文件、fd、文件系统、块 I/O

| 目标 | 命令 / 路径 |
| --- | --- |
| fd 列表 | `ls -l /proc/<pid>/fd` |
| fd offset/flags | `cat /proc/<pid>/fdinfo/<fd>` |
| 打开文件 | `lsof -p <pid>` |
| inode 信息 | `stat <file>`、`ls -li` |
| 挂载 | `findmnt`、`mount` |
| 磁盘空间 | `df -h`、`du -sh` |
| 块设备 | `lsblk -o NAME,TYPE,SIZE,ROTA,SCHED` |
| I/O 指标 | `iostat -x 1`、`pidstat -d 1` |

fd、`struct file`、inode 的区别可以通过 `/proc/<pid>/fd` 和 `fdinfo` 观察。`fork()` 后 fd 共享 offset 的问题，也可以用 `fdinfo` 看偏移变化。

## 9. 设备、中断、内核事件

| 目标 | 命令 / 路径 |
| --- | --- |
| 中断分布 | `cat /proc/interrupts` |
| 软中断 | `cat /proc/softirqs` |
| 设备树 | `ls /sys/class`、`ls /sys/bus` |
| 模块 | `lsmod`、`modinfo <module>` |
| 内核日志 | `dmesg -T` |
| tracefs | `/sys/kernel/tracing` |
| perf | `perf top`、`perf record`、`perf report` |
| BPF | `bpftrace`、`bpftool` |

内核事件观察要注意权限、内核配置和生产环境开销。`perf top`、ftrace、BPF 都可能影响系统，范围要收窄。

## 10. 命令到内核对象的映射

| 命令 / 路径 | 对应内核对象 |
| --- | --- |
| `/proc/<pid>/status` | `task_struct` 及其统计 |
| `/proc/<pid>/maps` | `mm_struct`、VMA |
| `/proc/<pid>/fd` | `files_struct`、fdtable、`struct file` |
| `ss` | socket、TCP 状态、队列 |
| `ip -s link` | `net_device` 统计 |
| `/proc/interrupts` | IRQ 统计 |
| `/proc/softirqs` | softirq 统计 |
| `/proc/meminfo` | 内存管理全局统计 |
| `/proc/diskstats` | block layer 统计 |

## 检查点与参考回答

| 问题 | 参考回答 |
| --- | --- |
| 网络性能常看哪些指标？ | 带宽、延迟、吞吐率、PPS、错误、丢包、重传、连接队列等。不同指标对应链路、协议栈和应用不同层次。 |
| 查看 socket 状态优先用什么？ | 优先用 `ss`。常用 `ss -antp` 看 TCP 连接和进程，`ss -lntp` 看监听端口，`ss -s` 看汇总。 |
| `ip -s link` 主要看什么？ | 看网卡收发字节数、包数、错误和丢包。它适合确认链路层和驱动层面的收发情况。 |
| 大日志为什么慎用 `cat`？ | `cat` 会无差别输出整个文件，大日志会刷屏并造成额外 I/O。先用 `ls -lh` 看大小，再用 `head`、`tail`、`less`、`awk`、`grep` 做流式处理。 |
| 如何观察进程地址空间？ | 用 `/proc/<pid>/maps` 看 VMA，用 `/proc/<pid>/smaps` 看每段 RSS/PSS/匿名页/文件页统计。 |
| 如何观察 fd 和文件偏移？ | 用 `/proc/<pid>/fd` 看 fd 指向，用 `/proc/<pid>/fdinfo/<fd>` 看 offset 和 flags。 |
| 如何观察调度延迟？ | 可以用 `perf sched record` 记录调度事件，再用 `perf sched latency` 查看 runnable 后等待运行的延迟。 |
| 如何观察中断和软中断？ | 用 `/proc/interrupts` 看硬中断分布，用 `/proc/softirqs` 看软中断计数，网络路径重点看 `NET_RX` 和 `NET_TX`。 |

## 本篇参考

- 小林 Code《图解系统》第九章：Linux 命令
- Michael Kerrisk, *The Linux Programming Interface*
- Brendan Gregg, *Systems Performance*
- Linux man-pages
- Linux Kernel Documentation: admin-guide, networking, tracing
