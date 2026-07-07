---
title: Linux 内核学习笔记（三）：进程模型与 task 生命周期
date: 2026-07-07 17:40:00 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, Process, Thread, Scheduler]
---

进程模型关注内核如何表示和管理“正在执行的控制流”。在进程、线程和调度这条线里，主要入口是 task。Linux 用 `task_struct` 保存 task 的状态和资源引用：调度器调度它，系统调用路径通过 `current` 找到它，`fork()` / `clone()` 创建它，`execve()` 替换它的用户态程序映像，`exit()` 和 `wait()` 完成退出与回收。

OS 抽象里，进程是资源边界，线程是共享同一进程资源的执行流。Linux 实现里，调度器直接面对 task；进程和线程的差异主要落在这些 task 共享哪些资源。

这一章对应进程管理模块。小林 Code 里的进程/线程、IPC、多线程冲突、死锁等问题，都可以先落到 task、资源共享和等待/唤醒三条线。

| 八股问题 | 本章落点 |
| --- | --- |
| 进程和线程有什么区别 | task 与资源共享关系 |
| fork 和 exec 有什么区别 | `copy_process()` 与 `execve()` 替换映像 |
| 进程有哪些状态 | task state、exit state、zombie |
| 线程共享哪些资源 | `mm_struct`、`files_struct`、signal 等 |
| 进程间通信有哪些方式 | pipe、socket、signal、shared memory、futex 等后续章节继续展开 |

## 术语表 / 八股检查点

| 名词 | 记录 |
| --- | --- |
| process | 程序的一次运行实例，也是地址空间、fd、权限等资源边界 |
| thread | 同一进程内的执行流，共享地址空间等资源 |
| task | Linux 内核可调度的执行实体 |
| `task_struct` | task 在内核中的核心数据结构 |
| pid | 单个 task 的标识 |
| tgid | thread group id，通常对应用户态看到的进程 id |
| thread group | 属于同一进程的一组 task |
| `fork()` | 创建资源隔离较强的新进程 |
| `clone()` / `clone3()` | 按 flags 创建新 task，并控制资源共享 |
| `execve()` | 在当前 task 上替换用户态程序映像 |
| zombie | task 已退出，退出状态等待父进程回收 |
| orphan | 父进程退出后仍在运行、被重新托管的进程 |
| COW | copy-on-write，写入时复制物理页 |
| signal mask | 当前线程屏蔽哪些信号 |
| pending signal | 已产生但尚未投递处理的信号 |

## task 是什么

task 是 Linux 内核可调度、可阻塞、可唤醒的执行实体。它有自己的执行状态，能进入运行、睡眠、停止、退出等状态；它也挂着一组资源引用，例如地址空间、文件表、信号、权限、namespace、cgroup。

用户态的“进程”和“线程”是资源组织方式。内核调度器直接面对的是 task。一个普通单线程进程通常对应一个 task；一个多线程进程对应多个 task，这些 task 共享同一个地址空间和部分进程资源；`fork()` 创建资源隔离更强的新 task，`clone()` / `clone3()` 通过 flags 控制新 task 和旧 task 共享哪些资源。

这一点只在进程/线程/调度主题内成立。Linux 内核没有唯一的“全局核心对象”：内存管理看 `mm_struct`、VMA、`struct page`，文件系统看 `struct file`、inode、dentry，网络栈看 socket、`sk_buff`。进程模型里先抓 task，是因为创建、运行、阻塞、唤醒、退出这些动作都要落到 task 上。

## task_struct 记录什么

`task_struct` 是 task 在内核里的具体数据结构。系统调用路径通过 `current` 找到当前 task，`/proc/<pid>` 里的很多信息也来自 task 及其挂着的资源对象。

一条简化关系：

```text
task_struct
  |
  +-- pid / tgid
  +-- state / exit_state
  +-- sched fields
  +-- mm / active_mm
  +-- files
  +-- fs
  +-- signal / sighand
  +-- cred
  +-- nsproxy / cgroups
  +-- parent / children / sibling
```

几个字段先分组记：

| 方向 | 典型对象 |
| --- | --- |
| 身份 | pid、tgid、comm |
| 调度 | state、policy、priority、调度实体 |
| 内存 | `mm_struct`、用户地址空间、VMA |
| 文件 | `files_struct`、fd table、`struct file` |
| 文件系统上下文 | 当前目录、root、umask |
| 信号 | signal state、signal handlers |
| 权限 | uid/gid、capability、LSM 相关状态 |
| 层级关系 | parent、children、thread group |
| 隔离和资源控制 | namespace、cgroup |

`task_struct` 本身很大。当前记录按“执行流 + 资源引用 + 调度状态 + 层级关系”这四组入口展开。

## pid、tgid、线程组

用户态经常说 PID。Linux 内核里需要同时区分单个 task 的 id 和线程组的 id。

| 名字 | 含义 |
| --- | --- |
| pid | 单个 task 的内核可见标识 |
| tgid | thread group id，通常对应用户态看到的进程 id |
| thread group | 共享部分资源、属于同一进程的一组 task |

一个单线程进程里，pid 和 tgid 通常相同。多线程进程里，每个线程是一个 task，有自己的 pid；这些 task 共享同一个 tgid。`ps` 默认更偏向进程视图，`ps -eLf` 或 `/proc/<pid>/task` 会把线程展开。

观察入口：

```bash
ps -o pid,ppid,tid,tgid,stat,comm -p <pid>
ps -eLf | head
ls /proc/<pid>/task
cat /proc/<pid>/status
```

`/proc/<pid>/status` 里可以看到 `Pid`、`Tgid`、`PPid`、`Threads`。这些字段适合用来确认“一个用户态进程”下面到底有几个内核可调度 task。

## fork：复制当前执行环境

`fork()` 创建子进程。子进程从父进程复制出一份执行环境，包括地址空间视图、文件表引用、信号状态、权限等。复制并不意味着立即把所有物理内存复制一遍；用户地址空间通常通过 copy-on-write 延迟复制。

简化路径：

```text
用户态 fork()
  |
  v
syscall
  |
  v
copy_process()
  |
  +-- 分配新的 task_struct
  +-- 复制或共享部分资源
  +-- 设置父子关系
  +-- 放入可运行状态
  |
  v
父进程返回子进程 pid
子进程返回 0
```

fork 之后父子进程的几个边界：

| 对象 | fork 后关系 |
| --- | --- |
| 地址空间 | 逻辑上分离，物理页可通过 copy-on-write 暂时共享 |
| fd table | 子进程继承打开 fd，底层 `struct file` 可能共享 |
| file offset | 共享同一个 `struct file` 时，offset 也共享 |
| pid | 父子不同 |
| parent/child | 子进程挂到父进程 children 关系上 |

copy-on-write 的关键点是写入时复制。父子进程一开始可以共享只读映射到同一物理页的页表项；某一方写入时触发 page fault，内核再分配新页并复制内容。

## clone：用 flags 定义共享关系

`clone()` / `clone3()` 是 Linux 创建新 task 的底层接口。fork、线程创建、部分容器相关创建路径，都可以理解成不同 flags 组合下的新 task 创建。

典型 flags：

| flag | 共享内容 |
| --- | --- |
| `CLONE_VM` | 地址空间 |
| `CLONE_FILES` | 文件描述符表 |
| `CLONE_FS` | cwd、root、umask 等文件系统上下文 |
| `CLONE_SIGHAND` | 信号处理表 |
| `CLONE_THREAD` | 放入同一个线程组 |
| `CLONE_NEWNS` | 创建新的 mount namespace |
| `CLONE_NEWPID` | 创建新的 PID namespace |
| `CLONE_NEWNET` | 创建新的 network namespace |

pthread 创建线程时，底层会创建一个新 task，并让它和同进程内其他线程共享地址空间、文件表等资源。线程之间能看到同一份全局变量，根源是共享 `mm_struct`；线程之间可能共享 fd，根源是共享或继承 `files_struct`。

## execve：替换用户态程序映像

`execve()` 在当前 task 上加载新的用户态程序映像。pid 仍然是当前 task 的 pid，但用户态地址空间、代码、数据、堆栈会换成新程序的内容。shell 执行命令时常见组合是 fork 后在子进程里 exec。

典型关系：

```text
shell
  |
  | fork()
  v
child process
  |
  | execve("/bin/ls", ...)
  v
同一个 child task，新的用户态程序映像
```

`execve()` 会重建用户地址空间，加载 ELF，设置用户栈和参数环境。打开文件描述符默认会继承，带 `FD_CLOEXEC` 标记的 fd 会在 exec 时关闭。

几个检查点：

| 检查点 | 说明 |
| --- | --- |
| 可执行文件路径 | 路径解析和权限检查 |
| ELF 装载 | 代码段、数据段、动态链接器 |
| 用户栈 | argv、envp、auxv |
| fd 继承 | `FD_CLOEXEC` 决定 exec 时是否关闭 |
| 凭据变化 | setuid/setgid、capability、LSM 检查 |

## exit 和 wait：结束、僵尸、回收

进程结束时，当前 task 进入退出路径。内核释放大部分资源，但会保留一小部分退出状态，供父进程 `wait()` 读取。这个已退出、等待父进程回收的状态就是 zombie。

状态关系：

```text
RUNNING
  |
  | exit()
  v
EXIT_ZOMBIE
  |
  | parent wait()
  v
释放最后的 task 记录
```

zombie 保留的是 pid、退出码、统计信息等父进程需要读取的内容。地址空间、打开文件等主要运行时资源已经释放。父进程没有及时 wait 时，`ps` 里会看到 `Z` 状态。

观察命令：

```bash
ps -o pid,ppid,stat,comm -p <pid>
cat /proc/<pid>/status
```

孤儿进程会被 reparent，通常由 init/systemd 一类进程接管。父进程退出、子进程仍在运行时，子进程的 PPid 会变化。

## signal：进程模型里的异步事件

signal 是进程/线程模型里绕不开的异步控制机制。它可以来自用户态 `kill()`，也可以来自内核异常路径，例如非法内存访问触发 `SIGSEGV`，管道写端异常触发 `SIGPIPE`。

记录几个边界：

| 概念 | 记录 |
| --- | --- |
| signal disposition | 对某个信号的处理方式：默认、忽略、自定义 handler |
| blocked signal mask | 当前线程屏蔽哪些信号 |
| pending signal | 已产生但尚未投递处理的信号 |
| thread-directed signal | 投递给特定线程 |
| process-directed signal | 投递给进程，由符合条件的线程处理 |

多线程程序里，信号处理会更复杂。每个线程有自己的 signal mask，同一进程共享部分信号处理配置。定位问题时可以先看 `/proc/<pid>/status` 里的 `SigBlk`、`SigIgn`、`SigCgt`。

## 一条生命周期线

把几个 syscall 串起来看：

```text
fork / clone
  |
  v
new task_struct
  |
  +-- 继续运行父进程同一份程序
  |
  +-- execve() 替换成新程序
  |
  v
运行、阻塞、唤醒、被调度
  |
  v
exit()
  |
  v
zombie
  |
  v
wait()
```

这条线和调度器、虚拟内存、文件系统都有连接。fork/clone 连接资源复制和共享；exec 连接 ELF 装载和地址空间重建；exit/wait 连接父子关系和资源释放；运行期间的阻塞/唤醒连接调度器。

## 观察命令

进程和线程：

```bash
ps -eLf
ps -o pid,ppid,tid,tgid,stat,comm -p <pid>
ls /proc/<pid>/task
```

父子关系：

```bash
ps -o pid,ppid,stat,comm --forest
pstree -p
```

地址空间和 fd 继承：

```bash
cat /proc/<pid>/maps
ls -l /proc/<pid>/fd
cat /proc/<pid>/fdinfo/<fd>
```

系统调用路径：

```bash
strace -f -e clone,clone3,fork,vfork,execve,exit_group,wait4 ./program
```

调度状态：

```bash
ps -o pid,tid,stat,wchan,comm -p <pid>
pidstat -w 1
perf sched record -- sleep 3
perf sched latency
```

## 本章检查点与参考回答

| 问题 | 参考回答 |
| --- | --- |
| task、process、thread group、pid、tgid 怎么分？ | task 是 Linux 可调度实体；process 是用户态资源边界视图；thread group 是属于同一进程的一组 task；pid 标识单个 task；tgid 标识线程组，通常是用户态看到的进程 id。 |
| `fork()`、`clone()`、`pthread_create()` 是什么关系？ | `clone()` / `clone3()` 是 Linux 创建 task 的底层接口，通过 flags 控制资源共享；`fork()` 创建资源隔离更强的新进程；`pthread_create()` 是线程库 API，底层创建共享地址空间等资源的新 task。 |
| `execve()` 做了什么？ | `execve()` 在当前 task 上加载新的用户态程序映像，重建地址空间、装载 ELF、设置用户栈和参数环境。pid 仍然属于当前 task，打开 fd 默认继承，带 `FD_CLOEXEC` 的 fd 会关闭。 |
| fork 后地址空间和 fd 怎么处理？ | 地址空间逻辑上分离，物理页通常通过 COW 延迟复制；fd table 会继承，父子进程可能指向同一个 `struct file`，因此共享 file offset。 |
| zombie 是什么？ | zombie 是 task 已经退出但退出状态还没被父进程 `wait()` 回收的状态。地址空间、打开文件等主要资源已经释放，留下 pid、退出码、统计信息等回收所需内容。 |
| signal 在多线程里为什么复杂？ | 每个线程有自己的 signal mask，同一进程共享部分 signal disposition。信号可以投递给特定线程，也可以投递给进程，再由一个符合条件的线程处理。 |

## 源码位置

| 路径 | 内容 |
| --- | --- |
| `include/linux/sched.h` | `task_struct` 相关定义 |
| `include/linux/pid.h` | pid 相关结构 |
| `kernel/fork.c` | fork/clone、task 创建 |
| `fs/exec.c` | execve 和程序装载路径 |
| `kernel/exit.c` | exit、wait、reparent |
| `kernel/signal.c` | signal 投递和处理 |
| `kernel/sched/core.c` | 调度核心路径 |
| `fs/proc/` | `/proc/<pid>` 相关实现 |

源码阅读入口可以按 syscall 串起来：`clone()` / `clone3()` 找 task 创建，`execve()` 找用户态映像替换，`exit_group()` 找退出路径，`wait4()` 找父进程回收。

## 本章参考

- [Linux Kernel Documentation](https://docs.kernel.org/)
- [Linux kernel documentation: Adding a New System Call](https://docs.kernel.org/process/adding-syscalls.html)
- [Linux kernel documentation: Core API](https://docs.kernel.org/core-api/index.html)
- [Operating Systems: Three Easy Pieces](https://pages.cs.wisc.edu/~remzi/OSTEP/)
- [小林 Code：图解系统](https://xiaolincoding.com/os/)
- Michael Kerrisk, *The Linux Programming Interface*
- Robert Love, *Linux Kernel Development*
