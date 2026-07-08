---
title: Linux 内核学习笔记：硬件结构阅读批注
date: 2026-07-07 17:05:00 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, Operating System, CPU, Cache, Interrupt]
---

这一篇按小林 Code《图解系统》第一章“硬件结构”的顺序做阅读批注。硬件结构在这组 Linux 笔记里只服务几个后续问题：CPU 如何执行和切换任务，内存层次怎样影响系统性能，Cache 和锁为什么相关，中断和软中断怎样把硬件事件接进内核。

## 问题索引

| 小林 Code 主题 | 本篇记录 |
| --- | --- |
| CPU 是如何执行程序的 | 指令、寄存器、程序计数器、内存、总线 |
| 存储器金字塔 | 寄存器、Cache、内存、SSD/HDD 的速度和容量层次 |
| 如何写出让 CPU 跑得更快的代码 | 局部性、Cache 命中、分支和多核亲和性 |
| CPU 缓存一致性 | 写直达、写回、脏数据、MESI、总线嗅探 |
| CPU 是如何执行任务的 | 任务切换、伪共享、调度类、运行队列 |
| 软中断 | 中断、软中断、网络收包、`/proc/softirqs` |
| 浮点数 | 补码、二进制小数、IEEE 754，作为计算机组成复习 |

## 1. CPU 执行程序：指令、寄存器、PC

程序运行时，CPU 按指令流推进。最小模型里需要记住四个对象：

| 对象 | 作用 |
| --- | --- |
| 指令 | CPU 能执行的操作，例如加载、存储、运算、跳转 |
| 寄存器 | CPU 内部最快的临时存储，保存操作数、地址、状态 |
| 程序计数器 | 记录当前或下一条要执行的指令位置 |
| 内存 | 保存指令和数据，CPU 通过地址访问 |

OS 里的“上下文”就从这里来。一个任务被切走时，内核必须保存足够的 CPU 状态；任务再次运行时，CPU 要恢复这些状态，才能从原来的位置继续执行。

Linux 批注：

| OS 概念 | Linux 落点 |
| --- | --- |
| CPU 上下文 | 寄存器、栈指针、指令位置、架构相关线程状态 |
| 进程/线程切换 | `schedule()`、`context_switch()`、架构相关 switch 代码 |
| 用户态进入内核态 | syscall、exception、interrupt 入口 |
| 当前执行实体 | `current`、`task_struct` |

源码入口：

| 路径 | 关注点 |
| --- | --- |
| `arch/x86/entry/` | syscall、异常、中断入口 |
| `kernel/sched/core.c` | 调度入口和上下文切换主路径 |
| `include/linux/sched.h` | `task_struct` |

八股回答可以压缩成一句：CPU 执行程序依赖指令、寄存器、程序计数器和内存；OS 做任务切换时要保存和恢复这些执行状态。

## 2. 冯诺依曼模型和 OS 视角

冯诺依曼模型把计算机分成处理器、存储器、输入设备、输出设备和总线。OS 学习里更常用下面这个映射：

| 硬件部件 | OS 管理对象 | Linux 入口 |
| --- | --- | --- |
| CPU | 调度、上下文切换、抢占、中断 | `kernel/sched/`、`/proc/stat` |
| 内存 | 虚拟内存、页表、物理页分配、缓存 | `mm/`、`/proc/meminfo` |
| 存储设备 | 文件系统、块层、page cache、I/O 调度 | `fs/`、`block/` |
| 网络设备 | 网卡驱动、中断、NAPI、协议栈 | `net/`、`drivers/net/` |
| 总线和设备 | driver model、DMA、IRQ | `/sys`、`drivers/` |

这张表后续会反复出现。OS 教材里的虚拟化、并发、持久化，本质上都要落到 CPU、内存和设备上。

## 3. 存储器金字塔：速度、容量、局部性

存储层次从快到慢大致是：寄存器、L1/L2/L3 Cache、内存、SSD/HDD。越靠近 CPU，速度越快、容量越小、价格越高。

| 层次 | OS/Linux 中的体现 |
| --- | --- |
| 寄存器 | 上下文切换保存和恢复 |
| CPU Cache | 锁、共享数据、伪共享、调度亲和性 |
| 内存 | 页分配、匿名页、文件页、page cache |
| SSD/HDD | 块设备、文件系统、I/O 调度 |

局部性是 Cache 能工作的基础：

| 局部性 | 含义 | 例子 |
| --- | --- | --- |
| 时间局部性 | 最近访问过的数据很可能再次访问 | 循环里反复使用变量 |
| 空间局部性 | 访问某地址后，很可能访问相邻地址 | 顺序遍历数组 |

Linux 批注：

| 现象 | 解释入口 |
| --- | --- |
| 顺序读文件比随机读快 | page cache、预读、磁盘访问模式 |
| 顺序遍历数组比链表友好 | Cache line 和空间局部性 |
| 多线程共享变量性能差 | Cache line 竞争、伪共享 |
| 同一个任务迁移到别的 CPU 可能变慢 | Cache 热数据和 CPU affinity |

观测入口：

| 命令 | 记录 |
| --- | --- |
| `lscpu` | CPU、核心、Cache 层次 |
| `perf stat` | cache miss、branch miss、cycles 等事件 |
| `numactl --hardware` | NUMA 节点和内存距离 |

## 4. Cache 命中和代码写法

小林 Code 这一节的核心问题是怎样提升 CPU Cache 命中率。OS/Linux 笔记里只保留和系统机制直接相关的点。

| 问题 | 批注 |
| --- | --- |
| 数据 Cache 命中率 | 顺序访问、紧凑布局、减少随机指针追踪 |
| 指令 Cache 命中率 | 热路径保持紧凑，减少复杂分支和冷路径污染 |
| 多核 Cache 命中率 | 减少跨 CPU 迁移，注意 CPU affinity 和 NUMA |

系统层面的落点：

| Linux 机制 | 为什么相关 |
| --- | --- |
| 调度器负载均衡 | task 迁移会影响 Cache 热数据 |
| CPU affinity | 把任务限制在一组 CPU，减少迁移 |
| NUMA 策略 | CPU 访问本地节点内存更快 |
| per-CPU 变量 | 减少多核共享写同一 Cache line |

这部分不需要背很多代码优化技巧。Linux 内核学习里更重要的是知道：Cache miss、任务迁移、锁竞争、共享写都能变成真实性能问题。

## 5. 缓存一致性：写直达、写回、MESI

CPU 写数据通常先写 Cache，再按策略写回内存。常见两种策略：

| 策略 | 记录 |
| --- | --- |
| 写直达 | 写 Cache 时同步写内存，简单但慢 |
| 写回 | 先写 Cache，之后替换或刷出时再写内存，性能更好但需要脏数据管理 |

多核下，每个核心都有自己的 Cache。同一个内存地址可能被多个核心缓存，写共享数据时就需要缓存一致性协议。

MESI 四种状态：

| 状态 | 记录 |
| --- | --- |
| Modified | 当前 Cache line 被修改，内存中是旧值 |
| Exclusive | 只有当前核心缓存，且和内存一致 |
| Shared | 多个核心缓存，且和内存一致 |
| Invalid | 当前 Cache line 失效 |

Linux 批注：

| 内核机制 | 和缓存一致性的关系 |
| --- | --- |
| spinlock / mutex | 锁变量会在多个 CPU 间竞争 Cache line |
| atomic 操作 | 依赖硬件原子指令和缓存一致性 |
| memory barrier | 控制 CPU/编译器重排带来的可见性问题 |
| RCU | 减少读侧共享写和锁竞争 |
| per-CPU 数据 | 把共享写拆到每个 CPU 自己的数据上 |

后续同步章节会继续展开：锁的成本不仅是“排队等待”，还有 Cache line 在核心之间来回失效和同步。

## 6. 伪共享：多线程性能问题的硬件根源

伪共享发生在两个核心频繁写不同变量，但这些变量落在同一个 Cache line 里。硬件以 Cache line 为一致性单位，一个核心写入会让其他核心对应 line 失效，即使两个线程写的字段在逻辑上无关。

最小模型：

```text
Cache line
  |
  +-- counter_a   CPU0 频繁写
  +-- counter_b   CPU1 频繁写
```

解决思路是让高频写字段分散到不同 Cache line，常见做法是 padding、对齐、per-CPU 数据。

Linux 批注：

| 场景 | 相关机制 |
| --- | --- |
| 每 CPU 统计计数 | per-CPU counter |
| 网络收包统计 | 每队列、每 CPU 统计减少共享写 |
| 调度器 runqueue | 每 CPU runqueue 降低全局锁竞争 |
| 内核结构体布局 | 热字段、只读字段、频繁写字段分开考虑 |

## 7. CPU 如何选择线程：从硬件切到调度器

CPU 本身只会执行当前指令流。哪个 task 运行由 OS 调度器决定。

小林 Code 在硬件结构里已经引出调度类、完全公平调度、CPU 运行队列和优先级。这里先记录接口，不展开算法。

| 概念 | Linux 批注 |
| --- | --- |
| 调度类 | 不同任务类型使用不同调度策略，例如普通任务、实时任务 |
| CFS / EEVDF | 普通任务调度的核心策略，后续调度章节展开 |
| CPU runqueue | 每个 CPU 有自己的可运行任务集合 |
| 优先级 / nice | 影响普通任务权重和 CPU 时间分配 |
| 抢占 | 当前 task 可能因为时间片、优先级、唤醒事件让出 CPU |

观测入口：

| 命令 | 记录 |
| --- | --- |
| `ps -eo pid,ni,pri,stat,comm` | nice、priority、状态 |
| `taskset -p <pid>` | CPU affinity |
| `perf sched record -- sleep 3` | 调度事件 |
| `perf sched latency` | 调度延迟 |

## 8. 中断和软中断

中断让外部事件打断当前 CPU 执行，进入内核处理路径。软中断用于把一部分工作延后处理，避免硬中断路径做太多事。

| 类型 | 记录 |
| --- | --- |
| 硬中断 | 设备或定时器触发，进入 IRQ handler |
| 软中断 | 内核延后处理的一类机制，网络收发常见 |
| tasklet / workqueue | 其他 deferred work 机制 |
| NAPI | 网络驱动里结合中断和轮询的收包机制 |

网络收包的简化路径：

```text
网卡收到包
  -> DMA 写入内存
  -> 硬中断通知 CPU
  -> NAPI/softirq 继续处理
  -> 协议栈
  -> socket receive queue
```

观测入口：

| 命令 / 路径 | 用途 |
| --- | --- |
| `/proc/interrupts` | 看硬中断分布 |
| `/proc/softirqs` | 看软中断计数 |
| `top` | 观察 `si` 软中断 CPU 占比 |
| `mpstat -P ALL 1` | 看每个 CPU 的中断和软中断压力 |
| `perf top` | 看内核热点 |

后续设备管理和网络系统会继续展开中断上下文、软中断、NAPI、workqueue 的边界。

## 9. 浮点数：作为组成原理复习

小林 Code 第一章最后讲补码和浮点数。它对 Linux 内核主线的关系较弱，但对理解计算机组成和程序行为有用。

| 问题 | 记录 |
| --- | --- |
| 负数为什么用补码 | 统一加减法电路，简化硬件实现 |
| 小数怎么转二进制 | 很多十进制小数无法被有限二进制精确表示 |
| 浮点数怎么存 | 符号位、指数、尾数 |
| 为什么 `0.1 + 0.2 != 0.3` | 十进制小数转二进制浮点后通常是近似值 |

这部分后续不作为 Linux 内核重点，只保留为“程序结果为什么和直觉不同”的基础知识。

## 压缩表

| 硬件概念 | OS/Linux 连接点 |
| --- | --- |
| 寄存器、程序计数器 | 上下文切换、syscall 返回、异常恢复 |
| Cache line | 伪共享、锁竞争、per-CPU 数据 |
| 存储层次 | page cache、reclaim、I/O 性能 |
| 多核 | runqueue、CPU affinity、NUMA、负载均衡 |
| 中断 | IRQ、softirq、NAPI、设备驱动 |
| 浮点表示 | 程序语言和计算机组成基础 |

## 检查点与参考回答

| 问题 | 参考回答 |
| --- | --- |
| CPU 执行程序至少依赖哪些状态？ | 指令、寄存器、程序计数器、内存。OS 做上下文切换时要保存和恢复足够的 CPU 执行状态。 |
| 存储器金字塔和 OS 有什么关系？ | OS 通过调度、缓存、页管理和 I/O 路径协调不同速度的存储层次。page cache、TLB、CPU Cache、磁盘 I/O 都来自这条层次差异。 |
| Cache line 为什么会影响多线程性能？ | 缓存一致性以 Cache line 为单位。多个 CPU 频繁写同一 line 会导致失效和同步，即使写的是不同变量，也可能发生伪共享。 |
| 写直达和写回怎么区分？ | 写直达每次写 Cache 都同步写内存；写回先更新 Cache，等替换或刷新时再写内存，性能更好但需要脏数据管理。 |
| 中断和软中断怎么区分？ | 硬中断由设备或定时器触发，路径应尽量短；软中断由内核延后处理部分工作，网络收发路径中很常见。 |
| CPU 如何“选择线程”？ | CPU 只执行当前指令流，选择哪个 task 运行由 OS 调度器完成。Linux 中要看调度类、runqueue、优先级、负载均衡和抢占。 |

## 本篇参考

- 小林 Code《图解系统》第一章：硬件结构
- Remzi H. Arpaci-Dusseau and Andrea C. Arpaci-Dusseau, *Operating Systems: Three Easy Pieces*
- Randal E. Bryant, David R. O'Hallaron, *Computer Systems: A Programmer's Perspective*
- Brendan Gregg, *Systems Performance*
- Linux Kernel Documentation
