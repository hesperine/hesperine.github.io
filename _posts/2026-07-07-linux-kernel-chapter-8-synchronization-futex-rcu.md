---
title: Linux 内核学习笔记（八）：同步、futex 与 RCU
date: 2026-07-07 17:54:00 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, Concurrency, Futex, RCU]
---

并发问题发生在多个执行流同时访问共享状态时。用户态会遇到线程、锁、条件变量、futex；内核态还要处理多 CPU、抢占、中断上下文、软中断和“能不能睡眠”的限制。

## OS 抽象

同步机制处理三类问题：

| 问题 | 说明 |
| --- | --- |
| 互斥 | 同一时刻只允许一个执行流进入临界区 |
| 等待 | 条件不满足时睡眠，条件满足后唤醒 |
| 顺序 | 多 CPU 上读写内存的可见顺序 |

常见用户态抽象包括 mutex、condition variable、semaphore、rwlock。它们的接口在用户态，但竞争严重时通常会进入内核睡眠等待。

## futex

futex 是 fast userspace mutex。核心思想是无竞争时只在用户态改一个整数；需要睡眠或唤醒时才进入内核。

```text
pthread_mutex_lock()
  |
  +-- 用户态 CAS 成功 -> 获得锁
  |
  +-- CAS 失败，有竞争
          |
          v
       futex(FUTEX_WAIT)
          |
          v
       当前 task 睡眠
```

解锁路径：

```text
pthread_mutex_unlock()
  |
  v
用户态释放锁
  |
  +-- 没有等待者 -> 返回
  |
  +-- 有等待者 -> futex(FUTEX_WAKE)
```

futex 在内核里不是替用户态保存完整 mutex，而是根据用户地址组织等待队列。用户态的那个整数仍然是锁状态的核心。

## wait queue

wait queue 是 Linux 内核里常见等待结构。task 等事件时，把自己挂到等待队列，设置睡眠状态，再调用 `schedule()`。事件发生时，唤醒函数把等待队列里的 task 变回 runnable。

```text
等待方
  -> prepare_to_wait()
  -> set state
  -> schedule()

唤醒方
  -> 条件变为真
  -> wake_up()
```

socket、pipe、futex、定时器、I/O 完成都会用到类似等待/唤醒模型。

## 内核锁

内核锁要先看当前上下文能不能睡眠。

| 锁 | 特点 |
| --- | --- |
| spinlock | 忙等，持锁期间不能睡眠，常用于短临界区和中断相关路径 |
| mutex | 竞争时可以睡眠，只能在进程上下文使用 |
| rwsem | 读写信号量，可睡眠，适合读多写少路径 |
| atomic | 原子操作，适合简单计数和状态位 |
| seqlock | 写少读多，读侧可重试 |

持有 spinlock 时睡眠会破坏调度和锁语义。中断上下文也不能随便睡眠，因为它不代表一个可以被阻塞后恢复的普通进程执行路径。

## memory barrier

多 CPU 上，编译器和 CPU 都可能重排内存访问。锁通常隐含必要的内存顺序；无锁代码、设备寄存器访问、RCU、原子状态机需要显式考虑 memory ordering。

当前只记边界：普通 C 代码顺序不等于其他 CPU 看到的顺序。内核用 barrier、atomic、锁原语表达顺序约束。

## RCU

RCU 是 read-copy-update。读侧尽量轻，写侧复制并替换指针，等旧读侧临界区全部结束后再释放旧对象。

```text
读侧
  rcu_read_lock()
  p = rcu_dereference(ptr)
  读取 p
  rcu_read_unlock()

写侧
  new = copy(old)
  rcu_assign_pointer(ptr, new)
  synchronize_rcu()
  free(old)
```

RCU 适合读多写少的数据结构。它的核心不是“没有同步”，而是把同步成本从读侧转移到写侧和延迟释放上。

## 术语表 / 八股检查点

| 名词 | 记录 |
| --- | --- |
| race condition | 执行顺序不同导致结果不同 |
| critical section | 访问共享状态的临界区 |
| deadlock | 多个执行流互相等待资源 |
| mutex | 互斥锁 |
| condition variable | 条件变量 |
| futex | 用户态快路径、内核睡眠慢路径的同步机制 |
| wait queue | 内核等待队列 |
| spinlock | 忙等锁，持锁期间不能睡眠 |
| sleepable lock | 竞争时可以睡眠的锁 |
| atomic | 原子操作 |
| memory barrier | 内存顺序约束 |
| RCU | read-copy-update |
| grace period | RCU 中旧读侧临界区全部结束所需的时间段 |

## 观测入口

```bash
strace -e futex ./program
perf lock record -- ./program
perf lock report
```

调度和等待：

```bash
perf sched record -- sleep 3
perf sched latency
ps -o pid,tid,stat,wchan,comm -p <pid>
```

BPF / tracepoint：

```bash
sudo bpftrace -e 'tracepoint:syscalls:sys_enter_futex { @[comm] = count(); }'
```

## 源码入口

| 路径 | 内容 |
| --- | --- |
| `kernel/futex/` | futex 实现 |
| `include/linux/wait.h` | wait queue 接口 |
| `kernel/locking/` | mutex、rwsem、lockdep 等 |
| `include/linux/spinlock.h` | spinlock 接口 |
| `kernel/rcu/` | RCU 实现 |
| `Documentation/RCU/` | RCU 文档 |

## 本章检查点与参考回答

| 问题 | 参考回答 |
| --- | --- |
| futex 为什么快？ | 无竞争时锁状态只在用户态通过原子操作修改，不进入内核；只有竞争导致等待或唤醒时才调用 futex syscall。 |
| mutex 和 spinlock 怎么选？ | 临界区短、不能睡眠、可能在中断相关路径使用时用 spinlock；竞争时允许睡眠、临界区可能较长时用 mutex。 |
| wait queue 的基本流程是什么？ | 等待方设置状态并挂入 wait queue，然后 `schedule()` 让出 CPU；事件发生后，唤醒方调用 `wake_up()` 把 task 放回 runqueue。 |
| 中断上下文为什么不能睡眠？ | 中断上下文是硬件事件处理路径，不是一个普通可阻塞 task 的执行流；睡眠需要调度器以后恢复当前上下文，中断上下文不满足这种语义。 |
| RCU 适合什么场景？ | RCU 适合读多写少、读侧要求很轻的数据结构。写侧复制并替换指针，等 grace period 后释放旧对象。 |

## 本章参考

- [Linux kernel documentation: Locking](https://docs.kernel.org/locking/index.html)
- [Linux kernel documentation: RCU](https://docs.kernel.org/RCU/index.html)
- [小林 Code：图解系统](https://xiaolincoding.com/os/)
- [Operating Systems: Three Easy Pieces](https://pages.cs.wisc.edu/~remzi/OSTEP/)
- Robert Love, *Linux Kernel Development*
