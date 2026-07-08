---
title: Linux 内核学习笔记：文件系统
date: 2026-07-07 17:55:00 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, Operating System, Filesystem, VFS]
---

这一篇记录文件系统的几个基础问题：文件系统基本组成、VFS、文件使用、文件存储、空闲空间管理、文件系统结构、目录、软硬链接、文件 I/O。Linux 落点放在 fd、`struct file`、dentry、inode、superblock、page cache、writeback。

## 问题索引

| 主题 | 本篇记录 |
| --- | --- |
| 文件系统基本组成 | inode、dentry、数据块、超级块 |
| 虚拟文件系统 | VFS 对不同文件系统提供统一接口 |
| 文件的使用 | open/read/write/close、fd、打开文件对象 |
| 文件的存储 | 连续、链表、索引、多级索引 |
| 空闲空间管理 | 空闲表、空闲链表、位图 |
| 文件系统结构 | 块组、超级块、inode 位图、块位图、数据块 |
| 目录存储 | 目录文件、文件名到 inode 的映射 |
| 软链接和硬链接 | 路径引用和 inode 引用 |
| 文件 I/O | 缓冲/非缓冲、直接/非直接、阻塞/非阻塞、同步/异步 |

## 1. 文件系统：命名、元数据、数据块

文件系统提供持久化命名空间。应用看到路径、目录和文件；内核维护路径解析、权限、元数据、缓存、写回和具体磁盘布局。

| 对象 | 记录 |
| --- | --- |
| 文件名 | 目录中的名字 |
| dentry | 目录项缓存，连接名字和 inode |
| inode | 文件元数据和底层文件对象 |
| data block | 保存文件内容的数据块 |
| superblock | 一个文件系统实例的全局信息 |

inode 记录文件大小、权限、时间戳、数据块位置等元信息。dentry 记录名字和 inode 的关系，并由内核缓存在内存中。一个 inode 可以被多个 dentry 指向，这是硬链接的基础。

Linux 落点：

| Linux 对象 | 作用 |
| --- | --- |
| `struct inode` | 文件元数据和底层对象 |
| `struct dentry` | 路径名解析缓存 |
| `struct super_block` | 挂载文件系统实例 |
| `struct address_space` | 文件页缓存相关结构 |
| `struct file_system_type` | 具体文件系统类型 |

源码入口：`include/linux/fs.h`、`fs/inode.c`、`fs/dcache.c`、`fs/super.c`。

## 2. VFS：统一接口层

VFS, Virtual File System，把不同文件系统和内核对象统一到一组接口下。应用使用 `open()`、`read()`、`write()`、`stat()` 等接口时，不需要关心底层是 ext4、XFS、tmpfs、procfs、pipe、socket 还是设备文件。

| VFS 对象 | 记录 |
| --- | --- |
| `struct file` | 一次打开文件对象 |
| `struct inode` | 文件对象和元数据 |
| `struct dentry` | 名字到 inode 的缓存映射 |
| `struct super_block` | 文件系统实例 |
| `file_operations` | `read`、`write`、`poll`、`ioctl` 等操作表 |
| `inode_operations` | 创建、链接、查找、权限等 inode 操作 |

VFS 的核心价值是把“路径和 fd 接口”与“具体文件系统实现”分开。`read()` 进入 VFS 后，通过 `struct file` 的操作表转到具体实现。

## 3. 文件使用：fd、struct file、inode

打开文件后，用户态拿到 fd。fd 是进程局部整数，真正的打开文件状态在内核对象里。

| 名词 | 记录 |
| --- | --- |
| fd | 进程局部整数 handle |
| `files_struct` | task 持有的文件表 |
| fdtable | fd 到 `struct file *` 的映射 |
| `struct file` | 一次打开文件对象，保存 offset、flags、操作表 |
| inode | 文件本体和元数据 |

对象链：

| 层次 | 关系 |
| --- | --- |
| 进程 | `task_struct -> files_struct` |
| fd 表 | `files_struct -> fdtable` |
| 打开文件 | `fdtable[fd] -> struct file` |
| 路径对象 | `struct file -> dentry` |
| 文件对象 | `dentry -> inode` |

同一路径 `open()` 两次，通常产生两个不同 `struct file`，文件偏移独立。`fork()` 后父子进程继承 fd，可能指向同一个 `struct file`，文件偏移共享。

观察入口：

| 命令 / 路径 | 记录 |
| --- | --- |
| `ls -l /proc/<pid>/fd` | 看进程打开的 fd |
| `cat /proc/<pid>/fdinfo/<fd>` | 看 offset、flags 等 |
| `lsof -p <pid>` | 看进程打开文件 |
| `stat <file>` | 看 inode、权限、大小、时间 |

## 4. open、read、write 的主路径

`openat()` 把路径解析成 dentry/inode，创建 `struct file`，再分配 fd 放入当前进程 fdtable。

| 阶段 | Linux 入口 |
| --- | --- |
| 路径解析 | `fs/namei.c` |
| 创建打开文件对象 | `fs/open.c` |
| fd 分配 | fdtable / `files_struct` |
| 权限检查 | VFS + LSM + 具体文件系统 |

普通 buffered `read()` 通常先查 page cache。命中时从 page cache 拷贝到用户缓冲区；未命中时发起 I/O，把数据读入 page cache，再拷贝到用户缓冲区。

普通 buffered `write()` 通常把用户数据拷贝到 page cache，把页标记为 dirty，之后由 writeback 写回后备存储。`fsync()`、`sync()`、内存压力、脏页时间或比例阈值都可能触发写回。

| 路径 | 关键对象 |
| --- | --- |
| `read(fd, buf, count)` | fd、`struct file`、VFS、page cache、`copy_to_user()` |
| `write(fd, buf, count)` | fd、`struct file`、page cache、dirty page、writeback |
| `fsync(fd)` | 文件数据和元数据持久化要求 |

## 5. 文件存储：连续、链表、索引

文件内容最终要映射到磁盘块或其他后备存储块。教材里常见三种方式。

| 方式 | 优点 | 问题 |
| --- | --- | --- |
| 连续空间 | 顺序读写快，定位简单 | 外部碎片，文件扩展困难 |
| 链表 | 文件可动态扩展，空间利用率较高 | 随机访问差，指针损坏影响链路 |
| 索引 | 支持随机访问，文件可扩展 | 索引块有额外开销，大文件需要多级索引 |

Unix 传统 inode 使用直接块、一级间接块、二级间接块、三级间接块组合。小文件通过直接块减少索引开销，大文件通过多级索引扩展容量。

Linux 落点：现代文件系统实现更复杂，例如 extent、日志、延迟分配、写时复制、校验等机制。学习 VFS 时先掌握 inode/dentry/superblock/page cache；深入具体文件系统时再看 ext4、XFS、btrfs 的磁盘布局。

## 6. 空闲空间管理和文件系统结构

文件系统需要记录哪些块空闲、哪些 inode 空闲。教材里常见空闲表、空闲链表、位图。

| 方式 | 记录 |
| --- | --- |
| 空闲表 | 记录空闲区起点和长度，适合连续区管理 |
| 空闲链表 | 空闲块通过指针串联 |
| 位图 | 每一位表示一个块或 inode 是否空闲 |

Linux 常见文件系统会用位图或更复杂的数据结构管理空闲空间。以 ext 系列的教材模型看，磁盘可分为引导块、块组、超级块、块组描述符、块位图、inode 位图、inode 表、数据块等区域。

| 结构 | 记录 |
| --- | --- |
| superblock | 文件系统全局信息 |
| block group descriptor | 块组状态 |
| block bitmap | 数据块使用情况 |
| inode bitmap | inode 使用情况 |
| inode table | inode 列表 |
| data blocks | 文件内容和目录内容 |

## 7. 目录、硬链接、软链接

目录也是文件。目录内容记录文件名到 inode 的映射。路径解析就是沿着目录层级查 dentry/inode。

| 链接 | 记录 |
| --- | --- |
| 硬链接 | 多个目录项指向同一个 inode |
| 软链接 | 一个独立文件，内容是目标路径 |

硬链接不能跨文件系统，因为 inode 属于具体文件系统实例。删除一个路径名只是删除一个目录项；当 inode 链接计数归零，并且没有打开文件引用时，文件内容才能被真正释放。

软链接有自己的 inode。访问软链接时，路径解析会读取链接内容，再继续解析目标路径。软链接可以跨文件系统，也可能变成悬空链接。

## 8. 文件 I/O：四组概念

这里有几组高频混淆点，需要分开记。

| 概念 | 区分点 |
| --- | --- |
| 缓冲 I/O / 非缓冲 I/O | 是否使用 C 标准库 `stdio` 缓冲 |
| 直接 I/O / 非直接 I/O | 是否尽量绕过内核 page cache |
| 阻塞 I/O / 非阻塞 I/O | 数据未就绪时 syscall 等待还是立即返回 |
| 同步 I/O / 异步 I/O | 数据准备和数据拷贝阶段是否由调用线程等待 |

更细一点：

| 类型 | 记录 |
| --- | --- |
| 标准库缓冲 I/O | `fread()`、`fwrite()`、`printf()` 等可能先进入用户态缓冲 |
| 系统调用非缓冲 I/O | `read()`、`write()` 直接进入内核，没有 stdio 缓冲 |
| 非直接 I/O | 默认路径，经过 page cache |
| 直接 I/O | 使用 `O_DIRECT` 等方式尽量绕过 page cache |
| 阻塞 I/O | 数据未就绪时睡眠等待 |
| 非阻塞 I/O | 数据未就绪时返回 `EAGAIN` / `EWOULDBLOCK` |
| I/O 多路复用 | select/poll/epoll 等待多个 fd 就绪 |
| 异步 I/O | 提交后由内核完成数据准备和拷贝，之后通知完成 |

阻塞、非阻塞、I/O 多路复用仍然可能是同步 I/O，因为真正 `read()` 时，内核到用户缓冲区的数据拷贝仍由当前调用路径等待完成。真正异步 I/O 要把数据准备和数据拷贝都从调用线程等待路径中移出去。

## 9. page cache 和 writeback

page cache 是文件系统和内存管理的交界。它用内存缓存文件数据页。

| 场景 | page cache 行为 |
| --- | --- |
| buffered read | 命中则直接拷贝；未命中则读入 page cache |
| buffered write | 写入 page cache，标记 dirty |
| file-backed mmap | 虚拟页可映射到 page cache 页 |
| reclaim | 干净文件页可直接回收，脏页需要写回 |
| writeback | 把 dirty page 写到后备存储 |

观察入口：

| 命令 / 路径 | 记录 |
| --- | --- |
| `cat /proc/meminfo` | `Cached`、`Dirty`、`Writeback` |
| `vmstat 1` | 内存和 I/O 活动 |
| `iostat -x 1` | 设备 I/O |
| `strace -e openat,read,write,fsync,close <cmd>` | 文件相关 syscall |

## 压缩表

| 概念 | 基础概念 / 八股 | Linux 落点 |
| --- | --- | --- |
| inode | 文件元数据 | `struct inode` |
| dentry | 文件名和 inode 的关系 | `struct dentry`、dcache |
| VFS | 统一文件接口 | `struct file`、operations tables |
| fd | 打开文件句柄 | `files_struct`、fdtable |
| page cache | 文件数据缓存 | `address_space`、`mm/filemap.c` |
| hard link | 多目录项指向同一 inode | inode link count |
| symlink | 路径形式的间接引用 | 独立 inode，内容为目标路径 |
| direct I/O | 绕过 page cache | `O_DIRECT` |

## 检查点与参考回答

| 问题 | 参考回答 |
| --- | --- |
| inode 和 dentry 分别是什么？ | inode 记录文件元数据和底层文件对象；dentry 记录名字到 inode 的映射，并由内核缓存在内存中。 |
| fd、`struct file`、inode 怎么区分？ | fd 是进程局部整数；`struct file` 是一次打开文件对象，保存 offset、flags 和操作表；inode 是文件本体和元数据。 |
| VFS 解决什么问题？ | VFS 给不同文件系统和内核对象提供统一接口，使普通文件、procfs、pipe、socket、设备文件等都能通过统一 syscall 访问。 |
| `fork()` 后 fd 为什么可能共享文件偏移？ | 父子进程的 fdtable 项可能指向同一个 `struct file`，文件偏移保存在 `struct file` 中，因此读写会影响同一个 offset。 |
| 硬链接和软链接有什么区别？ | 硬链接是多个目录项指向同一个 inode；软链接是独立文件，内容是目标路径。硬链接通常不能跨文件系统，软链接可以跨文件系统但可能悬空。 |
| buffered I/O 和 direct I/O 怎么区分？ | buffered I/O 经过 page cache；direct I/O 使用 `O_DIRECT` 等方式尽量绕过 page cache。 |
| 非阻塞 I/O 和异步 I/O 怎么区分？ | 非阻塞 I/O 在数据未就绪时立即返回，但真正读取时仍由调用线程等待数据拷贝；异步 I/O 提交后由内核完成准备和拷贝，再通知完成。 |
| page cache 有什么用？ | page cache 缓存文件数据页，减少磁盘 I/O；写入时先形成 dirty page，再由 writeback 刷回后备存储。 |

## 本篇参考

- Remzi H. Arpaci-Dusseau and Andrea C. Arpaci-Dusseau, *Operating Systems: Three Easy Pieces*
- Michael Kerrisk, *The Linux Programming Interface*
- W. Richard Stevens, Stephen A. Rago, *Advanced Programming in the UNIX Environment*
- Linux Kernel Documentation: Filesystems
- Linux Kernel Documentation: Block
- Robert Love, *Linux Kernel Development*
