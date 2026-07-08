---
title: Linux 内核学习笔记（十三）：源码阅读、实验环境与内核开发方法
date: 2026-07-07 17:59:00 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, Kernel Development, QEMU, Debugging]
---

内核学习最后要回到源码和实验。能解释概念只是第一步；能找到路径、改配置、跑实验、看日志、定位崩溃，学习才会变成可验证的能力。

三层阅读线索：

| 层次 | 本章对应内容 |
| --- | --- |
| 小林 Code / 八股 | 把面试问题沉淀成可复现的小实验 |
| OSTEP / 教材 | 用项目和实验巩固 OS 机制 |
| Linux 实现 | 源码树、Kconfig、Makefile、module、QEMU、oops/panic、selftests |

## 源码树入口

Linux 源码目录可以按子系统记：

| 路径 | 内容 |
| --- | --- |
| `kernel/` | 调度、fork、exit、signal、cgroup、locking 等核心机制 |
| `mm/` | 内存管理 |
| `fs/` | VFS 和文件系统 |
| `net/` | 网络栈 |
| `drivers/` | 设备驱动 |
| `block/` | 块层 |
| `arch/` | 架构相关代码 |
| `include/linux/` | 内核内部头文件 |
| `include/uapi/` | 用户态可见 ABI 头文件 |
| `Documentation/` | 官方文档 |
| `tools/` | perf、bpf、自测工具等 |

读源码先找入口函数，再顺对象关系走，不直接从目录头开始顺序读。

## 配置和构建

Kconfig 决定配置项，Makefile 决定构建关系。

```bash
make defconfig
make menuconfig
make -j$(nproc)
```

当前学习阶段重点放在看懂这些文件：

| 文件 | 作用 |
| --- | --- |
| `Kconfig` | 配置项定义、依赖、帮助文本 |
| `Makefile` | 哪些对象参与构建 |
| `.config` | 当前内核配置 |
| `Module.symvers` | 模块符号版本信息 |

## QEMU / VM 实验

内核实验适合放在 VM 或 QEMU，不直接在主力系统上试。实验环境需要可恢复、可重跑。

基本组成：

```text
kernel image
  +
rootfs / initramfs
  +
QEMU command line
  +
serial console
```

串口输出适合保存日志：

```bash
console=ttyS0
```

出现 panic/oops 时，先保留完整日志，再看调用栈、fault 地址、当前 task、模块 taint。

## 内核模块

内核模块适合做小实验，但模块运行在内核态，错误会影响整个系统。

模块入口：

```text
module_init()
module_exit()
```

常用操作：

```bash
insmod module.ko
lsmod
dmesg
rmmod module
```

学习模块时重点看符号、引用计数、设备注册、日志输出和错误路径清理。

## 调试和日志

常见入口：

| 工具 | 用途 |
| --- | --- |
| `dmesg` | 查看内核日志 |
| `printk` | 内核日志输出 |
| dynamic debug | 动态打开某些调试输出 |
| ftrace | 跟踪函数和事件 |
| perf | 性能采样和事件 |
| crash / vmcore | 分析崩溃转储 |
| gdb + QEMU | 调试实验内核 |

内核崩溃日志要先看：

```text
BUG / WARNING / Oops / panic
RIP / Call Trace
current task
fault address
loaded modules
taint flags
```

## patch workflow

正式内核开发强调小 patch、清晰 commit message、可复现测试和邮件列表流程。学习阶段也可以保留这个习惯：

```text
明确问题
  -> 找到最小修改点
  -> 写小实验或复现命令
  -> 修改代码
  -> 编译 / 运行 / 验证
  -> 记录日志和结论
```

读 patch 时，先看 commit message，再看改了哪些路径，最后看锁、错误路径、资源释放和兼容性。

## 术语表 / 八股检查点

| 名词 | 记录 |
| --- | --- |
| Kconfig | 内核配置系统 |
| `.config` | 当前配置结果 |
| kernel module | 可动态加载的内核模块 |
| symbol | 内核符号 |
| oops | 内核错误报告，系统可能继续运行 |
| panic | 严重错误，内核停止运行 |
| taint | 内核污染标记 |
| initramfs | 启动早期根文件系统 |
| QEMU | 虚拟机/模拟器 |
| bisect | 二分定位引入问题的提交 |
| patch | 源码修改单元 |

## 观测入口

```bash
uname -a
cat /proc/version
zcat /proc/config.gz 2>/dev/null | head
dmesg -T | tail
```

源码搜索：

```bash
rg "SYSCALL_DEFINE.*read" fs include kernel
rg "try_to_wake_up" kernel/sched
rg "struct vm_area_struct" include mm
```

模块和日志：

```bash
lsmod
modinfo <module>
dmesg -w
```

## 源码入口

| 路径 | 内容 |
| --- | --- |
| `Documentation/process/` | 开发流程和提交流程 |
| `Documentation/admin-guide/` | 管理和调试文档 |
| `scripts/` | 构建、检查、辅助脚本 |
| `tools/testing/selftests/` | 内核自测 |
| `lib/` | 通用库代码 |
| `samples/` | 示例代码 |

## 本章检查点与参考回答

| 问题 | 参考回答 |
| --- | --- |
| 读内核源码从哪里开始？ | 从具体路径和入口函数开始，例如 `read()`、`clone()`、page fault、`schedule()`。先抓对象关系和调用链，再扩展到相关子系统。 |
| Kconfig 和 Makefile 分别做什么？ | Kconfig 定义配置项、依赖和帮助文本；Makefile 决定哪些源码按当前配置参与构建。 |
| 为什么内核实验要用 VM/QEMU？ | 内核代码错误可能导致 panic、数据损坏或系统不可用。VM/QEMU 可恢复、可重跑、便于保存串口日志。 |
| oops 和 panic 有什么区别？ | oops 是内核错误报告，系统有时还能继续运行；panic 表示严重错误，内核停止运行或重启。 |
| 一个小 patch 应该怎样验证？ | 先有复现或观察命令，再做最小修改，然后编译、运行、检查日志和行为变化，最后记录测试范围和残留风险。 |

## 本章参考

- [Linux kernel documentation: Process](https://docs.kernel.org/process/)
- [Linux kernel documentation: Kernel hacking](https://docs.kernel.org/kernel-hacking/)
- [Linux Kernel Labs](https://linux-kernel-labs.github.io/refs/heads/master/)
- Robert Love, *Linux Kernel Development*
- Brendan Gregg, *Systems Performance*
