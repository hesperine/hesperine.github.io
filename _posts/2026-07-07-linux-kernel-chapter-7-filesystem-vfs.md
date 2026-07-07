---
title: Linux 内核学习笔记（七）：文件系统、VFS 与 page cache
date: 2026-07-07 17:53:00 +0800
categories: [学习笔记, OS与Linux内核笔记]
tags: [Linux, Linux Kernel, Filesystem, VFS, Page Cache]
---

文件系统这章从 fd、路径名和 page cache 三条线记。fd 是进程访问内核对象的 handle；路径名通过 VFS lookup 找到 dentry 和 inode；文件内容读写通常会经过 page cache。

## OS 抽象

文件系统提供持久化命名空间。应用看到路径、目录、文件、读写接口；内核需要维护路径解析、权限检查、打开文件状态、缓存、写回和具体文件系统实现。

几个层次：

```text
用户态路径 / fd
  |
  v
VFS
  |
  +-- dentry / inode / superblock
  |
  +-- ext4 / xfs / tmpfs / procfs / socket / pipe
```

fd 适合表示“已打开对象”，路径适合表示“命名空间里的位置”。同一个文件可以有多个路径名硬链接，也可以已经 unlink 但仍被某个 `struct file` 引用。

## Linux 对象

| 对象 | 记录 |
| --- | --- |
| fd | 进程局部整数 handle |
| `files_struct` | 当前 task 的文件表 |
| fdtable | fd 到 `struct file` 的映射 |
| `struct file` | 一次打开文件对象，记录 offset、flags、操作表 |
| dentry | 目录项缓存，连接名字和 inode |
| inode | 文件本体的元数据和底层对象 |
| superblock | 一个挂载文件系统的全局信息 |
| `file_operations` | read/write/poll/ioctl 等操作入口 |
| address_space | 文件页缓存相关结构 |

对象关系：

```text
fd
  -> files_struct
  -> fdtable
  -> struct file
  -> dentry
  -> inode
  -> superblock
```

`struct file` 表示一次 open 产生的打开文件状态。inode 表示文件系统里的文件对象。多个 `struct file` 可以指向同一个 inode，但它们的 offset 和 flags 可以不同。

## open 路径

`openat()` 要把路径名变成打开文件对象：

```text
openat(dirfd, path, flags)
  |
  v
路径解析
  |
  v
dentry / inode
  |
  v
权限检查
  |
  v
创建 struct file
  |
  v
分配 fd，放入 fdtable
```

路径解析要处理当前目录、root、mount、符号链接、权限、缓存命中等问题。VFS 把这些通用逻辑和具体文件系统实现分开。

## read / write 与 page cache

普通 buffered read 路径会先查 page cache：

```text
read(fd)
  |
  v
struct file
  |
  v
VFS / filesystem
  |
  +-- page cache 命中 -> copy_to_user()
  |
  +-- page cache 未命中 -> 发起 I/O -> 填 page cache -> copy_to_user()
```

buffered write 通常先写到 page cache，把页标记为 dirty，之后由 writeback 写回磁盘。

```text
write(fd)
  |
  v
copy_from_user()
  |
  v
写入 page cache
  |
  v
标记 dirty
  |
  v
writeback
```

direct I/O 尝试绕过 page cache，常用于数据库等自己管理缓存的场景。它减少双重缓存，但对对齐、I/O 大小、设备行为更敏感。

## fd 继承和共享 offset

`fork()` 后子进程继承父进程 fd。父子 fdtable 的项可能指向同一个 `struct file`，因此共享 offset。

```text
parent fd 3 ─┐
             v
          struct file -> inode
             ^
child fd 3 ──┘
```

同一个进程对同一路径 `open()` 两次，通常得到两个不同 `struct file`，offset 独立。

## 术语表 / 八股检查点

| 名词 | 记录 |
| --- | --- |
| fd | 进程局部的文件描述符 |
| open file description | 一次打开文件对象，对应 `struct file` |
| VFS | Linux 虚拟文件系统层 |
| dentry | 目录项缓存 |
| inode | 文件元数据和底层对象 |
| superblock | 文件系统实例的全局信息 |
| mount | 把文件系统挂到目录树 |
| page cache | 文件数据页缓存 |
| dirty page | 已修改但未写回的缓存页 |
| writeback | 把脏页写回后备存储 |
| buffered I/O | 经过 page cache 的 I/O |
| direct I/O | 尽量绕过 page cache 的 I/O |

## 观测入口

```bash
ls -l /proc/<pid>/fd
cat /proc/<pid>/fdinfo/<fd>
lsof -p <pid>
stat <file>
findmnt
mount
```

文件 I/O 和 page cache：

```bash
strace -e openat,read,write,close cat file
vmstat 1
cat /proc/meminfo | grep -E 'Cached|Dirty|Writeback'
```

## 源码入口

| 路径 | 内容 |
| --- | --- |
| `include/linux/fs.h` | `struct file`、inode、superblock 等 |
| `fs/open.c` | open 路径 |
| `fs/namei.c` | 路径解析 |
| `fs/read_write.c` | read/write VFS 入口 |
| `mm/filemap.c` | page cache 读写核心 |
| `fs/proc/fd.c` | `/proc/<pid>/fd` |

## 本章检查点与参考回答

| 问题 | 参考回答 |
| --- | --- |
| fd、`struct file`、inode 的区别是什么？ | fd 是进程局部整数；`struct file` 是一次打开文件对象，记录 offset 和 flags；inode 是文件系统里的文件本体和元数据。 |
| VFS 解决什么问题？ | VFS 给不同文件系统和内核对象提供统一接口，让普通文件、procfs、pipe、socket、设备都能通过 open/read/write/poll 等接口访问。 |
| page cache 有什么用？ | page cache 缓存文件数据页，读文件时减少磁盘 I/O，写文件时可以先写内存再异步 writeback。 |
| buffered I/O 和 direct I/O 的区别是什么？ | buffered I/O 经过 page cache；direct I/O 尽量绕过 page cache，适合自己管理缓存的程序，但对对齐和设备行为要求更高。 |
| fork 后 fd 为什么可能共享 offset？ | fork 后父子 fdtable 项可能指向同一个 `struct file`，offset 在 `struct file` 中，因此父子进程读写会影响同一个文件偏移。 |

## 本章参考

- [Linux kernel documentation: Filesystems](https://docs.kernel.org/filesystems/index.html)
- [小林 Code：图解系统](https://xiaolincoding.com/os/)
- Michael Kerrisk, *The Linux Programming Interface*
- W. Richard Stevens, Stephen A. Rago, *Advanced Programming in the UNIX Environment*
- Robert Love, *Linux Kernel Development*
