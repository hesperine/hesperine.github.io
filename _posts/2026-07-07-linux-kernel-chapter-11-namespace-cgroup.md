---
title: Linux 内核学习笔记（十一）：namespace、cgroup 与容器机制
date: 2026-07-07 17:57:00 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, Namespace, cgroup, Container]
---

容器是一组 Linux 机制的组合。namespace 管进程能看见什么，cgroup 管进程能用多少资源，再加上 capabilities、seccomp、LSM、rootfs、mount 等机制，形成容器运行环境。

三层阅读线索：

| 层次 | 本章对应内容 |
| --- | --- |
| 小林 Code / 八股 | 进程隔离、资源限制、容器与虚拟机差异 |
| OSTEP / 教材 | 资源虚拟化、保护、隔离和受控共享 |
| Linux 实现 | namespace、cgroup v2、controller、capability、seccomp、rootfs |

## OS 抽象

隔离和资源控制是两个不同问题：

| 问题 | 说明 |
| --- | --- |
| 隔离 | 进程看到的 PID、网络、挂载点、用户、主机名是否独立 |
| 限制 | CPU、内存、I/O 等资源能用多少 |
| 权限 | 进程能执行哪些特权操作 |
| 文件系统视图 | 根目录和挂载点是什么 |

namespace 解决隔离视图，cgroup 解决资源控制和统计。

## namespace

常见 namespace：

| namespace | 隔离内容 |
| --- | --- |
| PID | 进程号视图 |
| mount | 挂载点视图 |
| network | 网络设备、路由表、端口等 |
| user | uid/gid 和 capability 映射 |
| UTS | hostname、domainname |
| IPC | System V IPC、POSIX message queue |
| cgroup | cgroup 层级视图 |
| time | 时间 namespace |

一个进程属于多个 namespace。`/proc/<pid>/ns` 可以看到它的 namespace 入口。

```bash
ls -l /proc/<pid>/ns
```

## cgroup v2

cgroup 把进程组织成层级，并在层级上施加资源控制。

常见 controller：

| controller | 控制内容 |
| --- | --- |
| cpu | CPU 权重、配额 |
| memory | 内存限制、统计、OOM |
| io | 块 I/O 权重和限制 |
| pids | 进程数量 |
| cpuset | CPU 和 NUMA node 绑定 |

cgroup v2 使用统一层级。容器运行时通常把容器进程放入某个 cgroup，并设置 `memory.max`、`cpu.max`、`pids.max` 等文件。

```bash
cat /proc/<pid>/cgroup
findmnt -t cgroup2
```

## 容器启动路径

简化容器启动：

```text
runtime
  |
  +-- clone/clone3 创建带 namespace 的进程
  +-- 设置 rootfs / mount
  +-- 设置 cgroup 限制
  +-- 设置 capability / seccomp
  +-- execve() 容器入口程序
```

容器里的 PID 1 可能在宿主机上是一个普通 pid。PID namespace 让它在容器视图里看到自己是 1。

## CPU 和内存限制

CPU controller 可以用权重或配额控制 CPU 使用。memory controller 控制内存上限和 OOM 行为。

```text
memory.max
memory.current
memory.events

cpu.max
cpu.weight
```

容器内看到的内存不足，可能来自 cgroup 限制，不一定是宿主机整机内存耗尽。

## 术语表 / 八股检查点

| 名词 | 记录 |
| --- | --- |
| namespace | 资源视图隔离机制 |
| cgroup | 资源控制和统计机制 |
| container | namespace + cgroup + rootfs + 权限限制等组合 |
| PID namespace | 隔离 PID 视图 |
| mount namespace | 隔离挂载点 |
| network namespace | 隔离网络栈视图 |
| user namespace | 隔离 uid/gid 和 capability 映射 |
| cgroup v2 | 统一层级的 cgroup |
| controller | cgroup 资源控制器 |
| capability | Linux 特权拆分 |
| seccomp | 限制 syscall 的机制 |
| rootfs | 容器看到的根文件系统 |

## 观测入口

```bash
ls -l /proc/<pid>/ns
cat /proc/<pid>/cgroup
cat /proc/<pid>/status
```

cgroup v2：

```bash
findmnt -t cgroup2
cat /sys/fs/cgroup/cgroup.controllers
```

进 namespace：

```bash
nsenter -t <pid> -p -m -n sh
```

## 源码入口

| 路径 | 内容 |
| --- | --- |
| `kernel/nsproxy.c` | namespace 组合入口 |
| `kernel/pid_namespace.c` | PID namespace |
| `fs/namespace.c` | mount namespace |
| `net/core/net_namespace.c` | network namespace |
| `kernel/cgroup/` | cgroup 核心 |
| `kernel/cgroup/cgroup.c` | cgroup v2 主体 |

## 本章检查点与参考回答

| 问题 | 参考回答 |
| --- | --- |
| namespace 和 cgroup 的区别是什么？ | namespace 管进程能看到什么资源视图；cgroup 管进程能使用多少资源，并提供统计和限制。 |
| 容器是一个内核对象吗？ | 容器通常是多个 Linux 机制的组合，包括 namespace、cgroup、rootfs、capability、seccomp、LSM 等，并非单一内核结构。 |
| 为什么容器里进程看到自己是 PID 1？ | PID namespace 提供独立 PID 视图。同一个 task 在宿主机和容器 namespace 中可以有不同 PID。 |
| cgroup OOM 和系统 OOM 怎么分？ | cgroup OOM 是某个 cgroup 超过内存限制；系统 OOM 是整机内存压力无法回收。容器 OOM 不一定代表宿主机内存耗尽。 |
| user namespace 有什么用？ | user namespace 允许容器内 uid/gid 和宿主机 uid/gid 映射不同，配合 capability 降低特权操作风险。 |

## 本章参考

- [Linux kernel documentation: cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)
- [Linux namespaces man page](https://man7.org/linux/man-pages/man7/namespaces.7.html)
- [小林 Code：图解系统](https://xiaolincoding.com/os/)
- Michael Kerrisk, *The Linux Programming Interface*
