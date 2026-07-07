---
title: Linux 内核学习笔记（四）：调度器、runqueue 与唤醒路径
date: 2026-07-07 17:50:00 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, Scheduler, CFS, EEVDF, perf, BPF]
---

调度器管理 CPU 的分配。系统里同时存在多个可执行实体，CPU 核心数量有限，调度器决定当前 CPU 运行哪个实体、运行多久、什么时候切走、被唤醒后放回哪里。

调度问题可以拆成两层。第一层是 OS 抽象：执行实体、状态、上下文、运行队列、阻塞、唤醒、抢占。第二层是 Linux 实现：`task_struct`、`rq`、scheduling class、`schedule()`、`try_to_wake_up()`、`context_switch()`。最小模型实现放在最后，用来对照这些对象在一个小内核里怎样落地。

这一章对应调度系统模块。小林 Code 里的进程调度算法、页面置换算法、磁盘调度算法可以作为算法八股入口；Linux 调度器这一章只展开 CPU 调度，重点放在 task state、runqueue、调度类、上下文切换和唤醒路径。

| 八股问题 | 本章落点 |
| --- | --- |
| 进程调度算法有哪些 | FIFO、RR、优先级、公平调度的取舍 |
| 进程状态怎么转换 | running、runnable、sleeping 与 wakeup |
| 上下文切换做了什么 | 保存 prev，选择 next，恢复 next |
| 抢占是什么 | 当前 task 未主动睡眠时被切走 |
| 调度延迟怎么看 | `sched_wakeup` 到 `sched_switch` 的间隔 |

## 术语表 / 八股检查点

| 名词 | 记录 |
| --- | --- |
| scheduler | 决定当前 CPU 运行哪个 task 的内核组件 |
| runnable | task 已准备好运行，等待 CPU |
| running | task 正在某个 CPU 上执行 |
| sleeping / blocked | task 等待事件，不参与普通 CPU 竞争 |
| runqueue | 可运行 task 的队列或集合 |
| `rq` | Linux 每个 CPU 的 runqueue |
| scheduling class | Linux 按任务类型组织的调度类 |
| CFS | 传统 Linux 普通任务公平调度框架 |
| EEVDF | 当前 fair class 中用于选择普通任务的重要调度逻辑 |
| nice | 普通任务的用户可见优先级调节 |
| weight | nice 映射出的 CPU 份额权重 |
| `vruntime` | 加权运行时间记录 |
| preemption | 当前 task 未主动睡眠时被切走 |
| context switch | CPU 从一个 task 的执行状态切到另一个 task |
| wait queue | 睡眠 task 等待具体事件的队列 |
| wakeup | 事件发生后把 sleeping task 变回 runnable |
| scheduling latency | task runnable 后等待真正运行的时间 |

## OS 抽象

调度器面对的是可调度的执行实体。不同系统对这个实体的命名不同：进程、线程、task、kernel thread。抽象上，它需要有自己的执行现场，并能在“运行、可运行、等待、退出”等状态之间移动。

最小状态集合：

| 状态 | 含义 |
| --- | --- |
| running | 正在某个 CPU 上执行 |
| runnable | 已经准备好运行，正在等待 CPU |
| blocked / sleeping | 等待 I/O、锁、定时器、消息、条件变量等事件 |
| exited | 执行结束，等待资源回收或已经回收 |

调度器只从 runnable 集合里挑选下一个运行实体。blocked 实体等待的是事件，不竞争 CPU。事件发生后，唤醒路径把它重新变成 runnable。

```text
RUNNING
  |
  | 等 I/O / 等锁 / 等事件
  v
SLEEPING
  |
  | wakeup
  v
RUNNABLE
  |
  | picked by scheduler
  v
RUNNING
```

## 上下文切换

上下文切换是 CPU 从一个执行实体切到另一个执行实体。它至少包含两类状态：

| 状态 | 例子 |
| --- | --- |
| 执行上下文 | 程序计数器、栈指针、通用寄存器、内核栈位置、体系结构相关寄存器 |
| 内存上下文 | 当前地址空间、页表根、TLB 相关状态 |

同一进程内两个线程切换时，通常共享用户地址空间，内存上下文切换较轻。两个不同进程切换时，需要切换地址空间相关状态，后续内存访问还可能受到 TLB/cache 局部性的影响。

调度器的机制部分可以写成三个动作：

```text
保存 prev 的执行现场
选择 next
恢复 next 的执行现场
```

调度器的策略部分回答另一个问题：在所有 runnable 实体里，哪个 next 更合适。

## 调度设计

调度策略的重点是约束取舍。每个策略都在处理几组问题：

| 约束 | 具体问题 |
| --- | --- |
| 公平性 | 多个普通任务竞争 CPU 时，CPU 时间如何分配 |
| 延迟 | 交互任务、I/O 唤醒任务多久能被运行 |
| 吞吐 | CPU-bound 任务能否持续利用 CPU |
| 可预测性 | 实时任务、deadline 任务是否满足时间约束 |
| 局部性 | task 是否尽量留在原 CPU，减少 cache/TLB 损失 |
| 隔离 | cgroup、容器、用户之间的 CPU 份额如何限制 |

FIFO 策略把任务按进入队列的顺序运行，规则简单，但一个长任务可能让后面的任务等待很久。Round-robin 在 FIFO 上加入时间片，到期就轮换，改善交互性，但时间片太短会增加切换开销，时间片太长又接近 FIFO。

优先级调度给任务分层，高优先级任务先运行。它适合表达“某类任务更重要”，但低优先级任务可能长期拿不到 CPU，所以需要 aging、配额或分组控制。实时调度把可预测性放在普通公平性前面，配置错误时可以压住普通任务。

公平调度关心长期 CPU 份额。两个普通 CPU-bound 任务竞争同一个 CPU，权重相同，长期看应该接近各拿一半；其中一个权重更高，它应该拿到更多 CPU 时间。Linux 普通任务的 nice 值就是用户态能直接调整的权重入口。

## Linux 的调度对象

Linux 调度器直接调度 task。普通进程、线程、内核线程在调度器视角下都是 task。进程和线程的资源共享关系在上一章通过 `task_struct`、`mm_struct`、`files_struct` 记录；调度器关注的是 task 当前是否可运行、属于哪个调度类、在当前 CPU 的哪个队列上。

几个核心对象：

| 对象 | 记录 |
| --- | --- |
| `task_struct` | task 的总入口，包含状态、调度字段、资源引用 |
| `struct rq` | 每个 CPU 的 runqueue 和调度统计 |
| `rq->curr` | 当前 CPU 正在运行的 task |
| `rq->nr_running` | 当前 CPU 上 runnable task 数量 |
| `sched_entity` | 普通任务在 fair class 里的调度实体 |
| `cfs_rq` | fair class 的 runqueue |

Linux 为每个 CPU 维护自己的 `rq`。当前 CPU 选下一个 task 时，通常从本 CPU 的 `rq` 开始。唤醒、负载均衡、CPU affinity、NUMA 拓扑会影响 task 是否迁移到其他 CPU。

```text
CPU0
  |
  +-- rq
       |
       +-- deadline class
       +-- rt class
       +-- fair class
       +-- idle

CPU1
  |
  +-- rq
       |
       +-- ...
```

调度类按优先顺序组织。`SCHED_DEADLINE` 任务走 deadline class，`SCHED_FIFO` / `SCHED_RR` 任务走 real-time class，大多数普通用户进程走 fair class，最后是 idle task。

```text
pick_next_task()
  |
  +-- deadline class
  +-- rt class
  +-- fair class
  +-- idle class
```

查看一个任务的调度策略、nice、最近运行 CPU：

```bash
chrt -p <pid>
taskset -pc <pid>
ps -o pid,tid,cls,rtprio,pri,ni,psr,stat,comm -p <pid>
```

## schedule 路径

主动睡眠、主动让出 CPU、抢占返回前检查到需要调度，最后都会进入调度核心路径。源码阅读入口可以从 `kernel/sched/core.c` 里的 `schedule()` 往下走。

```text
schedule()
  |
  v
__schedule()
  |
  +-- 取当前 CPU 的 rq
  +-- 处理 prev task 的状态
  +-- pick_next_task()
  +-- context_switch()
  |
  v
返回 next task 的执行流
```

几个函数名对应的动作：

| 函数 | 动作 |
| --- | --- |
| `schedule()` | 调度入口之一 |
| `__schedule()` | 核心调度逻辑 |
| `pick_next_task()` | 按 scheduling class 选择 next task |
| `context_switch()` | 切换地址空间、寄存器、栈等执行状态 |
| `switch_to()` | 体系结构相关的底层切换 |
| `finish_task_switch()` | 切换后的清理、统计、延迟释放 |

`__schedule()` 先处理 `prev`。`prev` 如果仍然 runnable，会继续留在或重新进入对应调度类的队列；`prev` 如果进入睡眠状态，会从 runnable 集合离开。`pick_next_task()` 按调度类顺序选择 `next`。`context_switch()` 把 CPU 从 `prev` 的执行状态切到 `next` 的执行状态。

`context_switch()` 里有两个方向：执行上下文切换和内存上下文切换。执行上下文落到寄存器、栈、返回地址等体系结构相关状态；内存上下文涉及 `mm_struct`、页表、地址空间。调度器代码经常同时连接进程模型和虚拟内存模型。

## fair class

普通用户任务主要走 fair class。阅读 `kernel/sched/fair.c` 时，先盯住 `sched_entity`、`cfs_rq`、`vruntime` 和 EEVDF 相关选择逻辑。

几个稳定概念：

| 概念 | 记录 |
| --- | --- |
| nice | 用户可见的普通任务优先级调节 |
| weight | nice 映射出的权重，nice 越小权重越大 |
| `vruntime` | 加权运行时间记录 |
| slice | 当前调度周期内估算的运行时间份额 |
| virtual deadline | EEVDF 选择时使用的虚拟期限信息 |

nice 改变的是普通公平调度里的权重关系。它不会把普通任务变成实时任务。

```bash
nice -n 10 ./program
renice -n 5 -p <pid>
ps -o pid,ni,pri,cls,comm -p <pid>
```

调度延迟和 CPU 时间份额要分开看。一个 task 获得的 CPU 总量少，可能是权重低或竞争多；一个 task 被唤醒后很久才运行，更接近 scheduling latency 问题。

## 睡眠和唤醒

task 等待 I/O、锁、futex、定时器、pipe/socket 数据时，会从运行路径进入等待。等待的 task 通常挂到某个 wait queue 或专门等待结构上，状态变成 sleeping，然后调用调度器让出 CPU。

```text
task A
  |
  | 等事件
  v
set_current_state(...)
  |
  v
加入 wait queue
  |
  v
schedule()
  |
  v
CPU 运行其他 task
```

事件发生后，唤醒路径把 task 放回某个 CPU 的 runqueue。

```text
事件发生
  |
  v
wake_up(...)
  |
  v
try_to_wake_up()
  |
  v
选择目标 CPU / runqueue
  |
  v
task 变成 runnable
```

被唤醒的 task 先进入 runnable 状态，真正运行还要等调度器选择它。这个间隔就是调度延迟。

`try_to_wake_up()` 这条路径可以拆成五个检查点：

| 检查点 | 内容 |
| --- | --- |
| 状态 | task 是否处在可被当前事件唤醒的睡眠状态 |
| 目标 CPU | 根据 affinity、当前 CPU、负载、cache 局部性选择 |
| enqueue | 把 task 放进目标 `rq` 的对应调度类 |
| 抢占判断 | 被唤醒 task 是否应该抢占当前 task |
| tracepoint | 产生 `sched_wakeup` 等观测事件 |

futex、pipe、socket、timer、block I/O 完成等路径最终都会接到类似唤醒逻辑。差别在于等待队列挂在哪里、事件由谁触发、唤醒一个 task 还是多个 task。

## 抢占

抢占是当前 task 还没主动睡眠时，内核决定切到另一个 task。常见触发点包括时间片到期、更高优先级任务被唤醒、从中断或系统调用返回前检查调度标记。

| 场景 | 结果 |
| --- | --- |
| 当前 task 时间片用尽 | 设置需要重新调度 |
| 更高优先级 task 唤醒 | 当前 task 可能被抢占 |
| 当前 task 主动睡眠 | 直接进入 `schedule()` |
| 当前 CPU 空闲 | 运行 idle task |

内核抢占受配置和上下文限制影响。持有某些锁、处在中断上下文、抢占被关闭时，不能随便切走当前执行路径。后面看内核同步时，`preempt_disable()`、spinlock、中断上下文会反复出现。

## 多 CPU 和负载均衡

每个 CPU 有自己的 runqueue。多 CPU 调度要同时处理局部性和负载均衡：task 留在原 CPU 上，cache/TLB 局部性更好；任务堆在一个 CPU 上，其他 CPU 空闲，吞吐会下降。

几个影响因素：

- CPU affinity 限制 task 可运行的 CPU。
- NUMA 拓扑影响内存访问代价。
- cache 热度影响迁移成本。
- wakeup path 会选择把被唤醒 task 放到哪个 CPU。
- load balance 会在 CPU 之间移动 runnable task。

观察 CPU 分布：

```bash
ps -o pid,tid,psr,stat,comm -p <pid>
mpstat -P ALL 1
taskset -pc <pid>
```

`psr` 显示 task 最近运行在哪个 CPU。它只是采样点，不代表完整运行历史。

## 观测调度行为

调度延迟通常指 task 已经 runnable，但还没被 CPU 选中运行的时间。这个问题比“CPU 使用率高”更具体：CPU 可能不满，但某个 task 仍然因为亲和性、实时任务、锁竞争、唤醒目标、runqueue 堆积而延迟。

常用入口：

```bash
vmstat 1
pidstat -w 1
perf sched record -- sleep 3
perf sched latency
```

ftrace 事件：

```bash
sudo trace-cmd record -e sched_switch -e sched_wakeup sleep 3
sudo trace-cmd report
```

BPF 入口：

```bash
sudo bpftrace -e 'tracepoint:sched:sched_switch { @[comm] = count(); }'
sudo bpftrace -e 'tracepoint:sched:sched_wakeup { @[comm] = count(); }'
```

几个 tracepoint 名字：

| tracepoint | 记录 |
| --- | --- |
| `sched:sched_switch` | CPU 从一个 task 切到另一个 task |
| `sched:sched_wakeup` | task 被唤醒 |
| `sched:sched_wakeup_new` | 新 task 被唤醒 |
| `sched:sched_migrate_task` | task 迁移到其他 CPU |

## 源码阅读入口

| 路径 | 内容 |
| --- | --- |
| `kernel/sched/core.c` | 调度核心路径，`schedule()`、wakeup、context switch |
| `kernel/sched/fair.c` | fair class，普通任务调度 |
| `kernel/sched/rt.c` | real-time class |
| `kernel/sched/deadline.c` | deadline class |
| `include/linux/sched.h` | `task_struct`、task state 等定义 |
| `include/linux/wait.h` | wait queue 相关接口 |
| `kernel/time/` | timer、hrtimer 相关路径 |

阅读顺序可以按路径推进：

```text
task sleep
  -> schedule()
  -> pick_next_task()
  -> context_switch()
  -> wake_up()
  -> try_to_wake_up()
  -> enqueue 到 runqueue
```

## 本章检查点与参考回答

| 问题 | 参考回答 |
| --- | --- |
| runnable 和 running 怎么区分？ | runnable 表示 task 已准备好运行，正在 runqueue 里等 CPU；running 表示 task 正在某个 CPU 上执行。一个 CPU 同一时刻只能运行一个普通 task，但 runqueue 里可以有多个 runnable task。 |
| 睡眠等待事件和调度延迟有什么区别？ | 睡眠等待事件是 task blocked/sleeping 后等 I/O、锁、定时器等事件的时间；调度延迟是 task 被唤醒变成 runnable 后，继续等待 CPU 选中它的时间。 |
| `schedule()` 做什么？ | `schedule()` 进入核心调度路径，处理当前 task `prev` 的状态，从当前 CPU 的 `rq` 中通过 `pick_next_task()` 选出 `next`，再通过 `context_switch()` 切到 `next` 的执行流。 |
| `try_to_wake_up()` 做什么？ | `try_to_wake_up()` 检查 sleeping task 是否能被当前事件唤醒，选择目标 CPU，把 task enqueue 到对应 runqueue，并判断是否需要设置抢占。 |
| nice 和实时优先级是什么关系？ | nice 调整普通 fair class 任务的权重，影响长期 CPU 份额。实时任务走 rt class 或 deadline class，优先级语义不同；调 nice 不会把普通任务变成实时任务。 |
| 多 CPU 调度为什么要考虑局部性？ | task 留在原 CPU 上通常 cache/TLB 更热，迁移成本更低；但如果任务集中在少数 CPU 上，其他 CPU 空闲，吞吐会下降。负载均衡在局部性和利用率之间取舍。 |

## 例子：一条 Linux 调度路径

CPU 当前运行 task A。A 调用 `read()` 等待 socket 数据，但当前没有数据。task B 已经在当前 CPU 的 `rq` 上 runnable。task C 在另一个等待队列里睡眠。

```text
prev = A
A 设置睡眠状态
A 挂到 socket 等待队列
schedule()
pick_next_task(rq) 选中 B
context_switch(A, B)
CPU 开始执行 B
```

之后 socket 数据到达，网络路径触发唤醒：

```text
事件发生
wake_up(C 或 A)
try_to_wake_up()
选择目标 CPU
enqueue 到目标 CPU 的 rq
必要时设置抢占标记
```

被唤醒的 task 进入 runnable 状态。它是否立刻运行，取决于调度类、优先级、fair class 的选择结果、当前 CPU 状态和抢占条件。

这条线里有三个不同时间：task 实际运行时间、task 睡眠等待事件的时间、task runnable 之后等待 CPU 的时间。排查性能问题时，这三段要分开看。

## 例子：最小 FIFO 调度器模型

一个最小内核调度器可以只保留 task、context、栈、状态、一个全局 FIFO 队列、每 CPU 当前任务、主动 `yield()`、信号量阻塞和 idle task。这个模型保留了调度器的基本机制：保存当前 context，选择下一个 runnable task，恢复下一个 context。

`task_t` 的信息量很小：

| 字段 | 记录 |
| --- | --- |
| `name` | 任务名 |
| `status` | `TASK_RUNNING`、`TASK_RUNNABLE`、`TASK_BLOCKED`、`TASK_DEAD` |
| `context` | 被切走后保存的处理器上下文 |
| `stack` | 任务自己的内核栈 |

任务队列用全局循环数组表示，队列头尾用 `task_head` 和 `task_tail` 记录，`tasks_lock` 保护队列修改。

```text
tasks[MAX_TASK_NUM]
task_head
task_tail
tasks_lock
```

`push_task()` 把 task 放到 `task_tail`，尾指针取模前进。`pop_task()` 从 `task_head` 开始向后扫，遇到 `TASK_RUNNABLE` 就返回；这一轮没找到可运行任务时，返回当前 CPU 的 idle task。被阻塞的 task 留在数组里，扫描时跳过。

一轮切换：

```text
curr_task = A, A.status = TASK_RUNNING
tasks[head] = B, B.status = TASK_RUNNABLE
tasks[head + 1] = C, C.status = TASK_BLOCKED
```

A 调用 `yield()` 后进入 trap。保存路径记录 A 的现场：

```text
A.context = context
curr_last = A
```

调度路径调用 `pop_task()`。队列头是 B，B 是 `TASK_RUNNABLE`，所以 B 被选中：

```text
next_task = B
curr_task = B
B.status = TASK_RUNNING
return B.context
```

trap 返回后，CPU 恢复 B 的 context，开始执行 B。A 被暂存在 `curr_last`，下一次进入保存路径时再标回 `TASK_RUNNABLE` 并放回队列。这个延迟放回队列的动作处理多 CPU 场景下同一个 task 被过早重新选中的窗口。

信号量等待路径直接接到调度：

```text
sem_wait()
  |
  | value <= 0
  v
当前 task 标记为 TASK_BLOCKED
  |
  v
yield()
  |
  v
重新进入调度
```

这个模型和 Linux 的主要差异：

| 最小模型 | Linux |
| --- | --- |
| 全局 FIFO 循环数组 | per-CPU `rq`、调度类、fair/rt/deadline 队列 |
| `TASK_RUNNABLE` / `TASK_BLOCKED` | 更丰富的 task state 和 wakeup flags |
| `curr_task` | `current`、`rq->curr` |
| `yield()` 主动触发切换 | syscall、interrupt、preemption、blocking 都可触发调度 |
| 阻塞 task 留在全局数组里 | 睡眠 task 挂到具体 wait queue，唤醒后 enqueue 到 runqueue |

## 本章参考

- [Linux Kernel Documentation](https://docs.kernel.org/)
- [Linux kernel documentation: Scheduler](https://docs.kernel.org/scheduler/)
- [Operating Systems: Three Easy Pieces](https://pages.cs.wisc.edu/~remzi/OSTEP/)
- [小林 Code：图解系统](https://xiaolincoding.com/os/)
- Brendan Gregg, *Systems Performance*
- Michael Kerrisk, *The Linux Programming Interface*
