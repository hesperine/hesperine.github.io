---
title: Linux 内核学习笔记：调度算法阅读批注
date: 2026-07-07 17:45:00 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, Operating System, Scheduler, Page Replacement]
---

这一篇按小林 Code《图解系统》第五章“调度算法”的顺序记：进程调度算法、页面置换算法、磁盘调度算法。三个主题都叫调度，但问题对象不同：CPU 调度在 runnable task 里选谁运行，页面置换在内存页里选谁回收，磁盘调度在 I/O 请求里选处理顺序。

## 问题索引

| 小林 Code 主题 | 本篇记录 |
| --- | --- |
| 进程调度算法 | FCFS、SJF、HRRN、RR、优先级、多级反馈队列 |
| 页面置换算法 | OPT、FIFO、LRU、Clock、LFU |
| 磁盘调度算法 | FCFS、SSTF、SCAN、C-SCAN、LOOK、C-LOOK |
| Linux 批注 | CPU scheduler、memory reclaim、block layer、I/O scheduler |

## 1. 三种“调度”分别调什么

| 类型 | 被调度对象 | 核心问题 | 典型指标 |
| --- | --- | --- | --- |
| CPU 调度 | runnable 进程/线程/task | 下一个占用 CPU 的执行实体是谁 | 等待时间、响应时间、周转时间、公平性、吞吐 |
| 页面置换 | 物理内存中的页 | 内存不够时回收哪一页 | 缺页率、回收成本、I/O 次数 |
| 磁盘调度 | 块设备 I/O 请求 | 按什么顺序处理请求 | 寻道距离、延迟、吞吐、公平性 |

OSTEP 里 CPU 调度属于 CPU 虚拟化，页面置换属于内存虚拟化，磁盘调度属于持久化和 I/O。三者共通点是“资源有限，请求很多，需要排序”；差别在于资源和代价模型完全不同。

Linux 批注：

| 主题 | Linux 入口 |
| --- | --- |
| CPU 调度 | `kernel/sched/`、`struct rq`、scheduling class、`sched_switch` |
| 页面置换 | `mm/vmscan.c`、LRU、reclaim、swap、page cache |
| 磁盘调度 | `block/`、blk-mq、I/O scheduler、request queue |

## 2. CPU 调度：什么时候需要重新选 task

CPU 调度发生在当前 task 不能继续运行、应该让出 CPU，或有更合适的 task 出现时。

| 场景 | 类型 | 记录 |
| --- | --- | --- |
| 当前 task 结束 | 非抢占 | 需要选下一个 runnable task |
| 当前 task 阻塞等待 I/O / 锁 / 事件 | 非抢占 | 当前 task 离开 runnable 集合 |
| 时间片或调度周期到 | 抢占 | 当前 task 仍可运行，但需要重新公平分配 |
| 更高优先级 task 被唤醒 | 抢占 | 当前 task 可能被切走 |

教材算法通常假设有一个 ready queue，并从队列里选下一个进程。Linux 里对象是 task，每个 CPU 有 runqueue，调度类按优先级组织 deadline、real-time、fair、idle 等路径。

## 3. FCFS：按到达顺序处理

FCFS, First Come First Served，按进入就绪队列的顺序运行。它的规则最简单，适合作为基准模型。

| 特点 | 记录 |
| --- | --- |
| 优点 | 实现简单，顺序可解释 |
| 问题 | 长任务在前面会拖住后面的短任务 |
| 典型现象 | convoy effect，短任务等待时间被拉长 |
| 适合模型 | 批处理、请求差异较小时的基准 |

FCFS 的价值在于说明“只按到达顺序”会忽视任务长度和交互性。现代通用 OS 的普通任务调度不会只用 FCFS。

## 4. SJF 和 HRRN：围绕周转时间做权衡

SJF, Shortest Job First，优先运行预计运行时间最短的任务。它能降低平均周转时间，但需要知道或估计运行时间。

| 算法 | 关注点 | 代价 |
| --- | --- | --- |
| SJF | 短作业先运行，降低平均周转时间 | 长作业可能长期等待，运行时间难准确预测 |
| HRRN | 响应比随等待时间增加，兼顾短作业和等待很久的长作业 | 需要计算等待时间和预计服务时间 |

HRRN 的响应比可以记成 `(等待时间 + 服务时间) / 服务时间`。等待越久，响应比越高；服务时间越短，响应比也越高。它比 SJF 更照顾长作业，但仍然偏教材模型。

Linux 批注：Linux 普通任务不按“预计运行总时长”选择。fair class 更关注长期 CPU 份额、权重和可运行实体的虚拟时间；交互延迟通过 wakeup、slice、虚拟期限等机制处理。

## 5. RR：用时间片换响应性

RR, Round Robin，把 CPU 时间切成时间片，队列里的任务轮流运行。一个任务时间片用完后回到队尾。

| 参数 | 影响 |
| --- | --- |
| 时间片太短 | 上下文切换频繁，CPU 时间浪费在切换上 |
| 时间片太长 | 响应性下降，行为接近 FCFS |
| 任务数量多 | 每个任务再次运行的等待时间变长 |

RR 的核心价值是响应性。交互系统中，任务不能长期霸占 CPU。Linux 里的实时 `SCHED_RR` 使用 RR 语义；普通任务的 fair class 不直接等同教材 RR。

## 6. 优先级和多级反馈队列

优先级调度把任务分层，高优先级先运行。它能表达任务重要性，但低优先级任务可能饥饿。

| 类型 | 记录 |
| --- | --- |
| 静态优先级 | 创建后基本不变 |
| 动态优先级 | 根据等待时间、运行行为等调整 |
| 抢占式优先级 | 高优先级 task 到来时可切走当前 task |
| 非抢占式优先级 | 当前 task 主动让出后才切换 |

多级反馈队列 MLFQ 用多条优先级队列组合时间片。新任务通常进入高优先级队列；用完时间片后可能降级；等待时间过长可以提升，避免饥饿。

| 机制 | 作用 |
| --- | --- |
| 多级队列 | 区分短任务、交互任务和长 CPU-bound 任务 |
| 高优先级短时间片 | 提升交互响应 |
| 低优先级长时间片 | 降低长任务切换开销 |
| aging / boost | 防止低优先级长期饥饿 |

Linux 批注：Linux 普通任务用 nice 影响权重，并非简单多级队列。实时任务有 `SCHED_FIFO` 和 `SCHED_RR`，普通任务有 `SCHED_NORMAL`，deadline 任务有 `SCHED_DEADLINE`。调度类之间有严格优先顺序，使用实时策略需要谨慎。

## 7. Linux CPU 调度批注

Linux 调度器直接调度 task。主线对象可以先记这些。

| 对象 / 路径 | 记录 |
| --- | --- |
| `struct rq` | 每 CPU runqueue |
| `task_struct` | 可调度实体总入口 |
| `sched_entity` | 普通任务在 fair class 里的调度实体 |
| `kernel/sched/core.c` | `schedule()`、wakeup、context switch |
| `kernel/sched/fair.c` | 普通任务调度 |
| `kernel/sched/rt.c` | 实时调度 |
| `kernel/sched/deadline.c` | deadline 调度 |

用户态观察入口：

| 命令 | 记录 |
| --- | --- |
| `ps -o pid,tid,cls,rtprio,pri,ni,psr,stat,comm -p <pid>` | 看调度类、优先级、nice、CPU |
| `chrt -p <pid>` | 看或设置实时调度策略 |
| `taskset -pc <pid>` | 看或设置 CPU affinity |
| `pidstat -w 1` | 看上下文切换 |
| `perf sched latency` | 看调度延迟 |

和教材算法的对应关系：

| 教材问题 | Linux 里的落点 |
| --- | --- |
| 就绪队列 | 每 CPU `rq` 和调度类内部队列 |
| 时间片 | fair class 的 slice、实时 RR 时间片等 |
| 优先级 | nice/weight、rt priority、deadline 参数 |
| 抢占 | `need_resched`、wakeup preemption、返回用户态前检查 |
| 饥饿 | 权重、公平性、RT throttling、cgroup quota |

## 8. 页面置换：缺页和回收

页面置换解决的是物理内存不足时回收哪一页。进程访问不在内存中的页会触发 page fault；如果需要物理页而空闲页不足，内核要回收文件页、匿名页，必要时写回或换出。

| 名词 | 记录 |
| --- | --- |
| page fault | 访问页表无有效映射或权限不满足时触发的异常 |
| minor fault | 不需要磁盘 I/O 的缺页处理 |
| major fault | 需要从磁盘读入的缺页处理 |
| reclaim | 内存回收 |
| swap | 匿名页换出到交换空间 |
| page cache | 文件页缓存，可在压力下回收干净页 |

页面置换算法的评价核心是缺页率和回收成本。淘汰未来很快要访问的页，会很快再次缺页；淘汰脏页可能需要写回，成本更高。

## 9. OPT、FIFO、LRU、Clock、LFU

| 算法 | 选择谁换出 | 价值和问题 |
| --- | --- | --- |
| OPT | 未来最久不访问的页 | 理论最优，需要未来信息，实际不可实现 |
| FIFO | 最早进入内存的页 | 实现简单，可能淘汰热点页 |
| LRU | 最久未被访问的页 | 利用时间局部性，精确实现成本高 |
| Clock | 用访问位近似 LRU | 成本低，工程上更接近可用 |
| LFU | 访问次数最少的页 | 关注频率，可能保留过期热点 |

LRU 的直觉来自局部性：最近用过的页，近期还可能再用。精确 LRU 需要维护全局访问顺序，每次访问都更新结构，代价过高。Clock 用访问位做近似，扫描时给访问过的页第二次机会。

Linux 批注：Linux 内存回收并非把教材算法原样塞进内核。它维护匿名页、文件页、active/inactive LRU 等结构，结合访问位、脏页、引用、cgroup、NUMA、swap、page cache 等信息做回收。源码主入口是 `mm/vmscan.c`。

观察入口：

| 命令 / 路径 | 记录 |
| --- | --- |
| `/proc/meminfo` | 系统内存、cache、swap 等 |
| `vmstat 1` | `si/so`、page in/out、内存压力 |
| `/proc/vmstat` | page fault、scan、steal、writeback 等计数 |
| `/proc/<pid>/stat` | minor/major fault 统计 |
| `/proc/<pid>/smaps` | VMA 级别 RSS/PSS/匿名页/文件页 |

## 10. 磁盘调度：请求顺序和寻道成本

磁盘调度的教材模型主要来自机械硬盘：磁头移动有寻道成本，请求顺序会影响总移动距离。SSD/NVMe 的代价模型不同，但块层仍然需要处理队列、公平性、合并、延迟和吞吐。

| 算法 | 选择方式 | 主要问题 |
| --- | --- | --- |
| FCFS | 按请求到达顺序 | 简单公平，寻道距离可能很长 |
| SSTF | 选离当前磁头最近的请求 | 降低寻道，远处请求可能饥饿 |
| SCAN | 磁头像电梯一样单向扫描，到头再反向 | 吞吐较好，中间区域可能更占优 |
| C-SCAN | 只在一个方向服务，到头后回到起点 | 等待时间更均匀 |
| LOOK | SCAN 的优化，只走到最远请求位置 | 减少无意义移动 |
| C-LOOK | C-SCAN 的优化，只在请求范围内循环 | 减少无意义移动 |

Linux 批注：现代 Linux 块层使用 blk-mq，多队列适配多核和现代存储设备。I/O scheduler 的重点已经不只是机械寻道，还包括请求合并、设备队列深度、延迟控制、公平性、cgroup I/O 控制等。常见调度器包括 `mq-deadline`、`bfq`、`kyber`、`none`，具体取决于内核和设备。

观察入口：

| 命令 / 路径 | 记录 |
| --- | --- |
| `cat /sys/block/<dev>/queue/scheduler` | 查看或切换 I/O scheduler |
| `iostat -x 1` | 看设备利用率、await、队列等 |
| `pidstat -d 1` | 看进程 I/O |
| `lsblk -o NAME,ROTA,SCHED,TYPE,SIZE` | 看设备类型和调度器 |
| `blktrace` / `bpftrace` | 深入观察块层事件，依环境可用 |

## 压缩表

| 问题 | 教材算法 | Linux 批注 |
| --- | --- | --- |
| CPU 选谁运行 | FCFS、SJF、HRRN、RR、优先级、MLFQ | `kernel/sched/`、调度类、`rq`、nice、RT、deadline |
| 内存回收哪页 | OPT、FIFO、LRU、Clock、LFU | `mm/vmscan.c`、active/inactive LRU、匿名页/文件页、reclaim |
| 磁盘先处理哪个请求 | FCFS、SSTF、SCAN、C-SCAN、LOOK、C-LOOK | blk-mq、I/O scheduler、request queue、cgroup I/O |

## 检查点与参考回答

| 问题 | 参考回答 |
| --- | --- |
| CPU 调度、页面置换、磁盘调度有什么共同点和区别？ | 共同点是资源有限、请求很多，需要排序。CPU 调度选 runnable task，页面置换选要回收的页，磁盘调度选 I/O 请求顺序。三者代价模型分别是等待/响应、缺页/回收、寻道/队列延迟。 |
| 抢占式调度和非抢占式调度怎么区分？ | 非抢占式调度通常等当前任务结束或阻塞后再选新任务；抢占式调度允许当前任务仍可运行时被切走，例如时间片到期或更高优先级任务被唤醒。 |
| FCFS 的问题是什么？ | 规则简单，但长任务在前面会拖住后面的短任务，导致平均等待时间和响应时间变差。 |
| RR 的时间片怎么影响系统？ | 时间片太短会上下文切换频繁，时间片太长会降低响应性并接近 FCFS。 |
| SJF 为什么难落地？ | 它需要知道或准确预测任务运行时间，实际系统通常无法可靠获得；长任务还可能被短任务长期推迟。 |
| 多级反馈队列解决什么问题？ | 它用多个优先级队列和不同时间片兼顾交互响应、长任务吞吐和饥饿控制。 |
| OPT 页面置换为什么只适合做理论基准？ | OPT 需要知道未来访问序列，真实系统无法提前知道未来访问，所以只能作为评价其他算法的理论上界。 |
| LRU 和 Clock 的关系是什么？ | LRU 淘汰最久未访问页，精确实现成本高；Clock 用访问位近似 LRU，降低维护成本。 |
| Linux 内存回收会直接使用教材 LRU 吗？ | Linux 使用 active/inactive LRU、访问位、匿名页/文件页、脏页、cgroup、NUMA 等信息做近似和工程化回收，并非照搬单一教材算法。 |
| 机械磁盘调度算法对 SSD 还有用吗？ | 机械寻道模型对 SSD/NVMe 不再直接成立，但请求队列、合并、延迟、公平性和吞吐控制仍然存在，Linux 块层和 I/O scheduler 继续处理这些问题。 |

## 本篇参考

- 小林 Code《图解系统》第五章：调度算法
- Remzi H. Arpaci-Dusseau and Andrea C. Arpaci-Dusseau, *Operating Systems: Three Easy Pieces*
- Linux Kernel Documentation: Scheduler
- Linux Kernel Documentation: Memory Management
- Linux Kernel Documentation: Block
- Brendan Gregg, *Systems Performance*
- Robert Love, *Linux Kernel Development*
