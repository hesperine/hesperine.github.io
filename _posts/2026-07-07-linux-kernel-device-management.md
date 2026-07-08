---
title: Linux 内核学习笔记：设备管理阅读批注
date: 2026-07-07 17:58:00 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, Operating System, Device Driver, Interrupt]
---

这一篇按小林 Code《图解系统》第七章“设备管理”的顺序记：设备控制器、I/O 控制方式、设备驱动、通用块层、存储系统 I/O 分层，以及“键盘敲入 A 字母”这条路径。Linux 批注落到 MMIO/PIO、DMA、IRQ、driver model、字符设备、块设备、block layer、workqueue。

## 问题索引

| 小林 Code 主题 | 本篇记录 |
| --- | --- |
| 设备控制器 | 控制寄存器、数据寄存器、状态寄存器 |
| I/O 控制方式 | 轮询、中断、DMA、MMIO/PIO |
| 设备驱动程序 | 向上提供统一接口，向下控制具体硬件 |
| 通用块层 | 块设备抽象、请求队列、I/O 调度 |
| 存储系统 I/O 分层 | 文件系统、page cache、块层、驱动、设备 |
| 键盘输入路径 | 键盘控制器、中断、驱动、输入子系统、终端 |

## 1. 设备控制器：CPU 不直接操作复杂设备

外设种类很多，键盘、鼠标、磁盘、网卡、显示器的操作方式都不同。CPU 通常通过设备控制器和设备通信。控制器理解设备协议，并向 CPU 暴露寄存器或内存映射区域。

| 寄存器 | 作用 |
| --- | --- |
| data register | 传输数据 |
| command register | 接收 CPU 发出的命令 |
| status register | 暴露设备是否忙、是否完成、是否出错 |
| control register | 设置设备工作模式 |

设备大体可以分成两类。

| 类型 | 特点 | 例子 |
| --- | --- | --- |
| 字符设备 | 字节流或字符流，通常不能随机寻址 | 键盘、串口、终端 |
| 块设备 | 固定大小块，可随机访问 | HDD、SSD、U 盘 |

Linux 批注：用户态常通过设备文件访问设备，例如 `/dev/sda`、`/dev/null`、`/dev/tty`。设备文件把 VFS 接口接到驱动的 file operations 上。字符设备和块设备在内核里的对象、路径和调度方式不同。

## 2. MMIO、PIO、中断、DMA

CPU 和设备控制器通信常见两类地址空间接口。

| 方式 | 记录 |
| --- | --- |
| PIO | 使用专门 I/O 指令访问设备端口 |
| MMIO | 把设备寄存器映射到内存地址空间，像访问内存一样读写寄存器 |

设备完成工作后需要通知 CPU。轮询会反复读状态寄存器，简单但浪费 CPU；中断让设备在事件发生时打断 CPU，进入内核中断处理路径。

DMA, Direct Memory Access，让设备或 DMA 控制器直接在设备和内存之间搬运数据。CPU 负责配置传输方向、地址、长度和权限，数据搬运由 DMA 完成，传输完成后再通过中断通知 CPU。

| 机制 | 解决的问题 | 代价 |
| --- | --- | --- |
| 轮询 | 实现简单，适合极短等待或特殊路径 | 消耗 CPU |
| 中断 | 事件发生时通知 CPU | 高频事件会带来中断风暴 |
| DMA | 大块数据搬运不占用 CPU 拷贝循环 | 需要映射、同步、缓存一致性处理 |

Linux 批注：高性能设备路径经常组合 DMA、中断、软中断、NAPI、workqueue。硬中断路径要短，能延后的工作放到 softirq、threaded IRQ 或 workqueue。

## 3. 设备驱动：内核里的硬件适配层

设备驱动向上接入内核通用框架，向下操作设备控制器。驱动负责初始化设备、注册中断处理函数、分配 DMA 缓冲区、暴露设备文件或网络接口、处理错误和热插拔等。

| 驱动动作 | Linux 入口 |
| --- | --- |
| 设备发现和匹配 | bus、device、driver、modalias |
| 注册字符设备 | `cdev`、`file_operations` |
| 注册块设备 | gendisk、request queue、blk-mq |
| 注册网卡 | `net_device`、NAPI |
| 注册中断处理 | `request_irq()` |
| 延后处理 | softirq、tasklet、workqueue、threaded IRQ |

Linux driver model 的核心对象可以先记 `struct device`、`struct device_driver`、bus、class、sysfs。`/sys` 暴露了设备层次、驱动绑定、属性和电源状态等信息。

观察入口：

| 命令 / 路径 | 记录 |
| --- | --- |
| `ls /sys/bus` | 总线类型 |
| `ls /sys/class` | 设备类别 |
| `lsmod` | 已加载模块 |
| `modinfo <module>` | 模块信息 |
| `dmesg -T` | 驱动初始化、设备错误、中断日志 |
| `udevadm info` | udev 看到的设备属性 |

## 4. 中断上下文和 deferred work

中断处理函数运行在特殊上下文中。它响应硬件事件，但路径要短，不能随便执行可能睡眠的操作。常见做法是硬中断里确认事件、读取少量状态、屏蔽或确认设备中断，再把后续工作交给下半部机制。

| 机制 | 记录 |
| --- | --- |
| hard IRQ | 硬中断处理，响应设备或定时器事件 |
| softirq | 软中断，网络收发等高频路径常用 |
| tasklet | 基于 softirq 的旧式延后执行机制 |
| workqueue | 在内核线程上下文执行，可以睡眠 |
| threaded IRQ | 把中断处理线程化，适合需要较长处理的驱动 |

能否睡眠是关键边界。

| 上下文 | 睡眠能力 |
| --- | --- |
| 普通进程上下文 | 通常可以睡眠 |
| workqueue | 可以睡眠 |
| hard IRQ | 不能睡眠 |
| softirq | 不能随便睡眠 |
| 持有 spinlock | 不能睡眠 |

## 5. 通用块层：文件系统和磁盘驱动之间

块设备路径需要处理请求排队、合并、调度、分发和完成。Linux 的通用块层把上层文件系统或 direct I/O 的请求转成块设备请求，再交给具体驱动和设备。

| 层次 | 记录 |
| --- | --- |
| VFS / 文件系统 | 产生文件读写请求 |
| page cache / writeback | 缓存文件页和脏页写回 |
| block layer | bio、request queue、I/O scheduler、blk-mq |
| driver | 设备特定命令、DMA、完成中断 |
| hardware | SSD/HDD/NVMe 等 |

blk-mq 是现代 Linux 块层的多队列框架，用来适配多核 CPU 和现代存储设备。I/O scheduler 的作用包括合并请求、控制延迟、公平性和设备队列。

观察入口：

| 命令 / 路径 | 记录 |
| --- | --- |
| `lsblk -o NAME,TYPE,SIZE,ROTA,SCHED` | 块设备和调度器 |
| `cat /sys/block/<dev>/queue/scheduler` | 当前 I/O scheduler |
| `iostat -x 1` | 设备利用率和延迟 |
| `pidstat -d 1` | 进程 I/O |
| `cat /proc/diskstats` | 块设备统计 |

## 6. 一次键盘输入路径

键盘敲入一个字符，路径可以压缩成硬件事件进入内核，再被用户态读取。

| 阶段 | 记录 |
| --- | --- |
| 键盘控制器 | 产生扫描码，放入控制器缓冲区 |
| 中断 | 控制器向 CPU 发送 IRQ |
| 中断处理 | 内核保存当前上下文，进入键盘驱动中断处理 |
| 驱动 | 读取扫描码，交给输入子系统 |
| input / tty | 转成按键事件或终端输入 |
| 用户态 | shell、编辑器或图形系统读取输入 |

这条路径连接几个核心概念：设备控制器通过中断通知 CPU；驱动处理设备协议；输入子系统做统一抽象；终端或图形栈把事件交给应用。

## 7. 设备文件和 ioctl

Linux 里很多设备通过文件接口暴露。普通读写走 `read()` / `write()`，设备特有控制走 `ioctl()`。

| 接口 | 记录 |
| --- | --- |
| `open()` | 打开设备文件 |
| `read()` / `write()` | 读写设备数据流 |
| `poll()` / `epoll()` | 等待设备可读写 |
| `mmap()` | 把设备或 DMA 缓冲区映射给用户态，依驱动支持 |
| `ioctl()` | 设备特定控制命令 |

`ioctl()` 是设备管理里常见的“逃生口”：统一文件接口表达不了的设备属性、模式切换、命令提交，经常通过 ioctl 进入驱动。

## 压缩表

| 概念 | 小林 Code / 八股 | Linux 落点 |
| --- | --- | --- |
| 设备控制器 | CPU 通过控制器操作设备 | MMIO/PIO、寄存器 |
| 中断 | 设备通知 CPU | IRQ、`request_irq()`、`/proc/interrupts` |
| DMA | 设备和内存直接搬运数据 | DMA mapping、IOMMU、cache sync |
| 驱动 | 屏蔽设备差异 | driver model、module、sysfs |
| 字符设备 | 字节流接口 | `cdev`、`file_operations` |
| 块设备 | 固定块随机访问 | block layer、blk-mq、request queue |
| deferred work | 延后处理耗时工作 | softirq、workqueue、threaded IRQ |

## 检查点与参考回答

| 问题 | 参考回答 |
| --- | --- |
| 设备控制器是什么？ | 设备控制器是 CPU 和具体外设之间的硬件控制组件，向 CPU 暴露寄存器或内存映射区域，并负责理解设备协议。 |
| MMIO 和 PIO 怎么区分？ | PIO 使用专门 I/O 指令访问端口；MMIO 把设备寄存器映射到内存地址空间，用普通内存访问指令读写。 |
| DMA 解决什么问题？ | DMA 让设备和内存之间的大块数据搬运不需要 CPU 逐字节拷贝，CPU 只负责配置传输和处理完成事件。 |
| 中断上下文为什么不能随便睡眠？ | 中断上下文不代表普通进程执行，路径要求短，且没有正常可阻塞的进程上下文；耗时工作通常交给 softirq、threaded IRQ 或 workqueue。 |
| 字符设备和块设备有什么区别？ | 字符设备以字节流方式访问，通常不可随机寻址；块设备按固定大小块访问，支持随机读写，路径会经过通用块层。 |
| 通用块层做什么？ | 通用块层位于文件系统和块设备驱动之间，管理 bio/request、队列、合并、调度和分发，向上屏蔽不同块设备差异。 |
| `ioctl()` 为什么存在？ | 通用 read/write/poll 接口无法表达所有设备特定控制命令，`ioctl()` 用于设备模式配置、属性获取、命令提交等驱动私有操作。 |

## 本篇参考

- 小林 Code《图解系统》第七章：设备管理
- Remzi H. Arpaci-Dusseau and Andrea C. Arpaci-Dusseau, *Operating Systems: Three Easy Pieces*
- Linux Kernel Documentation: Driver API
- Linux Kernel Documentation: Core API
- Linux Kernel Documentation: Block
- Michael Kerrisk, *The Linux Programming Interface*
- Robert Love, *Linux Kernel Development*
