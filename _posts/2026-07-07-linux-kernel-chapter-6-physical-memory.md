---
title: Linux 内核学习笔记（六）：物理内存、页分配与回收
date: 2026-07-07 17:52:00 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, Memory Management, Page Allocator, OOM]
---

虚拟内存描述进程看到的地址空间，物理内存管理描述机器上的页怎样被分配、缓存、回收。Linux 用 `struct page` 表示物理页，用 buddy allocator 管连续页框，用 slab/slub 管小对象，用 LRU/reclaim 回收 page cache 和匿名页。

三层阅读线索：

| 层次 | 本章对应内容 |
| --- | --- |
| 小林 Code / 八股 | 内存满了会怎样、物理内存和虚拟内存关系、缓存和回收 |
| OSTEP / 教材 | 物理页管理、空闲空间管理、页替换、swap |
| Linux 实现 | `struct page`、zone/node、buddy allocator、slub、LRU、reclaim、OOM killer |

## OS 抽象

物理内存按页管理。一个进程访问虚拟地址时，最终要落到某个物理页；内核自己也需要内存存放 task、inode、socket、页表、缓冲区等对象。

内存管理要处理几类问题：

| 问题 | 说明 |
| --- | --- |
| 分配 | 给页表、进程匿名页、page cache、内核对象分配内存 |
| 释放 | 引用结束后把页或对象还给分配器 |
| 回收 | 内存紧张时回收可丢弃或可写回的页 |
| 换出 | 把匿名页写到 swap，释放物理页 |
| OOM | 回收失败后选择进程杀掉 |

## Linux 对象

几个入口：

| 对象 | 记录 |
| --- | --- |
| `struct page` | 描述一个物理页框 |
| zone | DMA、Normal、Movable 等内存区域 |
| node | NUMA 节点 |
| buddy allocator | 按 2 的幂阶管理连续物理页 |
| slab/slub | 管理小内核对象缓存 |
| LRU | 页面回收使用的活跃/不活跃链表 |
| reclaim | 内存紧张时回收页 |
| OOM killer | 无法回收足够内存时选择牺牲进程 |

关系可以简化成：

```text
NUMA node
  |
  +-- zone
       |
       +-- buddy free lists
       +-- pages represented by struct page
```

内核分配单页或连续页时走 page allocator。分配 `task_struct`、inode、dentry、socket 等小对象时，通常走 slab/slub cache，底层再向 page allocator 要页。

## buddy allocator

buddy allocator 按 order 管理连续页。order 0 是 1 页，order 1 是 2 页，order 2 是 4 页。分配高 order 页需要连续物理页，内存碎片会让高 order 分配更难。

```text
order 0: 1 page
order 1: 2 pages
order 2: 4 pages
...
```

释放时，相邻且同 order 的空闲块可以合并成更高 order 块。这个机制适合管理页框，但不适合直接管理很多几十字节或几百字节的小对象。

## slab / slub

slab/slub 解决内核小对象分配问题。内核经常分配固定类型对象，例如 dentry、inode、task、socket buffer。为这些类型建立 cache，可以减少初始化成本、碎片和锁竞争。

```text
kmem_cache
  |
  +-- objects of same type/size
  |
  +-- backed by pages from buddy allocator
```

用户态的 `malloc()` 管用户地址空间里的堆；内核的 slab/slub 管内核对象。二者处在不同层次。

## page cache 与回收

page cache 是文件内容在内存里的缓存。读文件时，数据可以先进入 page cache；写文件时，脏页可以先留在内存，之后 writeback 到磁盘。

内存紧张时，内核优先回收容易回收的页：

```text
内存压力
  |
  v
扫描 LRU
  |
  +-- clean file page -> 直接回收
  +-- dirty file page -> 触发 writeback 后回收
  +-- anonymous page -> swap 可用时换出
  +-- pinned / active page -> 暂时保留
```

文件页和匿名页的回收成本不同。clean file page 可以丢弃，因为之后能从文件重新读取；dirty file page 要先写回；匿名页没有文件后备，需要 swap 或保留。

## OOM

回收无法释放足够内存时，OOM killer 会选择进程杀掉以释放资源。选择受内存占用、`oom_score_adj`、cgroup 限制等因素影响。

系统级 OOM 和 cgroup OOM 要分开。容器内存限制触发的 OOM 可能只影响某个 cgroup，不一定是整机内存耗尽。

## 术语表 / 八股检查点

| 名词 | 记录 |
| --- | --- |
| page frame | 物理内存页框 |
| `struct page` | 内核描述物理页的结构 |
| NUMA node | 非一致内存访问拓扑中的节点 |
| zone | 按用途和地址范围划分的内存区域 |
| order | buddy allocator 中连续页数量的阶 |
| buddy allocator | 管理连续物理页的分配器 |
| slab/slub | 管理内核小对象的分配器 |
| page cache | 文件内容在内存中的缓存 |
| dirty page | 内容已修改但尚未写回后备存储的页 |
| reclaim | 内存压力下回收页 |
| swap | 匿名页换出到磁盘区域 |
| compaction | 移动页以整理连续物理内存 |
| OOM | out of memory |

## 观测入口

```bash
free -h
cat /proc/meminfo
vmstat 1
cat /proc/buddyinfo
cat /proc/slabinfo
```

进程内存：

```bash
cat /proc/<pid>/status
cat /proc/<pid>/smaps
pmap -x <pid>
```

OOM 和内核日志：

```bash
dmesg | grep -i oom
cat /proc/<pid>/oom_score
cat /proc/<pid>/oom_score_adj
```

## 源码入口

| 路径 | 内容 |
| --- | --- |
| `include/linux/mm_types.h` | `struct page` 等内存结构 |
| `mm/page_alloc.c` | buddy allocator、页分配 |
| `mm/slub.c` | slub 分配器 |
| `mm/vmscan.c` | reclaim 扫描 |
| `mm/oom_kill.c` | OOM killer |
| `mm/swapfile.c` | swap 相关路径 |

## 本章检查点与参考回答

| 问题 | 参考回答 |
| --- | --- |
| 虚拟内存管理和物理内存管理怎么分？ | 虚拟内存管理关注进程看到的地址空间、VMA、页表和 fault；物理内存管理关注机器上的物理页、内核对象分配、page cache、回收和 OOM。 |
| buddy allocator 解决什么问题？ | buddy allocator 管理连续物理页，按 order 分配和合并页块，适合页级分配，但不适合大量小对象直接分配。 |
| slab/slub 解决什么问题？ | slab/slub 为固定类型或大小的内核对象建立 cache，减少小对象分配碎片和初始化成本，底层仍然向页分配器要内存。 |
| page cache 为什么会占很多内存？ | Linux 会用空闲内存缓存文件数据，提升读写性能。clean file page 在内存压力下可以直接丢弃，所以 page cache 大不等于内存泄漏。 |
| OOM 什么时候发生？ | 内核在内存压力下回收、写回、换出仍无法获得足够内存时，会触发 OOM killer。cgroup 内存限制也可能触发局部 OOM。 |

## 本章参考

- [Linux kernel documentation: Memory Management](https://docs.kernel.org/mm/index.html)
- [Operating Systems: Three Easy Pieces](https://pages.cs.wisc.edu/~remzi/OSTEP/)
- [小林 Code：图解系统](https://xiaolincoding.com/os/)
- Brendan Gregg, *Systems Performance*
- Robert Love, *Linux Kernel Development*
