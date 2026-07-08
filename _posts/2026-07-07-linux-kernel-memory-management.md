---
title: Linux 内核学习笔记：内存管理阅读批注
date: 2026-07-07 17:25:00 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, Operating System, Virtual Memory, Memory Management]
---

这一篇按小林 Code《图解系统》第三章“内存管理”的顺序记：虚拟内存、分段、分页、多级页表、TLB、段页式内存管理、Linux 内存管理。小林 Code 负责基础概念和常见问法，OSTEP 负责把机制抽象清楚，Linux 部分记录真实对象、源码入口和可观察现象。

## 问题索引

| 小林 Code 主题 | 本篇记录 |
| --- | --- |
| 虚拟内存 | 虚拟地址、物理地址、MMU、地址空间 |
| 内存分段 | 代码段、数据段、堆、栈；外部碎片和交换成本 |
| 内存分页 | page、page frame、page table、PTE |
| 多级页表 | 稀疏地址空间下如何减少页表内存 |
| TLB | 地址翻译缓存、TLB miss、TLB shootdown |
| 段页式内存管理 | 分段表达逻辑区域，分页负责实际映射 |
| Linux 内存管理 | `mm_struct`、VMA、page fault、COW、page cache、`mmap` |

## 1. 虚拟内存：进程看到的地址空间

程序里看到的地址通常是虚拟地址。CPU 执行 load/store 时，硬件 MMU 根据页表把虚拟地址翻译成物理地址，再访问真实内存。

| 名词 | 记录 |
| --- | --- |
| 虚拟地址 | 进程指令里使用的地址，由进程地址空间定义 |
| 物理地址 | 内存硬件上的真实地址 |
| 地址空间 | 一个进程可见的虚拟地址范围，以及各段区域的权限和映射关系 |
| MMU | CPU 内的内存管理单元，负责地址翻译和权限检查 |
| 页表 | 虚拟页到物理页框的映射表，通常由内核维护、硬件读取 |

虚拟内存提供三类基础能力。

| 能力 | 具体含义 |
| --- | --- |
| 隔离 | 每个进程拥有自己的虚拟地址空间，普通用户态代码不能直接访问其他进程内存 |
| 权限 | 页表项可以标记可读、可写、可执行、用户态可访问等属性 |
| 按需分配 | 虚拟地址范围可以先建立，物理页等到真正访问时再分配 |

OSTEP 里通常把虚拟化看成 OS 的核心抽象之一：CPU 被抽象成进程，内存被抽象成地址空间，磁盘被抽象成文件。内存虚拟化的关键点在于，程序使用连续、私有的地址空间，OS 和硬件共同完成映射、保护和异常处理。

Linux 批注：

| Linux 对象 | 作用 |
| --- | --- |
| `task_struct->mm` | 指向当前进程的用户地址空间描述 |
| `struct mm_struct` | 记录页表根、VMA 树、用户地址空间统计、锁等信息 |
| `struct vm_area_struct` | 描述一段连续虚拟地址区域及其权限、来源和操作 |
| page table | 架构相关页表，x86-64 常见为多级页表 |
| page fault handler | 处理缺页、权限错误、写时复制、按需加载等情况 |

源码入口可以先记这些路径：`include/linux/mm_types.h` 看 `mm_struct` 和 `vm_area_struct`，`mm/mmap.c` 看 VMA 管理，`mm/memory.c` 看缺页和页表操作主线，`arch/x86/mm/fault.c` 看 x86 page fault 入口。

## 2. 分段：按逻辑区域管理内存

分段把程序内存按逻辑含义切分，比如代码段、数据段、堆、栈。每个段有基址、长度和权限。

| 段 | 常见内容 | 权限倾向 |
| --- | --- | --- |
| text | 指令代码 | 只读、可执行 |
| rodata | 常量数据 | 只读 |
| data | 已初始化全局变量 | 可读写 |
| bss | 未初始化全局变量 | 可读写，初始为 0 |
| heap | 动态分配内存 | 可读写，向高地址扩展较常见 |
| stack | 函数调用栈、局部变量、返回地址 | 可读写，向低地址扩展较常见 |

分段模型的主要问题是外部碎片。段大小不固定，内存分配和释放后会留下大小不一的空洞。交换整个段时，搬运成本也可能很高。

Linux 批注：现代 x86-64 Linux 对普通用户进程主要使用平坦分段模型。分段机制仍有架构历史和少量用途，但内存隔离、权限和映射主要依赖分页。学习 Linux 内存管理时，重点放在 VMA 和页表。

## 3. 分页：固定大小的映射单位

分页把虚拟地址空间切成固定大小的虚拟页，把物理内存切成同样大小的页框。Linux 常见基础页大小是 4KB，实际机器也可能使用 huge page。

| 名词 | 记录 |
| --- | --- |
| page | 虚拟地址空间中的固定大小页 |
| page frame | 物理内存中的固定大小页框 |
| PTE | page table entry，页表项 |
| page offset | 页内偏移，翻译前后不变 |

一个虚拟地址可以拆成“虚拟页号 + 页内偏移”。MMU 用虚拟页号查页表得到物理页框号，再拼上页内偏移形成物理地址。

| 页表项信息 | 作用 |
| --- | --- |
| present | 该虚拟页当前是否有有效物理映射 |
| writable | 是否允许写 |
| user | 用户态是否可访问 |
| executable / NX | 是否允许取指执行 |
| dirty | 页是否被写过 |
| accessed | 页是否被访问过 |

分页减少了外部碎片，物理页可以分散放置。内部碎片仍然存在：一个分配不到整页的数据，也会占用页内剩余空间。

## 4. 多级页表：为稀疏地址空间省内存

单级页表需要覆盖整个虚拟地址空间。地址空间很大、实际使用区域很少时，单级页表会浪费大量内存。多级页表把页表拆成树状结构，只为实际使用的地址范围分配下级页表页。

| 模型 | 特点 |
| --- | --- |
| 单级页表 | 查询简单，但需要为整个地址空间保留页表 |
| 多级页表 | 只给已使用范围分配页表页，查询需要逐级走表 |
| TLB | 缓存翻译结果，降低多级页表遍历成本 |

x86-64 上常见页表层级可以记成 PGD、P4D、PUD、PMD、PTE。具体层级数量会随架构配置变化，Linux 源码通过通用宏和架构代码屏蔽一部分差异。

Linux 批注：

| 入口 | 记录 |
| --- | --- |
| `Documentation/mm/page_tables.rst` | Linux 页表层级说明 |
| `include/linux/pgtable.h` | 通用页表操作接口 |
| `arch/x86/include/asm/pgtable*.h` | x86 页表结构和宏 |
| `mm/memory.c` | 建立、复制、释放、修改页表的主路径 |

## 5. TLB：地址翻译缓存

TLB 是 CPU 缓存的页表翻译结果。没有 TLB 时，每次访存都可能伴随多级页表遍历；命中 TLB 后，虚拟页到物理页框的翻译可以快速完成。

| 现象 | 记录 |
| --- | --- |
| TLB hit | 翻译结果在 TLB 中，访存路径短 |
| TLB miss | 需要走页表，成本更高 |
| context switch | 切换地址空间时，旧进程的 TLB 项可能不能继续使用 |
| TLB shootdown | 多核上修改页表后，需要让其他 CPU 上的旧 TLB 项失效 |

TLB 把内存管理和调度联系起来。进程切换不只保存寄存器，还可能影响地址空间、页表根和 TLB 热度。同一个进程的线程共享地址空间，线程切换通常不需要切换 `mm_struct`；不同进程切换通常涉及不同地址空间。

## 6. Linux 地址空间：VMA 和 mmap 区域

Linux 用 VMA 描述一段连续虚拟地址区域。`/proc/<pid>/maps` 里看到的每一行，大体可以理解为一个 VMA 或 VMA 的用户态展示。

| 区域 | 来源 |
| --- | --- |
| 可执行文件 text/data | `execve()` 装载 ELF 时建立 |
| heap | `brk()` / `sbrk()` 扩展传统堆区域 |
| mmap 区域 | `mmap()` 建立的文件映射、匿名映射、共享库映射 |
| stack | 线程栈 |
| vvar / vdso | 内核提供给用户态的特殊映射 |

`mmap` 区域是一段由 `mmap()` 创建的虚拟地址范围。它可以映射文件，也可以映射匿名内存。

| mmap 类型 | 含义 | 常见场景 |
| --- | --- | --- |
| 文件映射 | 虚拟页关联到文件内容 | 共享库、内存映射文件、数据库文件 |
| 匿名映射 | 虚拟页没有文件来源 | malloc 大块内存、线程栈、JIT 内存 |
| 私有映射 | 写入时触发 COW，不直接修改原文件或原共享页 | 进程私有数据、共享库私有重定位 |
| 共享映射 | 多个进程共享修改，文件映射可写回文件 | 共享内存、mmap 文件通信 |

`mmap()` 成功后，通常只是建立虚拟地址区域和权限记录。物理页可以等第一次访问时通过 page fault 分配或装入。

## 7. page fault：异常、分配和权限检查

page fault 是当前指令访问虚拟地址时触发的异常。它不等于程序错误。缺页、按需分配、COW 都依赖 page fault。

| 场景 | Linux 处理 |
| --- | --- |
| 访问尚未分配物理页的匿名映射 | 分配物理页，清零，建立 PTE |
| 访问文件映射但页不在内存 | 从 page cache 或文件系统路径装入 |
| `fork()` 后写私有页 | 触发 COW，复制物理页，更新当前进程 PTE |
| 访问无权限地址 | 发送 `SIGSEGV` 或返回错误 |
| 内核访问坏用户指针 | syscall 返回 `-EFAULT` 等错误 |

简化路径可以记成：CPU 触发 page fault，架构入口保存异常信息，内核定位当前 `mm_struct` 和 VMA，检查访问权限，再根据 VMA 类型进入匿名页、文件页、COW 或错误处理。

| 源码入口 | 记录 |
| --- | --- |
| `arch/x86/mm/fault.c` | x86 page fault 入口 |
| `mm/memory.c` | `handle_mm_fault()` 等主线 |
| `mm/filemap.c` | 文件页和 page cache 相关路径 |
| `mm/mmap.c` | VMA 查找、插入、拆分、合并 |

## 8. page cache：文件 I/O 和内存管理的交界

page cache 是内核用内存缓存文件内容的机制。普通 `read()` 读文件时，数据常常先进入 page cache，再拷贝到用户缓冲区。文件 `mmap()` 后，用户态访问映射区域也可能直接命中 page cache 中的页。

| 路径 | 和 page cache 的关系 |
| --- | --- |
| `read()` | 从 page cache 拷贝到用户缓冲区；miss 时触发文件系统读盘 |
| `write()` | 写入 page cache，把页标记为 dirty，之后 writeback |
| file-backed `mmap()` | 用户虚拟页映射到文件 page cache 页 |
| reclaim | 内存压力下回收干净文件页，脏页需要先写回 |

这个点很容易把文件系统和内存管理串起来：文件页既是文件系统缓存，也是进程地址空间里可能映射的物理页。

## 9. 观测入口

| 入口 | 看什么 |
| --- | --- |
| `/proc/<pid>/maps` | VMA 地址范围、权限、文件来源 |
| `/proc/<pid>/smaps` | 每个 VMA 的 RSS、PSS、匿名页、文件页等统计 |
| `/proc/<pid>/pagemap` | 虚拟页到物理页框信息，读取受权限限制 |
| `/proc/meminfo` | 系统内存、page cache、slab、swap 等统计 |
| `pmap -x <pid>` | 进程地址空间汇总 |
| `vmstat 1` | page in/out、swap、内存压力 |
| `perf stat -e dTLB-load-misses` | TLB miss 相关事件，事件名依硬件而异 |
| `perf trace -e page-faults` | 观察缺页事件 |

最小观察顺序：

| 步骤 | 命令 |
| --- | --- |
| 看进程映射 | `cat /proc/<pid>/maps` |
| 看每段实际占用 | `cat /proc/<pid>/smaps` |
| 看系统内存 | `cat /proc/meminfo` |
| 看缺页统计 | `ps -o pid,min_flt,maj_flt,comm -p <pid>` |

## 压缩表

| 概念 | 小林 Code / 八股 | OSTEP 模型 | Linux 落点 |
| --- | --- | --- | --- |
| 虚拟内存 | 虚拟地址通过 MMU 转物理地址 | 地址空间抽象 | `mm_struct`、页表 |
| 分段 | 按逻辑区域管理，存在碎片问题 | base + bounds 的扩展模型 | 现代 Linux 普通路径主要依赖分页 |
| 分页 | 固定大小页，页表映射 | page table + protection | PTE、page fault、page frame |
| 多级页表 | 节省页表内存 | 稀疏地址空间优化 | PGD/PUD/PMD/PTE |
| TLB | 页表翻译缓存 | 加速地址翻译 | shootdown、context switch 成本 |
| mmap | 建立一段虚拟地址映射 | 地址空间区域管理 | VMA、匿名页、文件页 |
| page cache | 文件内容的内存缓存 | I/O 缓存 | file-backed page、writeback、reclaim |

## 检查点与参考回答

| 问题 | 参考回答 |
| --- | --- |
| 虚拟地址和物理地址怎么区分？ | 虚拟地址是进程指令使用的地址，物理地址是内存硬件上的真实地址。CPU 访存时由 MMU 根据页表把虚拟地址翻译成物理地址，并检查权限。 |
| 为什么需要虚拟内存？ | 虚拟内存提供进程隔离、权限控制和按需分配。每个进程看到自己的地址空间，内核通过页表控制哪些页可读、可写、可执行。 |
| 分段和分页的核心区别是什么？ | 分段按程序逻辑区域划分，段大小可变；分页按固定大小页划分，页和页框通过页表映射。分段容易产生外部碎片，分页主要面对页表开销和内部碎片。 |
| 多级页表为什么省内存？ | 多级页表只为实际使用的虚拟地址范围分配下级页表页。大片未使用地址空间不需要完整页表。 |
| TLB 解决什么问题？ | TLB 缓存虚拟页到物理页框的翻译结果，减少每次访存都走多级页表的成本。 |
| mmap 区域是什么？ | mmap 区域是通过 `mmap()` 创建的一段虚拟地址范围，可以映射文件，也可以映射匿名内存。它对应 Linux 里的 VMA，物理页通常按需建立。 |
| page fault 一定是错误吗？ | page fault 是一种异常入口。缺页加载、匿名页按需分配、COW 都会触发 page fault；访问非法地址或权限不匹配时才会变成 `SIGSEGV` 或 `-EFAULT`。 |
| `mm_struct` 和 VMA 分别记录什么？ | `mm_struct` 描述一个进程的用户地址空间整体，包括页表根和 VMA 集合；VMA 描述其中一段连续虚拟地址区域，包括起止地址、权限和映射来源。 |
| page cache 和文件 I/O 有什么关系？ | page cache 用内存缓存文件内容。`read()`、`write()` 和 file-backed `mmap()` 都可能经过 page cache，内存压力下干净文件页可回收，脏页需要写回。 |

## 本篇参考

- 小林 Code《图解系统》第三章：内存管理
- Remzi H. Arpaci-Dusseau and Andrea C. Arpaci-Dusseau, *Operating Systems: Three Easy Pieces*
- Michael Kerrisk, *The Linux Programming Interface*
- Robert Love, *Linux Kernel Development*
- Linux Kernel Documentation: Memory Management
- Linux Kernel Documentation: Page Tables
