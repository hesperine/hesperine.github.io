---
title: Linux 内核学习笔记（十二）：tracing、perf 与 BPF
date: 2026-07-07 17:58:00 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, BPF, eBPF, perf, ftrace]
---

tracing 把前面学过的内核机制变成可观测事件。系统调用、调度、page fault、I/O、网络包、锁竞争都可以通过 perf、ftrace、tracepoint、kprobe、uprobe、BPF 观察。

## OS 抽象

观测系统需要三个部分：

| 部分 | 说明 |
| --- | --- |
| 观测点 | 事件在哪里发生 |
| 采集逻辑 | 记录什么、如何过滤、如何聚合 |
| 输出 | 打印、计数、直方图、火焰图、日志 |

`strace` 观察 syscall 边界。perf 既能采样也能记录事件。ftrace 使用内核内置 tracing。BPF 可以把小程序挂到内核 hook 上做过滤和聚合。

## tracepoint、kprobe、uprobe

| 机制 | 记录 |
| --- | --- |
| tracepoint | 内核源码预定义的稳定事件点 |
| kprobe | 动态挂到内核函数或指令 |
| uprobe | 动态挂到用户态函数或指令 |
| perf event | 硬件/软件性能事件 |

tracepoint 相对稳定，字段定义明确，适合长期使用。kprobe 更灵活，但依赖函数名和内核实现，跨版本更容易变化。

## perf

CPU 采样：

```bash
perf record -g -- ./program
perf report
```

调度事件：

```bash
perf sched record -- sleep 3
perf sched latency
```

系统调用和 page fault 统计：

```bash
perf stat -e cycles,instructions,page-faults,context-switches ./program
```

perf 适合回答“时间花在哪里”“事件发生了多少”“调用栈是什么”。

## ftrace / tracefs

tracefs 常见路径：

```bash
/sys/kernel/tracing
/sys/kernel/debug/tracing
```

几个文件：

| 文件 | 记录 |
| --- | --- |
| `available_events` | 可用事件 |
| `set_event` | 当前启用事件 |
| `trace` | trace 输出 |
| `trace_pipe` | 实时输出 |
| `current_tracer` | 当前 tracer |

ftrace 可以记录 tracepoint，也可以做 function tracing。使用时要控制范围，避免输出过大。

## BPF

BPF 程序加载进内核前会经过 verifier 检查。程序通过 map 保存状态，通过 helper 调用受限内核功能，通过 program type 决定能挂到哪里。

核心对象：

| 对象 | 记录 |
| --- | --- |
| BPF program | 运行在内核 hook 上的小程序 |
| BPF map | 内核中的 key/value 存储 |
| helper | BPF 程序可调用的内核辅助函数 |
| verifier | 检查 BPF 程序安全性和可终止性 |
| BTF | 类型信息 |
| CO-RE | compile once, run everywhere |
| bpftrace | 面向 tracing 的 BPF 高层工具 |
| libbpf | C/C++ BPF 程序常用库 |

program type 和 hook 要一起看：

| program type / hook | 例子 |
| --- | --- |
| tracepoint | `sched:sched_switch` |
| kprobe | 内核函数入口 |
| uprobe | 用户态函数入口 |
| XDP | 网卡驱动收包早期 |
| tc | qdisc 流量控制层 |
| LSM | 安全检查 hook |
| sched_ext | 调度器扩展 |

## 一条 bpftrace 路径

观察调度切换：

```bash
sudo bpftrace -e 'tracepoint:sched:sched_switch { @[comm] = count(); }'
```

这条命令做的事：

```text
加载 BPF 程序
  |
  v
挂到 sched_switch tracepoint
  |
  v
每次调度切换执行程序
  |
  v
按 comm 聚合计数到 map
  |
  v
用户态读取并打印
```

## 术语表 / 八股检查点

| 名词 | 记录 |
| --- | --- |
| tracing | 动态观察系统事件 |
| tracepoint | 预定义内核事件点 |
| kprobe | 动态内核探针 |
| uprobe | 动态用户态探针 |
| perf event | 性能事件 |
| BPF map | BPF 程序共享状态 |
| helper | BPF 受限辅助函数 |
| verifier | BPF 安全检查器 |
| BTF | BPF 类型信息 |
| CO-RE | 跨内核版本重定位能力 |
| XDP | 网络早期 BPF hook |
| LSM BPF | 安全 hook 上的 BPF |

## 观测入口

```bash
perf list
perf top
perf record -g -- ./program
perf report
```

tracefs：

```bash
sudo cat /sys/kernel/tracing/available_events | head
sudo cat /sys/kernel/tracing/trace_pipe
```

bpftrace：

```bash
sudo bpftrace -l 'tracepoint:sched:*'
sudo bpftrace -e 'tracepoint:syscalls:sys_enter_openat { @[comm] = count(); }'
```

## 源码入口

| 路径 | 内容 |
| --- | --- |
| `kernel/trace/` | ftrace、trace events |
| `kernel/events/` | perf events |
| `kernel/bpf/` | BPF 核心、verifier、map |
| `include/uapi/linux/bpf.h` | BPF UAPI |
| `tools/bpf/` | BPF 工具 |
| `samples/bpf/` | BPF 示例 |

## 本章检查点与参考回答

| 问题 | 参考回答 |
| --- | --- |
| tracepoint 和 kprobe 怎么选？ | tracepoint 是内核预定义事件点，字段稳定，适合长期观测；kprobe 可挂任意内核函数，更灵活，但依赖具体实现和内核版本。 |
| BPF verifier 做什么？ | verifier 在程序加载前检查 BPF 程序的安全性、边界、可终止性、类型和 helper 使用，避免任意内核崩溃或越权访问。 |
| BPF map 有什么用？ | BPF map 是内核中的 key/value 存储，用来在 BPF 程序和用户态之间共享计数、状态、配置和聚合结果。 |
| bpftrace 和 libbpf 怎么分？ | bpftrace 适合快速 tracing 和临时排查；libbpf 适合写结构化、可发布、长期运行的 BPF 工具。 |
| perf 和 BPF 的关系是什么？ | perf 偏采样、性能事件和调用栈分析；BPF 能在 hook 点执行自定义过滤和聚合。二者都可用于性能观测，使用层次不同。 |

## 本章参考

- [Linux kernel documentation: BPF](https://docs.kernel.org/bpf/)
- [Linux kernel documentation: Tracing](https://docs.kernel.org/trace/index.html)
- [bpftrace documentation](https://bpftrace.org/docs/)
- Brendan Gregg, *Systems Performance*
- [小林 Code：图解系统](https://xiaolincoding.com/os/)
