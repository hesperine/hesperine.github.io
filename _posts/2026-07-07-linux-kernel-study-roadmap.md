---
title: Linux 内核学习路线：从 OS 抽象到真实机制
date: 2026-07-07 17:00:00 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, Operating System, OSTEP, BPF]
---

这组笔记按能力组织，不按名词清单组织。每个主题都保留 OS 抽象、Linux 实现、真实路径、观测入口和术语检查点。

固定结构：

```text
1. OS 抽象
2. Linux 对应对象
3. 一条真实路径
4. 术语表 / 八股检查点
5. 可观测入口
6. 源码入口
7. 例子或最小模型
```

名词需要记，但名词放在路径之后整理。正文先回答“这个机制怎么走”，术语表再回答“这个词怎么定义、和相邻概念有什么边界”。这样既能读源码，也能应付面试里的概念题。

参考 OSTEP 的大结构：虚拟化、并发、持久化。Linux 侧补真实对象：`task_struct`、`mm_struct`、VMA、页表、`struct file`、inode、VFS、page cache、runqueue、wait queue、futex、RCU、tracepoint、BPF。

资料分层：

| 层次 | 用法 | 主要资料 |
| --- | --- | --- |
| OS 概念 | 建立抽象和基本模型 | OSTEP、CSAPP、Operating System Concepts |
| Linux 用户态接口 | 确认 syscall、进程、fd、信号等语义 | TLPI、APUE、man-pages |
| Linux 内核实现 | 确认结构体、路径、锁和实现边界 | Linux Kernel Documentation、Linux 源码、Linux Kernel Development |
| 性能与观测 | 把机制接到真实机器和工具 | Systems Performance、perf/ftrace/BPF 文档 |
| 八股与图解 | 整理高频问法、术语边界和面试表达 | 小林 Code《图解系统》、常见 OS/Linux 面经 |

每章最后的术语表会对齐八股问法，但正文的实现判断以 Linux 官方文档、源码和经典书籍为主。

## 模块主线

这组笔记按六个系统模块推进。小林 Code《图解系统》适合用来整理高频问题和图解脉络；Linux 笔记负责把这些问题落到真实结构体、路径和观测工具上。

| 模块 | 先掌握的问题 | Linux 落点 | 对应章节 |
| --- | --- | --- | --- |
| 进程管理 | 进程和线程区别、进程状态、进程创建、进程退出、进程间通信 | `task_struct`、pid/tgid、`fork()`、`clone()`、`execve()`、`exit()`、signal、pipe/socket/futex | 1、2、3、8、11 |
| 调度系统 | 调度算法、上下文切换、阻塞和唤醒、抢占、多核调度 | task state、`rq`、scheduling class、CFS/EEVDF、`schedule()`、`try_to_wake_up()` | 1、3、4、8 |
| 内存管理 | 虚拟内存、分页、页表、缺页、页面置换、内存分配 | `mm_struct`、VMA、page table、page fault、`mmap()`、COW、`struct page`、buddy/slub、reclaim | 1、2、5、6 |
| 文件系统 | fd、文件系统层次、inode、目录项、缓存、文件读写 | `files_struct`、`struct file`、dentry、inode、VFS、page cache、writeback | 2、7 |
| 设备管理 | 中断、DMA、驱动、字符设备、块设备、异步处理 | IRQ、softirq、workqueue、driver model、device file、block layer、request queue | 7、9 |
| 网络系统 | socket、TCP/IP、收发包、I/O 多路复用、网络观测 | socket、`sk_buff`、NAPI、TCP/IP、epoll、netfilter、qdisc、XDP/tc BPF | 10、12 |

每个模块的写法保持一致：

```text
小林 Code / 八股问题
  -> OS 抽象
  -> Linux 对象
  -> 一条真实路径
  -> 观测命令
  -> 源码入口
  -> 参考回答
```

例如“进程和线程的区别”不会只停在概念回答，而是继续落到 `task_struct`、`mm_struct`、`files_struct`、pid/tgid、`clone()` flags 和 `/proc/<pid>/task`。 “虚拟内存有什么用”会继续落到 VMA、页表、page fault、COW、`/proc/<pid>/maps`。 “epoll 为什么高效”会放到网络系统和文件描述符模型里，再接 socket wait queue 和 wakeup。

## 0. 环境与观察工具

能力：知道一台 Linux 机器能看什么、从哪里看。

内容：`uname`、`/proc`、`/sys`、内核配置、`strace`、`perf`、ftrace、tracefs、`bpftrace`。

术语：procfs、sysfs、tracefs、tracepoint、kprobe、uprobe、perf event、BPF program、capability。

产出：后续每章都能找到至少一种用户态观察入口。

## 1. OS 基本抽象复习

能力：把 OS 课里的词和 Linux 对象对上。

内容：用户态 / 内核态，进程 / 线程 / 协程 / task，地址空间，文件描述符，系统调用，异常 / 中断，上下文切换，阻塞 / 唤醒。

术语：process、thread、task、address space、virtual address、page table、fd、syscall、exception、interrupt、context switch、kernel stack、user stack。

产出：能解释“进入内核态”和“上下文切换”的区别，能解释 fd、地址空间、task 的边界。

## 2. 系统调用与 read() 路径

能力：从一行 `read(fd, buf, count)` 追到内核对象。

内容：syscall entry、`current`、`task_struct`、`files_struct`、fdtable、`struct file`、VFS、`copy_to_user()`、page fault、wait queue、`schedule()`。

术语：syscall number、syscall ABI、`current`、fdtable、VFS、`file_operations`、user pointer、`EFAULT`、blocking I/O、wait queue。

产出：能画出 `read()` 的对象链，能用 `strace`、`/proc/<pid>/fd`、`perf sched` 看其中一部分。

## 3. 进程模型与 task 生命周期

能力：理解 Linux 如何创建、运行、替换、退出和回收执行实体。

内容：`task_struct`、pid/tgid、thread group、`fork()`、`clone()` / `clone3()`、`pthread_create()`、`execve()`、`exit()`、`wait()`、zombie、signal。

术语：pid、tgid、thread group、COW、`CLONE_VM`、`CLONE_FILES`、`CLONE_THREAD`、zombie、orphan、reparent、signal mask、pending signal。

产出：能解释进程和线程在 Linux 里的资源共享差异，能沿 `clone -> exec -> exit -> wait` 读源码。

## 4. 调度器、阻塞与唤醒

能力：理解 task 怎样让出 CPU、怎样被唤醒、怎样再次运行。

内容：task state、runqueue、scheduling class、CFS / EEVDF、real-time scheduling、preemption、wakeup、scheduling latency、多 CPU 负载均衡。

术语：runnable、running、sleeping、`rq`、`sched_entity`、`vruntime`、nice、weight、time slice、preemption、affinity、migration、`sched_switch`、`sched_wakeup`。

产出：能区分睡眠等待事件和 runnable 后等待 CPU，能用 `perf sched` 或 BPF tracepoint 观察调度延迟。

## 5. 虚拟内存、VMA 与 page fault

能力：理解虚拟地址如何变成物理页。

内容：`mm_struct`、`vm_area_struct`、page table、page fault、`mmap()`、anonymous mapping、file-backed mapping、copy-on-write、TLB。

术语：virtual address、physical page、PTE、VMA、RSS、PSS、minor fault、major fault、COW、TLB shootdown、anonymous page、file-backed page。

产出：能解释 `mmap` 区域是什么，能从 `/proc/<pid>/maps` 对应到 VMA。

## 6. 物理内存管理

能力：理解机器上的物理页怎么分配、缓存、回收。

内容：`struct page`、NUMA node、zone、buddy allocator、slub、LRU、reclaim、swap、OOM killer。

术语：page frame、zone、node、order、slab、slub、LRU、active/inactive list、reclaim、compaction、OOM。

产出：能把“进程内存大”和“系统物理内存紧张”分开看。

## 7. 文件系统、VFS 与 page cache

能力：理解 fd、路径名、inode、缓存页之间的关系。

内容：fd、`struct file`、dentry、inode、superblock、path lookup、mount、`file_operations`、page cache、buffered I/O、direct I/O、writeback。

术语：fd、open file description、dentry、inode、superblock、mount namespace、page cache、dirty page、writeback、direct I/O。

产出：能解释 `open()` 两次同一文件、`fork()` 继承 fd、文件偏移共享的差异。

## 8. 同步、锁、futex 与 RCU

能力：理解并发路径里谁能睡眠、谁只能自旋、谁依赖读侧无锁。

内容：pthread mutex、condition variable、futex、wait queue、spinlock、mutex、rwsem、atomic、memory barrier、RCU、completion。

术语：critical section、race condition、deadlock、futex wait/wake、spinlock、sleepable lock、memory ordering、RCU read-side、grace period。

产出：能解释用户态锁为什么大多数时候不进内核，竞争时怎样落到 futex。

## 9. 设备管理、中断与 deferred work

能力：理解设备怎样接入内核，硬件事件怎样进入内核，以及为什么很多工作要延后处理。

内容：设备文件、字符设备、块设备、driver model、DMA、IRQ、softirq、tasklet、workqueue、timer / hrtimer、NAPI。

术语：device driver、character device、block device、major/minor number、DMA、interrupt context、process context、top half、bottom half、softirq、workqueue、timer wheel、hrtimer、NAPI polling。

产出：能解释用户态 fd 怎样连到设备文件，能解释中断上下文为什么不能随便睡眠，能把设备事件接到 deferred work。

## 10. 网络栈

能力：理解 packet 从网卡到 socket 的主要路径。

内容：socket、`sk_buff`、NAPI、TCP/IP、netfilter、qdisc、tc、XDP。

术语：socket buffer、RX/TX queue、NAPI、GRO/GSO、qdisc、netfilter hook、XDP、tc BPF。

产出：为 BPF/XDP 和网络性能观测铺底。

## 11. namespace、cgroup 与容器

能力：理解容器依赖的隔离和资源控制机制。

内容：pid namespace、mount namespace、network namespace、user namespace、cgroup v2、cpu controller、memory controller、io controller。

术语：namespace、cgroup、controller、quota、weight、pressure stall information、container runtime。

产出：能解释 namespace 管“看见什么”，cgroup 管“能用多少”。

## 12. tracing、perf 与 BPF

能力：把前面学过的机制接到观测和扩展点上。

内容：procfs、sysfs、debugfs、tracefs、ftrace、perf、tracepoint、kprobe、uprobe、BPF map、helper、verifier、BTF、CO-RE、libbpf。

术语：tracepoint、kprobe、uprobe、perf event、BPF map、helper、verifier、BTF、CO-RE、XDP、LSM BPF、sched_ext。

产出：能写短的 `bpftrace` 观察 syscall、调度、I/O、网络事件。

## 13. 内核开发方法

能力：能读源码、改配置、做小实验、定位崩溃。

内容：源码树结构，Kconfig / Makefile，kernel module，QEMU / VM，dynamic debug，panic / oops，patch workflow。

术语：Kconfig、module、symbol、GPL export、oops、panic、taint、bisect、patch。

产出：能把学习从“读文章”推进到“读源码和做实验”。

## 参考资料

- [Operating Systems: Three Easy Pieces](https://pages.cs.wisc.edu/~remzi/OSTEP/)
- [Linux Kernel Documentation](https://docs.kernel.org/)
- [Linux Kernel Labs](https://linux-kernel-labs.github.io/refs/heads/master/)
- [小林 Code：图解系统](https://xiaolincoding.com/os/)
- Michael Kerrisk, *The Linux Programming Interface*
- Robert Love, *Linux Kernel Development*
- Brendan Gregg, *Systems Performance*
- W. Richard Stevens, Stephen A. Rago, *Advanced Programming in the UNIX Environment*
- Randal E. Bryant, David R. O'Hallaron, *Computer Systems: A Programmer's Perspective*
