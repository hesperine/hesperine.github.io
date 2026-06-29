---
title: Agent 经典与工程实践图谱
date: 2026-06-24 16:30:00 +0800
categories: [学习笔记, Agent 笔记]
tags: [Agent, LLM Agent, Agent Evaluation]
---

我想把 Agent 近几年的经典工作整理成一个系列。不是按时间流水账把论文列完，而是先搭一张能反复回来的图谱：哪些工作定义了基本动作，哪些工作打开了分支，哪些工作改变了工程上线方式。

这篇是系列入口。它更像学习笔记的目录和判断框架，后面每个分支再单独写精读和 citation。

> 已经写完的几篇：
>
> - [ReAct 论文阅读：把语言模型从回答器变成会行动的 Agent](/posts/react-paper-reading/)
> - [Toolformer 论文精读：语言模型如何通过自监督学习获得工具使用能力](/posts/toolformer-paper-reading/)
> - [Voyager 论文阅读：大语言模型智能体如何把经验沉淀成技能库](/posts/voyager-paper-reading/)
> - [Generative Agents 论文阅读：记忆、反思与规划如何支撑可置信的小镇](/posts/generative-agents-paper-reading/)
{: .prompt-tip }

## 先限定范围

如果把 Agent 追到更早，当然可以追到符号 AI、强化学习、经典 planning、多智能体系统。但我这组文章先不从那里开始。

这里的主线是 **LLM Agent**：也就是从大语言模型开始承担推理、决策、工具调用、状态维护、环境交互之后形成的这条线。按这个定义，真正的转折点大概从 2022 年的 ReAct 开始。

所以这个系列暂时不是“Agent 百年史”，而是：

```text
LLM Agent 的主干经典
    + 关键转折点
    + 工程实践入口
    + 可靠性与评测线索
```

我更关心的问题是：

```text
读完哪些东西之后，后面再看 agent 框架、benchmark、协议、产品 demo 时不会迷路？
```

## 第一层：Agent 的两个基本动作

这一层只有两篇。

### ReAct：让模型进入行动闭环

[ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629) 的核心不是“加一个 Thought 标签”，而是把语言模型从一次性回答器变成一个交互式 policy。

它给出了一个最小但完整的闭环：

```text
Thought / Action -> Observation -> 下一步 Thought / Action
```

这条线之后，很多 agent 框架都可以看成是在工程化这个循环：

- prompt 里描述可用工具；
- runtime 解析模型动作；
- 执行工具或环境操作；
- 把 observation 写回上下文；
- 继续让模型决定下一步。

我现在会把 ReAct 放在整个系列的第一篇，因为它定义的是 Agent 的运行时形态。

### Toolformer：让模型学习何时调用工具

[Toolformer: Language Models Can Teach Themselves to Use Tools](https://arxiv.org/abs/2302.04761) 问的是另一个问题：如果没有大量人工标注，模型能不能自己学会什么时候调工具、调哪个工具、参数怎么写、结果怎么接回文本？

它的关键贡献是把工具调用标注转成自监督数据构造问题：

```text
普通文本
    -> 采样候选 API call
    -> 执行工具
    -> 用 future-token loss 过滤有用调用
    -> 微调模型
```

如果说 ReAct 定义的是运行时闭环，Toolformer 更像是在回答训练时问题：工具调用策略能不能进入模型能力本身。

把这两篇连起来，能得到一个最小 mental model：

```text
Agent = LLM policy + trajectory context + action space + environment feedback

Tool-using model = LM + tool-call data + execution-time result insertion
```

## 第二层：Agent 怎么长出长期能力

有了基本动作之后，下一层关心的是：Agent 如何不只做一步工具调用，而是在更长的任务里积累经验、维护记忆、规划行为、完成真实环境任务。

### Voyager：技能库与开放环境

[Voyager](https://arxiv.org/abs/2305.16291) 把大语言模型智能体放进 Minecraft，核心不是游戏本身，而是三个组件：

- automatic curriculum：自动提出接下来该探索什么；
- skill library：把成功代码沉淀成可复用技能；
- iterative prompting：根据环境反馈和执行错误持续改写程序。

这篇适合放在“长期能力”和“游戏环境 Agent”分支。它让我关注的是：Agent 的能力不只存在于模型参数里，也可以存在于外部技能库和可执行代码中。

### Generative Agents：记忆、规划、反思

[Generative Agents](https://arxiv.org/abs/2304.03442) 的价值在于给出了一个很有影响力的心智模型：

```text
memory + planning + reflection
```

它不只是展示 25 个 agent 在 Smallville 里生活，而是把“可置信的社会行为”拆成了可工程实现的模块：观察如何进入记忆，记忆如何被检索，反思如何生成更高层抽象，计划如何驱动后续行为。

单篇阅读见：[Generative Agents 论文阅读：记忆、反思与规划如何支撑可置信的小镇](/posts/generative-agents-paper-reading/)。

这条线后面可以接 mem0、agent memory、personalized agent，以及各种“长期陪伴型 agent”的工程实现。

### MemGPT：把上下文管理看成虚拟内存

[MemGPT](https://arxiv.org/abs/2310.08560) 对我最有吸引力的地方，是它把 LLM 上下文窗口问题翻译成系统问题。

它不是简单说“加一个向量数据库”，而是借用了操作系统里的分层内存和虚拟内存类比：

```text
有限上下文窗口 = 主存
外部存储 = 外存
LLM 自己管理读写、分页和中断
```

这篇可以单独写一篇，因为它把 Agent runtime、context management、memory hierarchy 接到了一起。对系统方向来说，这比“又一个 agent 应用”更值得细看。

## 第三层：Agent 怎么被评测

Agent 真正进入工程之后，问题会从“能不能做”变成“能不能稳定做对”。

### SWE-bench：真实软件工程任务

[SWE-bench](https://arxiv.org/abs/2310.06770) 的重要性在于，它把代码生成从单函数题推到真实 repo 里的 issue 修复。

这件事改变了 code agent 的目标函数：模型不再只是写一个函数，而是要读 issue、理解代码库、定位文件、修改实现、跑测试，并让 patch 真正通过。

对我来说，SWE-bench 是“横向任务评测”的起点。后面很多 coding agent、software engineering agent、repo-level benchmark，都可以从这里往下接。

### tau-bench：状态化任务与 pass^k

[$\tau$-bench](https://arxiv.org/abs/2406.12045) 关心的是工具、用户和业务规则同时存在时，Agent 是否真的完成了任务。

它的重要点有两个：

```text
stateful evaluation:
    不只看文本答案，而是比较任务前后的数据库状态。

pass^k:
    不只看一次成功，而是看连续多次是否稳定成功。
```

这比一次性 success rate 更接近真实系统，因为上线后的 agent 不能只在某一次 seed 下“看起来能用”。

### Towards a Science of AI Agent Reliability：把可靠性拆开测

[Towards a Science of AI Agent Reliability](https://arxiv.org/abs/2602.16666) 进一步把可靠性从一个总分拆成多个维度，例如 consistency、robustness、predictability、safety。

这条线对后续写 GenUI evaluation 很重要。很多 UI 生成问题表面看是“界面不好看”或“组件错了”，本质上可能是 Agent 在输出模态里的可靠性问题：

```text
同一个任务多次生成是否稳定？
轻微需求扰动是否崩掉？
失败是不是可预测？
错误严重程度有没有边界？
```

这类问题不能只靠更大的模型自然消失，需要评测协议和工程约束一起解决。

## 第四层：协议化与工程实践

2024 之后，Agent 的一条关键变化是协议化。

### MCP：工具连接从定制集成走向协议层

[Model Context Protocol](https://www.anthropic.com/news/model-context-protocol) 是 Anthropic 在 2024-11-25 发布的开放协议，目标是用统一方式连接 AI assistant 和外部数据源、工具、开发环境。它的官方 [specification](https://modelcontextprotocol.io/specification) 把这件事从“每个应用自己写一套插件”推向更标准的 client/server 协议。

我不想把 MCP 神化成“Agent 的 HTTP”，但它确实代表了一个方向：Agent 要可靠使用工具，不能永远靠 prompt 里手写说明和零散 SDK。

后面单独写 MCP 时，我会重点看三件事：

- tool schema 如何暴露给模型；
- client/server 边界如何影响安全和权限；
- 为什么协议统一以后，评测和调试仍然不会自动解决。

### Building Effective Agents：工程上先区分 workflow 和 agent

Anthropic 的 [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) 值得作为工程实践入口。它有一个对我很有用的区分：

```text
workflow:
    LLM 和工具沿着预定义代码路径执行。

agent:
    LLM 动态决定自己的流程和工具使用方式。
```

这个区分能避免一个常见误区：不是所有多步 LLM 系统都必须叫 agent，也不是所有任务都值得上 agent。很多时候，固定 workflow 更便宜、更可控、更容易测试。

我后面读 LangGraph、AutoGen、DSPy、CopilotKit、A2UI 相关代码时，也会按这个标准拆：

```text
它是在编排 workflow，还是在放权给 agent？
状态在哪里？
工具边界在哪里？
失败如何恢复？
评测如何定义？
```

## 我现在的系列计划

按当前进度，系列可以这样展开：

| 顺序 | 文章 | 状态 |
| --- | --- | --- |
| 1 | ReAct：reasoning + acting 闭环 | 已完成 |
| 2 | Toolformer：自监督工具调用学习 | 已完成 |
| 3 | Voyager：技能库、自动课程与游戏环境智能体 | 已完成 |
| 4 | Generative Agents：记忆、规划、反思 | 已完成 |
| 5 | MemGPT：上下文管理作为虚拟内存 | 待写 |
| 6 | SWE-bench：真实软件工程任务评测 | 待写 |
| 7 | MCP：Agent 工具协议层 | 待写 |
| 8 | tau-bench 与可靠性评测 | 待写 |
| 9 | Agent 工程实践：workflow、agent 与框架边界 | 待写 |

这个顺序不是严格时间线，而是学习路径：

```text
先理解 Agent 的基本动作
再理解长期能力如何外化
再理解真实任务如何评测
最后理解协议和工程实践如何落地
```

## 下一步先写什么

Generative Agents 写完后，再写 MemGPT 会更顺：Generative Agents 讲自然语言经验如何变成记忆与反思，MemGPT 则讲上下文和长期记忆如何被 runtime 管理。

## 速记

我目前对这条主线的压缩理解是：

```text
ReAct 定义运行时闭环。
Toolformer 证明工具调用可以被模型学习。
Voyager 把能力沉淀到技能库。
Generative Agents 把行为拆成记忆、规划、反思。
MemGPT 把上下文管理系统化。
SWE-bench 和 tau-bench 把 Agent 拉到真实任务与状态化评测。
MCP 把工具连接推向协议层。
Reliability Science 提醒我们：能力增长不等于可靠性自动解决。
```

如果这组文章能写完，我希望它不只是“读过哪些论文”的清单，而是一条能支撑后续研究和工程判断的主线。
