---
title: Agent Memory 与上下文压缩：长程任务里的状态管理问题
date: 2026-06-29 22:00:00 +0800
categories: [学习笔记, Agent 笔记]
tags: [Agent, Agent Memory, Context Compression, LLM Agent]
---

Agent 的记忆问题，一开始很容易被理解成“给模型接一个数据库”。但如果把 ReAct、Generative Agents、MemGPT 和最近的 context compression 工作连起来看，问题会更像系统设计：Agent 在长程任务里持续行动，历史轨迹不断增长，哪些信息应该留在当前上下文，哪些应该写入外部记忆，哪些可以被压缩，哪些必须原样保留。

这篇先作为 Agent Memory 这条线的专题入口，不专门精读某一篇论文。后面可以再单独写一篇 [Context Compression for LLM Agents: A Survey of Methods, Failure Modes, and Evaluation](https://github.com/YerbaPage/Awesome-Context-Compression) 的论文阅读，把其中的 taxonomy、failure modes 和评估方法展开。

## 从行动轨迹开始看记忆

Agent Memory 不是凭空出现的模块。它首先来自 Agent 的运行方式。

ReAct 把语言模型从一次性回答器变成了交互式执行者：

```text
Thought / Action -> Observation -> Thought / Action -> Observation ...
```

只要这个循环持续下去，Agent 就会自然产生一条越来越长的轨迹。轨迹里不只有普通文本，还包括目标、计划、工具调用、环境反馈、错误信息、中间结论、已经尝试过但失败的路径，以及用户后来补充的新约束。

这和传统长文档问答不一样。长文档通常是一段静态输入，模型要做的是理解和检索；Agent 轨迹是动态生成的，后面的动作依赖前面的观察和决策。如果压缩时丢掉一个文件路径、一个用户约束、一次失败原因，后面可能不是“回答少一点细节”，而是直接走错任务方向。

所以 Agent Memory 的核心不是“把内容存起来”，而是：

```text
在有限上下文预算下，维护一个仍然能驱动后续行动的状态。
```

## Generative Agents：记忆作为行为来源

Generative Agents 给了一个很有影响力的结构：

```text
memory + reflection + planning
```

在这个框架里，记忆不是聊天记录的备份，而是行为生成的来源。Agent 观察到事件，把事件写入 memory stream；之后通过检索取回相关记忆；再通过 reflection 生成更高层的抽象；最后用这些内容生成计划和行动。

这条线对 Agent Memory 的启发是：记忆至少有三种不同用途。

第一种是事件记忆，记录“发生过什么”。例如某个用户之前表达过偏好，某个任务已经做到哪一步，某个工具返回过什么结果。

第二种是语义记忆，沉淀“可以复用的知识”。例如某个项目的目录结构、某个 API 的调用约定、某类任务的常见步骤。

第三种是过程记忆，保存“怎样做”。Voyager 的 skill library 就更接近这一类：成功的代码片段被沉淀成可复用技能，后续遇到相似任务时不必从零探索。

这三类记忆不能都用同一种存储和压缩方式处理。事件记忆重视时间顺序，语义记忆重视抽象和归纳，过程记忆重视可执行性。把它们都塞进一个向量库，然后只靠相似度检索，往往会掩盖这些差异。

## MemGPT：上下文管理变成 runtime 问题

MemGPT 的重要性在于，它把上下文窗口看成一种有限的工作内存，把外部存储看成更大的长期内存。这个类比不只是修辞，而是把 Agent Memory 从“提示词技巧”推进到了 runtime 设计。

一个长程 Agent 至少要处理四件事：

```text
当前上下文里放什么；
外部记忆里存什么；
什么时候把内容移入或移出上下文；
取回来的内容如何重新参与下一步决策。
```

这时，记忆系统就不只是 retrieval。它还包括写入策略、淘汰策略、摘要策略、恢复策略，以及不同记忆层之间的边界。

这也是为什么单纯扩大 context window 不能完全解决问题。更长的上下文能推迟问题出现，但不会自动告诉 Agent 哪些历史是关键约束，哪些只是噪声，哪些信息必须保持结构，哪些可以压缩成摘要。

## 上下文压缩不是普通摘要

《Context Compression for LLM Agents》这篇综述把问题说得很清楚：Agent context compression 不是一次性的 prompt shortening，而是长程 Agent 的状态管理问题。

它把压缩设计拆成三组问题：

```text
压缩对象：压缩什么？
压缩机制：怎么压缩和保留？
控制策略：谁决定什么时候压缩？
```

压缩对象可以是 observation、完整 trajectory、plan and reasoning、memory state，甚至是 representation-level 的隐藏表示。不同对象的风险不一样。压缩 observation 时可能丢掉页面结构或文件路径；压缩 trajectory 时可能破坏因果顺序；压缩 reasoning 时可能让后续计划失去依据；压缩 memory state 时可能导致以后检索不到关键事实。

压缩机制也不只是 summarization。常见路线至少包括：

- truncation：直接截断旧内容；
- pruning：按重要性删掉低价值片段；
- summarization：把历史压成自然语言摘要；
- abstraction：提炼更高层状态或结论；
- externalization：把内容移到外部记忆，后面按需检索；
- representation compression：在 token 或 latent 层面压缩表示。

这些方法没有绝对优劣，关键在任务约束。代码 Agent 需要保留文件路径、测试错误、依赖关系和修改意图；网页或 GUI Agent 需要保留页面结构、可点击元素和状态变化；研究型 Agent 需要保留证据来源、引用链和不确定性。压缩方法如果不理解这些结构，就会制造很隐蔽的错误。

## 三类失败比 token savings 更重要

上下文压缩最容易被 token savings 诱惑：压缩后少用了多少 token，窗口里还能塞多少轮历史。但对 Agent 来说，更关键的是压缩后还能不能继续正确行动。

这篇 survey 里有一个很有用的失败分类：

```text
F1: Pre-compression Decision Error
F2: In-compression Information Loss
F3: Post-compression Access Failure
```

第一类是压缩前的决策错误。比如太早压缩，把未来会用到的信息提前折叠掉；或者选择了错误的片段，把真正关键的约束当作噪声。

第二类是压缩过程中的信息损失。比如摘要把“不能修改 A 文件”写成了“主要修改 A 文件”，把两个条件合并成一个条件，或者把不确定结论写成确定事实。

第三类是压缩后的访问失败。信息可能没有丢，但后面取不回来；或者取回来了，却不是当前任务真正需要的那一段；或者摘要太抽象，已经不能指导具体操作。

这三类失败提醒我：Agent Memory 的评估不能只看“有没有存”，也不能只看“有没有压缩”。真正要问的是：

```text
关键状态是否还在？
需要时是否能取回？
取回后是否还能指导行动？
错误是否会沿着后续步骤传播？
```

## 一个更适合工程判断的划分

如果把 Agent Memory 当成工程问题，我会先用下面这张简化表来判断设计：

| 问题 | 关注点 | 典型风险 |
| --- | --- | --- |
| 工作上下文 | 当前这一步必须看到什么 | 上下文被噪声占满 |
| 短期轨迹 | 最近几步如何影响下一步 | 失败原因或临时约束丢失 |
| 长期记忆 | 哪些经验以后还会复用 | 写入太多，检索不准 |
| 技能记忆 | 哪些过程可以沉淀成能力 | 过期技能被错误复用 |
| 压缩状态 | 历史如何变成紧凑表示 | 摘要失真，因果断裂 |
| 恢复机制 | 需要细节时如何找回 | 存了但用不上 |

这个划分比“有没有 memory module”更有用。很多系统看起来都有记忆，但只解决了其中一小块。例如向量检索主要解决外部知识取回，不一定解决轨迹压缩；rolling summary 可以缓解上下文爆炸，但不一定能恢复原始证据；代码技能库可以复用成功经验，但不一定能处理用户偏好和任务状态。

这条线最后想回答的不是“哪种记忆模块最好”，而是一个更工程化的问题：

```text
当 Agent 跑得足够久时，什么状态必须保真，什么经验值得沉淀，什么历史可以压缩，以及压缩后的状态如何被验证？
```

如果这个问题没有回答清楚，Agent 的长期性就很容易只停留在 demo 里：前几轮看起来记得住，任务一长就开始丢约束、改目标、忘证据，最后把压缩当成遗忘，把记忆当成幻觉来源。

{% comment %}
写作备注：这条线在 Agent 系列里更适合接在 Generative Agents 和 MemGPT 后面。

Generative Agents
    -> 记忆如何影响行为

MemGPT
    -> 上下文窗口如何被 runtime 管理

Agent Memory 与上下文压缩
    -> 长程轨迹如何变成可恢复、可执行、可评估的状态

后续可以拆成两类文章：

1. 论文阅读：Generative Agents、MemGPT、Context Compression for LLM Agents。
2. 专题笔记：Agent Memory、context compression、skill library、personalized agent、长期任务评估。

目前阅读路线：

1. Generative Agents：理解 memory、reflection、planning 如何支撑行为。
2. MemGPT：理解上下文管理为什么是 runtime 问题。
3. Context Compression for LLM Agents：建立压缩对象、机制、控制策略和失败模式。
4. Agent Memory 相关 survey：对齐更宽的记忆分类和系统实现。
5. coding / web / research agent compression：看不同任务里压缩策略如何变化。
{% endcomment %}
