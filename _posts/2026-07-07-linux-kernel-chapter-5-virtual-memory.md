---
title: Linux 内核学习笔记（五）：虚拟内存、VMA 与 page fault
date: 2026-07-07 17:51:00 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, Memory Management, Virtual Memory, mmap]
---

虚拟内存把进程使用的地址和机器上的物理内存分开。用户程序看到的是一段连续的虚拟地址空间；内核用 VMA、页表和 page fault 把这些虚拟地址按需映射到物理页、文件页或共享页。

内存管理的第一条主线是地址翻译：用户态指针是虚拟地址，CPU/MMU 查页表得到物理地址。第二条主线是按需分配：虚拟地址范围可以先存在，物理页等第一次访问时再分配或加载。第三条主线是权限和隔离：每个进程有自己的地址空间，页表项记录读写执行权限。

## OS 抽象

地址空间是进程看到的内存视图。典型布局包括代码段、只读数据、全局数据、堆、mmap 区域、共享库、用户栈。

```text
低地址
  text / rodata / data
  heap
  mmap area
  shared libraries
  stack
高地址
```

分页把虚拟地址空间切成固定大小的页。页表记录虚拟页到物理页的映射，以及读、写、执行、用户态可访问等权限。TLB 缓存最近使用的地址翻译结果。

page fault 是访问虚拟地址时由 CPU 触发的异常。它可以表示非法访问，也可以表示合法的按需分配、文件页加载或 COW。

## Linux 对象

Linux 用 `mm_struct` 表示一个进程的用户地址空间，用 `vm_area_struct` 表示一段连续虚拟地址区域。

```text
task_struct
  |
  v
mm_struct
  |
  +-- VMA: text, r-x
  +-- VMA: heap, rw-
  +-- VMA: file mapping, r-- / rw-
  +-- VMA: stack, rw-
  +-- page table
```

几个对象：

| 对象 | 记录 |
| --- | --- |
| `mm_struct` | 整个用户地址空间，包含 VMA 集合和页表入口 |
| `vm_area_struct` | 一段连续虚拟地址区域，记录范围、权限、映射来源 |
| page table | 虚拟页到物理页的映射和权限 |
| PTE | 页表项，记录物理页、权限、present 等状态 |
| `struct page` | 内核表示物理页的结构 |
| `mmap()` | 创建或修改虚拟地址区域的用户态接口 |

VMA 描述“这段地址是否合法、权限是什么、背后是什么”。页表描述“某个虚拟页当前映射到哪个物理页”。一个地址可以落在合法 VMA 内，但页表还没有 present 映射；第一次访问时触发 page fault，内核再补齐。

## mmap 区域

`mmap` 区域是由 `mmap()` 或动态链接器等路径建立的虚拟地址区间。它可以映射文件，也可以映射匿名内存。

常见类型：

| 类型 | 例子 |
| --- | --- |
| file-backed mapping | 共享库、`mmap()` 文件、可执行文件段 |
| anonymous mapping | 大块堆内存、线程栈、匿名共享内存 |
| private mapping | 写入时 COW，不直接改底层文件 |
| shared mapping | 多个进程可见同一份修改，常用于共享内存或文件映射 |

`/proc/<pid>/maps` 里每一行大体对应一个 VMA：

```text
address-range perms offset dev inode pathname
```

`perms` 里的 `rwxp/s` 分别表示读、写、执行、private/shared。`[heap]`、`[stack]`、共享库路径、匿名映射分别对应不同来源的 VMA。

## 一条 page fault 路径

进程访问一个虚拟地址：

```text
用户态 load/store
  |
  v
MMU 查页表
  |
  +-- 命中且权限满足 -> 访问物理页
  |
  +-- 缺页或权限不满足 -> page fault
```

进入 page fault 后，Linux 会根据当前 task 的 `mm_struct` 查找 VMA。

```text
page fault
  |
  v
找到 current->mm
  |
  v
按 fault address 查 VMA
  |
  +-- 没有 VMA -> SIGSEGV
  |
  +-- 权限不匹配 -> SIGSEGV
  |
  +-- 合法匿名页 -> 分配物理页并映射
  |
  +-- 合法文件页 -> 从 page cache / 文件建立映射
  |
  +-- COW 写入 -> 分配新页，复制旧内容，更新页表
```

合法 fault 处理完后返回原指令重新执行。用户态看到的效果是那条 load/store 继续成功。

## COW

copy-on-write 用在 `fork()`、private file mapping 等场景。父子进程逻辑上拥有各自地址空间，但一开始可以共享同一批只读物理页。某一方写入时触发写保护 page fault，内核分配新页，把旧内容复制过去，再把当前进程的页表改成可写新页。

```text
fork 后
父 PTE -> 物理页 X，只读
子 PTE -> 物理页 X，只读

子进程写入
  -> write fault
  -> 分配物理页 Y
  -> copy X to Y
  -> 子 PTE -> Y，可写
```

COW 的意义是减少 `fork()` 的立即复制成本。很多 fork 后马上 exec 的场景，不需要复制完整地址空间。

## 术语表 / 八股检查点

| 名词 | 记录 |
| --- | --- |
| virtual memory | 进程看到的虚拟内存机制 |
| address space | 一个进程的虚拟地址布局 |
| VMA | 一段连续虚拟地址区域 |
| page table | 虚拟页到物理页的映射表 |
| PTE | 页表项 |
| TLB | CPU 缓存地址翻译结果的结构 |
| page fault | 地址翻译或权限检查失败后进入内核的异常 |
| minor fault | 不需要磁盘 I/O 就能处理的缺页 |
| major fault | 需要从磁盘等慢设备读取数据的缺页 |
| anonymous page | 不直接来自文件的内存页 |
| file-backed page | 背后有文件的映射页 |
| COW | 写入时复制 |
| RSS | 进程实际驻留物理内存页量 |
| PSS | 共享页按比例分摊后的内存统计 |

## 观测入口

```bash
cat /proc/<pid>/maps
cat /proc/<pid>/smaps
pmap -x <pid>
cat /proc/<pid>/stat
```

看 page fault 统计：

```bash
perf stat -e page-faults,minor-faults,major-faults ./program
```

看系统内存：

```bash
free -h
vmstat 1
cat /proc/meminfo
```

## 源码入口

| 路径 | 内容 |
| --- | --- |
| `include/linux/mm_types.h` | `mm_struct`、`vm_area_struct` 等结构 |
| `mm/mmap.c` | VMA 创建、修改、`mmap()` 相关路径 |
| `mm/memory.c` | page fault、页表、COW 等核心路径 |
| `arch/x86/mm/fault.c` | x86 page fault 入口 |
| `fs/proc/task_mmu.c` | `/proc/<pid>/maps`、`smaps` 输出 |

## 本章检查点与参考回答

| 问题 | 参考回答 |
| --- | --- |
| 虚拟内存解决什么问题？ | 虚拟内存给每个进程提供独立地址空间，把程序使用的虚拟地址和机器物理内存分开，同时支持隔离、权限控制、按需分配、文件映射和共享内存。 |
| VMA 和页表有什么区别？ | VMA 记录一段虚拟地址范围是否合法、权限是什么、映射来源是什么；页表记录具体虚拟页当前映射到哪个物理页以及页级权限。 |
| mmap 区域是什么？ | mmap 区域是通过 `mmap()` 或装载器建立的虚拟地址区间，可以映射文件、共享库、匿名内存或共享内存，在 `/proc/<pid>/maps` 里通常对应一行 VMA。 |
| page fault 一定很坏吗？ | page fault 是正常内存管理机制的一部分。匿名页按需分配、文件页按需加载、COW 都依赖 page fault；非法访问才会变成 `SIGSEGV`。 |
| COW 的核心过程是什么？ | fork 后父子进程先共享只读物理页；某一方写入时触发写保护 fault，内核分配新页、复制内容、更新当前进程页表。 |

## 本章参考

- [Linux kernel documentation: Memory Management](https://docs.kernel.org/mm/index.html)
- [Operating Systems: Three Easy Pieces](https://pages.cs.wisc.edu/~remzi/OSTEP/)
- [小林 Code：图解系统](https://xiaolincoding.com/os/)
- Michael Kerrisk, *The Linux Programming Interface*
- Robert Love, *Linux Kernel Development*
