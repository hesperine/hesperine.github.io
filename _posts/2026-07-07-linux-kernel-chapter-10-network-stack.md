---
title: Linux 内核学习笔记（十）：网络系统、socket 与收发包路径
date: 2026-07-07 17:56:00 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, Network, Socket, TCP, XDP]
---

网络系统把应用的 socket I/O 接到协议栈、队列、网卡驱动和中断/NAPI。小林 Code 里的网络八股通常从 TCP/IP、三次握手、四次挥手、拥塞控制、epoll 开始；Linux 笔记要继续落到 socket、`sk_buff`、wait queue、NAPI、qdisc、netfilter 和 BPF hook。

## OS 抽象

网络 I/O 是异步事件密集的 I/O。应用通过 socket fd 读写字节流或数据报；内核负责协议处理、缓冲、重传、拥塞控制、路由、排队、网卡收发。

```text
应用
  |
  v
socket fd
  |
  v
协议栈 TCP/IP
  |
  v
队列 / qdisc / driver
  |
  v
NIC
```

socket 仍然是 fd。它能接入 `read()`、`write()`、`poll()`、`epoll()`，所以网络系统和文件描述符、等待队列、调度器直接相连。

## Linux 对象

| 对象 | 记录 |
| --- | --- |
| socket fd | 用户态 handle |
| `struct socket` | VFS socket 对象 |
| `struct sock` | 协议栈内部 socket 状态 |
| `sk_buff` | 网络包在内核里的核心 buffer |
| netdev | 网络设备 |
| qdisc | 发送队列调度 |
| NAPI | 中断和轮询结合的收包机制 |
| netfilter | 网络协议栈 hook 框架 |
| XDP | 驱动收包早期 BPF hook |
| tc | qdisc 层 BPF hook |

`sk_buff` 是网络栈核心对象。收包、协议解析、转发、发包都围绕 skb 流转。

## socket read 路径

应用读取 socket：

```text
read(socket_fd)
  |
  v
fdtable -> struct file
  |
  v
socket file operations
  |
  v
struct socket / struct sock
  |
  +-- receive queue 有数据 -> copy_to_user()
  |
  +-- 没有数据 -> 挂 wait queue -> schedule()
```

数据到达后，网络收包路径把数据放入 socket receive queue，并唤醒等待者。被唤醒的 task 变成 runnable，之后由调度器选中继续执行 `read()`。

## 收包路径

简化收包：

```text
NIC 收到包
  |
  v
IRQ
  |
  v
NAPI poll
  |
  v
driver 构造 skb
  |
  v
协议栈处理
  |
  +-- TCP/UDP
  |
  v
socket receive queue
  |
  v
wake_up()
```

NAPI 的作用是把高频收包从每包中断变成中断触发后的批量轮询，降低中断风暴开销。

## 发包路径

简化发包：

```text
write(socket_fd)
  |
  v
TCP/UDP send path
  |
  v
构造 skb
  |
  v
路由 / netfilter
  |
  v
qdisc
  |
  v
driver
  |
  v
NIC 发送
```

TCP 还要处理发送窗口、拥塞控制、重传、ACK、MSS、分段等。这里记录对象链，具体 TCP 机制后续按网络专题继续展开。

## epoll

epoll 是 I/O 多路复用机制。它让一个线程同时等待多个 fd 的事件。socket 没数据时，线程不需要轮询每个 fd；内核在事件发生时把 ready fd 放到就绪队列。

```text
epoll_ctl 添加 fd
  |
  v
fd 事件挂到等待结构
  |
  v
epoll_wait 睡眠
  |
  v
socket 到数据
  |
  v
唤醒 epoll 等待者
```

epoll 的高效来自事件驱动和就绪队列，不是每次都线性扫描所有 fd。

## 术语表 / 八股检查点

| 名词 | 记录 |
| --- | --- |
| socket | 网络通信端点 |
| TCP | 面向连接、可靠字节流协议 |
| UDP | 无连接数据报协议 |
| `sk_buff` | Linux 网络包 buffer |
| NAPI | 中断 + 轮询的收包机制 |
| qdisc | 队列规则，控制发包排队 |
| netfilter | 协议栈 hook 框架 |
| XDP | 驱动早期收包 hook |
| tc | traffic control |
| epoll | I/O 多路复用机制 |
| receive queue | socket 接收队列 |
| backlog | 待处理连接或包队列 |

## 观测入口

```bash
ss -tnp
ip addr
ip route
ip -s link
cat /proc/net/dev
```

socket 和 syscall：

```bash
strace -e socket,bind,listen,accept,connect,sendto,recvfrom,epoll_wait ./program
```

网络性能：

```bash
sar -n DEV 1
ss -ti
sudo tcpdump -i <iface>
```

BPF / tracepoint：

```bash
sudo bpftrace -e 'tracepoint:syscalls:sys_enter_recvfrom { @[comm] = count(); }'
```

## 源码入口

| 路径 | 内容 |
| --- | --- |
| `net/socket.c` | socket syscall 和 VFS 接口 |
| `include/net/sock.h` | `struct sock` |
| `include/linux/skbuff.h` | `sk_buff` |
| `net/core/dev.c` | 网络设备收发核心 |
| `net/ipv4/tcp*.c` | TCP |
| `net/ipv4/udp.c` | UDP |
| `net/core/filter.c` | BPF hook 相关路径之一 |

## 本章检查点与参考回答

| 问题 | 参考回答 |
| --- | --- |
| socket 为什么也是 fd？ | Linux 把 socket 接入 VFS/file 接口，用户态拿到的是 fd，因此可以用 read/write/poll/epoll/close 等统一接口操作 socket。 |
| `sk_buff` 是什么？ | `sk_buff` 是 Linux 网络栈表示网络包的核心结构，携带数据、协议头位置、设备、路由和元数据。 |
| NAPI 解决什么问题？ | NAPI 把高频收包从每包中断改成中断触发后的批量 poll，降低中断开销，提高吞吐。 |
| epoll 为什么比简单轮询高效？ | epoll 把 fd 注册到内核等待结构，事件发生时进入就绪队列；`epoll_wait()` 返回就绪 fd，不需要每次扫描所有 fd。 |
| XDP 和 tc BPF 大致挂在哪里？ | XDP 挂在驱动收包早期，位置更靠近网卡；tc BPF 挂在 qdisc/traffic control 层，位置更靠近协议栈队列。 |

## 本章参考

- [Linux kernel documentation: Networking](https://docs.kernel.org/networking/index.html)
- [Linux kernel documentation: BPF](https://docs.kernel.org/bpf/)
- [小林 Code：图解网络](https://xiaolincoding.com/network/)
- Michael Kerrisk, *The Linux Programming Interface*
- Brendan Gregg, *Systems Performance*
