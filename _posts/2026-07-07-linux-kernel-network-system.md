---
title: Linux 内核学习笔记：网络系统
date: 2026-07-07 17:59:00 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, Operating System, Network, Socket]
---

这一篇记录网络系统的几个基础问题：Linux 如何收发网络包、零拷贝、I/O 多路复用、Reactor 和 Proactor。Linux 落点放在 socket、`sk_buff`、NAPI、softirq、DMA、page cache、`sendfile()`、epoll、wait queue。

## 问题索引

| 主题 | 本篇记录 |
| --- | --- |
| Linux 如何收发网络包 | TCP/IP 模型、socket、协议栈、网卡驱动、DMA、NAPI |
| 零拷贝 | 传统文件传输、`mmap()`、`sendfile()`、SG-DMA、page cache |
| I/O 多路复用 | select、poll、epoll、等待队列、就绪事件 |
| Reactor / Proactor | 就绪事件模型和完成事件模型 |
| 网络观测 | `ss`、`ip`、`sar`、`tcpdump`、BPF |

## 1. Linux 网络栈：从 socket 到网卡

应用通过 socket syscall 进入内核。内核网络栈处理传输层、网络层、链路层逻辑，最后由网卡驱动和硬件完成收发。

| 层次 | Linux 落点 |
| --- | --- |
| 应用层 | `send()`、`recv()`、`read()`、`write()` |
| socket 层 | socket 对象、等待队列、收发缓冲区 |
| TCP/UDP | 连接状态、拥塞控制、重传、端口 |
| IP | 路由、分片、转发、本机交付 |
| qdisc / TC | 排队规则、流量控制 |
| driver / NIC | 网卡驱动、DMA、Ring Buffer、NAPI |

`sk_buff` 是 Linux 网络包在内核中的核心缓冲结构。收包、发包、协议栈处理、过滤、排队都会反复看到它。

## 2. 收包路径：DMA、中断、NAPI、softirq

收包路径可以压缩成以下阶段。

| 阶段 | 记录 |
| --- | --- |
| NIC 收包 | 网卡收到以太网帧 |
| DMA | 数据写入内存中的 RX ring / buffer |
| IRQ | 网卡触发中断通知 CPU |
| NAPI | 驱动关闭或减少中断，转为轮询一批包 |
| softirq | `NET_RX_SOFTIRQ` 处理网络接收 |
| `sk_buff` | 数据进入内核网络包缓冲结构 |
| 协议栈 | L2/L3/L4 解析，找到 socket |
| socket receive queue | 数据进入 socket 接收队列 |
| 用户态读取 | `recv()` / `read()` 拷贝到用户缓冲区 |

NAPI 解决高包量下中断过多的问题。低流量时中断及时通知；高流量时通过轮询批量处理，减少中断开销。

观察入口：

| 命令 / 路径 | 记录 |
| --- | --- |
| `/proc/interrupts` | 网卡中断分布 |
| `/proc/softirqs` | `NET_RX`、`NET_TX` 计数 |
| `ip -s link` | 网卡收发包、错误、丢包 |
| `ethtool -S <dev>` | 网卡驱动统计 |
| `mpstat -P ALL 1` | 各 CPU softirq 压力 |

## 3. 发包路径：socket 到 NIC

发包从用户态拷贝数据进入内核，再由协议栈封装，排队给网卡驱动。

| 阶段 | 记录 |
| --- | --- |
| syscall | `send()` / `write()` 进入内核 |
| socket send buffer | 数据进入 socket 发送缓冲区 |
| TCP/UDP | 传输层处理 |
| IP | 路由、分片、邻居子系统 |
| qdisc | 排队、限速、调度 |
| driver | 构造描述符，提交 TX ring |
| DMA | NIC 从内存读取数据 |
| NIC 发送 | 网卡发出帧 |

发包性能常和 socket buffer、qdisc、网卡队列、TSO/GSO、checksum offload、CPU affinity、NUMA 等因素有关。

## 4. 零拷贝：文件传输路径

传统文件传输常见代码是从文件 `read()` 到用户缓冲区，再 `write()` 到 socket。路径里有两次 syscall，用户态/内核态切换多，数据也会在内核缓冲区、用户缓冲区、socket 缓冲区之间移动。

| 方式 | 数据路径 | 记录 |
| --- | --- | --- |
| `read()` + `write()` | 文件 -> page cache -> 用户缓冲区 -> socket buffer -> NIC | 通用，但拷贝和切换多 |
| `mmap()` + `write()` | 文件 -> page cache 映射到用户态 -> socket buffer -> NIC | 少一次用户态数据拷贝 |
| `sendfile()` | 文件 page cache -> socket / NIC 路径 | 减少 syscall 和用户态拷贝 |
| SG-DMA | 网卡按描述符从内存分散区域取数据 | 进一步减少 CPU 数据搬运 |

零拷贝讨论里的“零”通常指减少 CPU 参与的数据拷贝，不代表没有 DMA，也不代表完全没有任何元数据复制。`sendfile()`、`splice()`、`io_uring` 等都属于后续值得单独展开的路径。

page cache 在这里很关键。文件数据先进入 page cache，网络发送路径尽量复用这些页，减少用户态中转。

## 5. select、poll、epoll

I/O 多路复用让一个线程同时等待多个 fd 的可读写事件。它解决的是“连接很多时，不给每个连接配一个线程”的问题。

| 接口 | 内核数据结构 / 特点 | 主要代价 |
| --- | --- | --- |
| select | fd_set 位图 | fd 数量受限，需要重复拷贝和扫描 |
| poll | pollfd 数组 | fd 数量限制放宽，仍需线性扫描 |
| epoll | 内核维护关注集合和就绪队列 | 更适合大量连接，接口更复杂 |

epoll 的三个核心 syscall：

| syscall | 作用 |
| --- | --- |
| `epoll_create1()` | 创建 epoll 实例 |
| `epoll_ctl()` | 添加、修改、删除关注 fd |
| `epoll_wait()` | 等待就绪事件 |

epoll 关注两个触发模式。

| 模式 | 记录 |
| --- | --- |
| LT | level-triggered，条件满足时会反复通知 |
| ET | edge-triggered，状态变化时通知，通常配合非阻塞 I/O |

Linux 落点：socket 等待事件最终会接到等待队列和 wakeup。epoll 自己也有 ready list。fd 就绪时，唤醒等待在 epoll 上的线程；线程返回用户态后再主动调用 `read()` / `write()` 完成数据传输。

## 6. Reactor 和 Proactor

Reactor 是就绪事件模型。内核通知应用“某个 fd 可读/可写”，应用再主动执行 `read()` / `write()`。

| Reactor 组件 | 作用 |
| --- | --- |
| Reactor | 监听事件、分发事件 |
| Acceptor | 接收新连接 |
| Handler | 处理读写和业务逻辑 |
| worker pool | 处理耗时任务，避免阻塞事件循环 |

常见结构：

| 模式 | 记录 |
| --- | --- |
| 单 Reactor 单线程 | 实现简单，业务必须很快 |
| 单 Reactor 多线程 | 事件监听集中，业务可分发给线程池 |
| 多 Reactor 多线程 | 主 Reactor 接连接，子 Reactor 处理 I/O |
| 多 Reactor 多进程 | Nginx 一类多进程事件模型可参考 |

Proactor 是完成事件模型。应用提交异步 I/O，内核完成读写后通知应用“操作已完成”。Reactor 关注 ready，Proactor 关注 completion。

| 模型 | 事件含义 | 应用动作 |
| --- | --- | --- |
| Reactor | fd 已就绪 | 应用主动读写 |
| Proactor | I/O 已完成 | 应用处理结果 |

Linux 网络服务大量使用 Reactor/epoll 组合。Linux 的异步 I/O 历史路径比较复杂，现代还需要把 `io_uring` 纳入视野；这里先保留模型边界。

## 7. 网络观测入口

| 方向 | 命令 / 路径 |
| --- | --- |
| 网卡配置和统计 | `ip addr`、`ip -s link`、`ethtool -S <dev>` |
| socket 状态 | `ss -antp`、`ss -s` |
| 路由 | `ip route` |
| 连接和延迟 | `ping`、`traceroute`、`mtr` |
| 吞吐和 PPS | `sar -n DEV 1`、`sar -n TCP,ETCP 1` |
| 抓包 | `tcpdump -i <dev>` |
| 内核事件 | `perf`、ftrace、`bpftrace` |

排查网络问题时，先区分是链路层丢包、协议栈队列、socket backlog、应用读取慢、DNS/路由问题，还是对端问题。

## 压缩表

| 概念 | 基础概念 / 八股 | Linux 落点 |
| --- | --- | --- |
| 收包 | 网卡到应用 | DMA、IRQ、NAPI、softirq、`sk_buff`、socket queue |
| 发包 | 应用到网卡 | socket buffer、TCP/IP、qdisc、driver、TX ring |
| 零拷贝 | 减少上下文切换和 CPU 拷贝 | `sendfile()`、`splice()`、page cache、SG-DMA |
| select/poll | 线性关注集合 | syscall 拷贝、线性扫描 |
| epoll | 内核维护关注集合和就绪队列 | epoll instance、ready list、wait queue |
| Reactor | 就绪事件模型 | epoll + nonblocking I/O |
| Proactor | 完成事件模型 | async I/O、completion event |

## 检查点与参考回答

| 问题 | 参考回答 |
| --- | --- |
| Linux 收包大致经过哪些阶段？ | NIC 收包后通过 DMA 写入内存，触发中断，驱动通过 NAPI/softirq 批量处理，构造 `sk_buff`，协议栈解析后放入 socket 接收队列，应用通过 `recv()` 读取。 |
| NAPI 解决什么问题？ | NAPI 结合中断和轮询，在高包量下减少中断频率，批量处理网络包，降低 CPU 被中断打散的开销。 |
| `sk_buff` 是什么？ | `sk_buff` 是 Linux 网络包在内核中的核心缓冲结构，收包、发包、协议栈处理、过滤、排队都围绕它展开。 |
| 零拷贝减少的是什么？ | 主要减少用户态和内核态之间的数据拷贝，以及部分 syscall 切换和 CPU 数据搬运。数据仍会通过 DMA 在设备和内存之间传输。 |
| select、poll、epoll 的核心差异是什么？ | select 使用 fd_set 位图，poll 使用数组，二者都需要线性扫描；epoll 在内核中维护关注集合和就绪队列，更适合大量连接。 |
| ET 和 LT 怎么区分？ | LT 在条件满足时会持续通知；ET 只在状态变化时通知，通常要求 fd 设置非阻塞，并循环读写到 `EAGAIN`。 |
| Reactor 和 Proactor 的区别是什么？ | Reactor 通知 fd 已就绪，应用主动读写；Proactor 通知 I/O 已完成，应用直接处理完成结果。 |

## 本篇参考

- Linux Kernel Documentation: Networking
- Linux Kernel Documentation: BPF and XDP
- Michael Kerrisk, *The Linux Programming Interface*
- W. Richard Stevens, *UNIX Network Programming*
- Brendan Gregg, *Systems Performance*
