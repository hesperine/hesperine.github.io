---
title: Linux 内核学习笔记（九）：设备管理、中断与 deferred work
date: 2026-07-07 17:55:00 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, Device Driver, Interrupt, Workqueue]
---

设备管理把硬件和内核对象接起来。用户态通常通过设备文件、socket、sysfs、ioctl、read/write 访问设备；内核通过 driver model、设备驱动、中断、DMA、workqueue 等机制处理硬件事件。

## OS 抽象

设备比 CPU 慢，也更异步。程序发起 I/O 请求后，设备可能过一段时间才完成；完成事件通常通过中断通知 CPU。内核要处理三件事：

| 问题 | 说明 |
| --- | --- |
| 命名和访问 | 用户态怎样找到设备并发起操作 |
| 数据移动 | CPU 复制、DMA、缓冲区、队列 |
| 完成通知 | 中断、轮询、唤醒等待者 |

设备驱动把具体硬件差异封装起来，上层通过统一接口访问。

## 设备文件

Linux 里很多设备通过 `/dev` 下的设备文件暴露。字符设备按字节流访问，块设备按块访问。

| 类型 | 例子 |
| --- | --- |
| 字符设备 | tty、串口、随机数设备、部分传感器 |
| 块设备 | 磁盘、分区、loop 设备 |
| 网络设备 | 通常不直接表现为普通 `/dev` 文件，更多通过 socket 和 netdev 接口访问 |

设备号由 major/minor 组成。major 通常标识驱动类型，minor 标识同一驱动下的具体设备实例。

```bash
ls -l /dev/null /dev/sda 2>/dev/null
```

## driver model

Linux driver model 管理 device、driver、bus、class 的关系。设备挂在某类 bus 上，driver 声明自己能匹配哪些设备，匹配成功后执行 probe。

```text
bus
  |
  +-- device
  |
  +-- driver
       |
       +-- probe()
       +-- remove()
```

sysfs 把这套对象暴露到 `/sys`：

```bash
ls /sys/bus
ls /sys/class
ls /sys/devices
```

## 中断

设备事件到来时，硬件触发中断。中断处理路径通常要快，不能把所有工作都放在硬中断里做。

```text
设备事件
  |
  v
IRQ
  |
  v
硬中断处理
  |
  +-- 读取必要状态
  +-- ack 设备
  +-- 安排后续工作
```

中断上下文不能随便睡眠。需要较长时间处理的工作会放到 softirq、tasklet、workqueue、threaded IRQ 等后续路径。

## deferred work

deferred work 把不能或不适合在硬中断里完成的工作延后。

| 机制 | 记录 |
| --- | --- |
| softirq | 软中断，常用于网络、块层等高频路径 |
| tasklet | 基于 softirq 的较旧机制 |
| workqueue | 在内核线程上下文执行，可以睡眠 |
| threaded IRQ | 把中断处理的一部分放到线程上下文 |
| timer/hrtimer | 定时触发后续处理 |

workqueue 的关键点是它运行在进程上下文，可以睡眠。softirq 仍然有上下文限制。

## DMA

DMA 让设备直接读写内存，减少 CPU 搬运数据的成本。驱动需要设置 DMA buffer、地址映射、同步 cache，一些平台还要经过 IOMMU。

简化路径：

```text
驱动分配 buffer
  |
  v
建立 DMA 映射
  |
  v
通知设备
  |
  v
设备读写内存
  |
  v
中断通知完成
```

DMA 的细节和架构、设备、IOMMU 有关。关键点是数据可以不经过 CPU 一字节一字节复制，但内核仍要管理缓冲区、权限和同步。

## 块设备路径

块设备 I/O 通常进入 block layer。上层文件系统提交 bio，请求进入队列，调度和合并后发给驱动。

```text
filesystem
  |
  v
bio
  |
  v
request queue
  |
  v
block driver
  |
  v
device
```

文件系统、page cache、writeback 和块层会在这里接起来。

## 术语表 / 八股检查点

| 名词 | 记录 |
| --- | --- |
| device driver | 设备驱动 |
| character device | 字符设备 |
| block device | 块设备 |
| major/minor number | 设备号 |
| bus | 设备总线 |
| probe | driver 匹配 device 后的初始化入口 |
| IRQ | 硬件中断请求 |
| interrupt context | 中断上下文 |
| top half | 硬中断里的快速处理 |
| bottom half | 延后处理部分 |
| softirq | 软中断 |
| workqueue | 工作队列，在线程上下文执行 |
| DMA | 设备直接内存访问 |
| bio | 块 I/O 描述 |

## 观测入口

```bash
ls -l /dev
ls /sys/bus
ls /sys/class
cat /proc/interrupts
cat /proc/softirqs
```

块设备：

```bash
lsblk
iostat -x 1
cat /sys/block/<dev>/queue/scheduler
```

中断和软中断：

```bash
vmstat 1
mpstat -I SUM 1
```

## 源码入口

| 路径 | 内容 |
| --- | --- |
| `drivers/` | 各类设备驱动 |
| `include/linux/device.h` | driver model 相关结构 |
| `kernel/irq/` | IRQ 管理 |
| `kernel/softirq.c` | softirq |
| `kernel/workqueue.c` | workqueue |
| `block/` | block layer |
| `include/linux/blk_types.h` | bio 等块层结构 |

## 本章检查点与参考回答

| 问题 | 参考回答 |
| --- | --- |
| 字符设备和块设备有什么区别？ | 字符设备按字节流或设备自定义语义访问，块设备按块组织 I/O，通常接到文件系统、page cache 和 block layer。 |
| 中断上下文为什么要短？ | 硬中断会打断当前执行，持有上下文限制，不能随便睡眠。处理太久会影响系统响应和其他中断，所以只做必要工作，再把剩余工作延后。 |
| workqueue 和 softirq 的区别是什么？ | softirq 适合高频、低延迟的延后处理，但仍有上下文限制；workqueue 在线程上下文执行，可以睡眠，适合可能阻塞或较重的工作。 |
| DMA 的作用是什么？ | DMA 让设备直接读写内存，减少 CPU 搬运数据的开销。内核仍要负责 buffer、映射、cache 同步和权限控制。 |
| `/sys` 和 `/dev` 怎么分？ | `/dev` 提供用户态访问设备的文件入口；`/sys` 暴露内核设备模型、驱动、总线、属性和状态。 |

## 本章参考

- [Linux kernel documentation: Driver API](https://docs.kernel.org/driver-api/index.html)
- [Linux kernel documentation: Core API](https://docs.kernel.org/core-api/index.html)
- [Linux kernel documentation: Block](https://docs.kernel.org/block/index.html)
- [小林 Code：图解系统](https://xiaolincoding.com/os/)
- Robert Love, *Linux Kernel Development*
