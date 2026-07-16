---
title: Agent 经典与工程实践图谱
date: 2026-06-24 16:30:00 +0800
categories: [学习笔记, Agent 笔记]
tags: [Agent, LLM Agent, Agent Evaluation]
---

这篇是这个 Agent 系列的入口。它不是完整的 Agent 百年史，也不是只收 arXiv 论文的阅读清单，而是想把 LLM Agent 这几年真正改变讨论方式的节点串成一条时间线：模型什么时候开始行动，工具什么时候变成接口，记忆什么时候变成 runtime 问题，评测什么时候从文本题走向真实环境，工程化又是怎么把 Agent 推进产品里的。

这里的主线从 2021-2022 年左右开始。更早当然可以追到符号 AI、经典 planning、强化学习、多智能体系统，但这组文章暂时聚焦在大语言模型成为推理、决策、工具调用和环境交互核心之后形成的这条线。

> 已经写完的几篇：
>
> - [WebGPT 论文阅读：浏览器、引用和人类反馈如何把 GPT-3 接到外部世界](/posts/webgpt-paper-reading/)
> - [ReAct 论文阅读：把语言模型从回答器变成会行动的 Agent](/posts/react-paper-reading/)
> - [Toolformer 论文精读：语言模型如何通过自监督学习获得工具使用能力](/posts/toolformer-paper-reading/)
> - [Generative Agents 论文阅读：记忆、反思与规划如何支撑可置信的小镇](/posts/generative-agents-paper-reading/)
> - [Voyager 论文阅读：大语言模型智能体如何把经验沉淀成技能库](/posts/voyager-paper-reading/)
> - [Agentopia 论文阅读：长期社会模拟如何变成训练数据](/posts/agentopia-paper-reading/)
> - [EdgeBench 论文阅读：Agent 如何从真实环境反馈里持续变好](/posts/edgebench-paper-reading/)
{: .prompt-tip }

## 2021-2022：前史，模型开始接触外部世界

LLM Agent 不是突然从 ReAct 开始冒出来的。2021-2022 年有几条前史线索已经很清楚：浏览器、工具、程序解释器、推理链。

[WebGPT](https://arxiv.org/abs/2112.09332)（论文；[单篇阅读](/posts/webgpt-paper-reading/)）把模型放进浏览器辅助问答环境里，让模型检索网页、引用来源，再用人类反馈训练答案偏好。它还不是后来的通用 Agent，但已经把“语言模型 + 外部信息环境 + 人类反馈”连在了一起。

[MRKL](https://arxiv.org/abs/2205.00445)（论文；[单篇阅读](/posts/mrkl-systems-paper-reading/)）把语言模型放进模块化系统里，让模型和计算器、数据库、搜索、符号模块协同。它的意义不在于具体模块多强，而在于提出了一种很后来的系统思路：LLM 不必单独完成所有事情，它可以成为路由器和协调器。

[Chain-of-Thought](https://arxiv.org/abs/2201.11903) 和 [Self-Consistency](https://arxiv.org/abs/2203.11171)（论文）让推理过程显式化，并用多条推理路径投票提高稳定性。它们不是 Agent 论文，但没有这条推理链，后面的 plan、reflect、search 都很难讲清楚。

[PAL](https://arxiv.org/abs/2211.10435)（论文）让模型生成程序，再把执行交给解释器。这条线会一路接到后来的 code-as-action：不是让模型在自然语言里“想完”，而是让它写出可执行动作，由 runtime 给出真实反馈。

这一阶段可以概括为：

```text
LLM 不再只是生成答案。
它开始通过浏览器、模块、程序和推理链接触外部世界。
```

## 2022-2023：行动闭环出现

[ReAct](https://arxiv.org/abs/2210.03629)（论文；[单篇阅读](/posts/react-paper-reading/)）是 LLM Agent 主线里最重要的早期节点之一。它把模型从一次性回答器变成一个交互式 policy：

```text
Thought / Action -> Observation -> 下一步 Thought / Action
```

这条闭环后来几乎变成 Agent runtime 的基本形态：模型提出动作，系统执行工具或环境操作，再把 observation 写回上下文。很多框架看起来很复杂，底层仍然是在工程化这个循环。

[Toolformer](https://arxiv.org/abs/2302.04761)（论文；[单篇阅读](/posts/toolformer-paper-reading/)）回答的是另一个问题：工具调用能不能进入模型能力本身？它通过自监督方式构造 API 调用数据，用语言模型损失筛选真正有用的调用。ReAct 偏运行时闭环，Toolformer 偏训练时能力注入，把两篇连起来，能得到一个很小但很有用的 mental model：

```text
Agent = LLM policy + trajectory context + action space + environment feedback

Tool-using model = LM + tool-call data + execution-time result insertion
```

2023 年 3 月之后，社区项目 [AutoGPT](https://github.com/Significant-Gravitas/AutoGPT) 和 [BabyAGI](https://github.com/yoheinakajima/babyagi)（开源项目）把“给一个目标，让模型自己拆解、执行、循环”的想法推到大众视野。它们的学术贡献不一定强，但很重要：从这时开始，Agent 不再只是论文里的一个抽象概念，而是变成开发者会下载、运行、魔改的东西。

OpenAI 的 [function calling](https://openai.com/index/function-calling-and-other-api-updates/)（产品/API）也值得放在这条线上。它把工具调用从 prompt 里的文本约定，推进到 schema 化接口。这个变化很工程化，但影响非常大：工具使用不再只是“让模型输出一段看起来像 JSON 的文本”，而开始有了更明确的接口边界。

这一阶段的转折是：

```text
模型开始进入行动闭环。
工具从 prompt 约定变成 runtime/API 问题。
```

## 2023：反思、搜索和自我修正

ReAct 给了基本闭环，但闭环本身不保证稳定。2023 年的一组工作开始关心：如果第一次做错了，Agent 怎么改？

[Reflexion](https://arxiv.org/abs/2303.11366)（论文）用语言反思和 episodic memory 改善下一次尝试。它不更新模型参数，而是把失败经验写成自然语言记忆。这个想法很有影响：Agent 的学习不一定都发生在权重里，也可以发生在外部记忆和轨迹文本里。

[Self-Refine](https://arxiv.org/abs/2303.17651)（论文）把生成、反馈、修正组织成测试时迭代。它不一定是完整 Agent，但后面很多 evaluator-optimizer、critic-refine、review-rewrite 模式都可以从这里理解。

[Tree of Thoughts](https://arxiv.org/abs/2305.10601)（论文）把单条 Chain-of-Thought 扩展成多条候选推理路径的搜索。它提醒我们：有些任务不是一步步贪心生成就够了，Agent 需要显式搜索、回溯和选择。

这条线后来会和规划器、代码修复、工具重试、self-debugging 接在一起。它的核心变化是：

```text
Agent 不只是行动，还要能评估自己的行动，并把失败变成下一轮信息。
```

## 2023：工具和 API 世界迅速扩大

Toolformer 证明工具调用可以被模型学习，但它处理的是少数工具。2023 年中后期，问题很快变成：如果工具不是几个，而是成千上万个真实 API 呢？

[API-Bank](https://arxiv.org/abs/2304.08244)、[Gorilla](https://arxiv.org/abs/2305.15334)、[ToolLLM](https://arxiv.org/abs/2307.16789)（论文/数据集）都在处理大规模 API 使用问题。它们把 tool use 从“能不能调用计算器/搜索”推到“能不能理解工具文档、选择 API、填参数、处理返回值”。

[HuggingGPT](https://arxiv.org/abs/2303.17580)（论文/系统）则把 ChatGPT 作为任务规划器，把 Hugging Face 上的模型当成工具池。它的思路很典型：LLM 不一定自己会所有能力，但可以拆任务、选模型、组合结果。

这一阶段的转折是：

```text
工具不再是几个手写函数。
工具世界变成 API、模型库、文档、参数和返回值组成的外部生态。
```

## 2023：长期能力成为核心问题

短任务可以靠上下文硬撑，长任务不行。2023 年另一条主线是长期记忆、技能积累和长期存在。

[Generative Agents](https://arxiv.org/abs/2304.03442)（论文；[单篇阅读](/posts/generative-agents-paper-reading/)）把“可置信的社会行为”拆成三个机制：

```text
memory + reflection + planning
```

这篇不是因为 Smallville demo 好玩才重要，而是因为它把观察如何进入记忆、记忆如何被检索、反思如何生成高层抽象、计划如何影响行为，拆成了一个后续很多长期 Agent 都绕不开的框架。

[Voyager](https://arxiv.org/abs/2305.16291)（论文/系统；[单篇阅读](/posts/voyager-paper-reading/)）把 LLM Agent 放进 Minecraft，核心是 automatic curriculum、skill library、iterative prompting。它的重要性在于说明 Agent 的能力不只存在于模型参数里，也可以存在于外部技能库和可执行代码里。

[MemGPT](https://arxiv.org/abs/2310.08560)（论文/系统）把上下文窗口问题翻译成系统问题：有限上下文窗口像主存，外部存储像外存，Agent runtime 需要管理读写、分页和中断。它把 memory 从“加一个向量数据库”推进到“上下文管理机制”的层面。

这一阶段的转折是：

```text
Agent 开始被理解为长期运行系统。
记忆、技能、反思、上下文管理成为 runtime 问题。
```

## 2023：多 Agent 从社会模拟走向工程协作

Generative Agents 讲的是社会行为，另一批 2023 年工作把多 Agent 推向工程编排和角色协作。

[CAMEL](https://arxiv.org/abs/2303.17760)（论文）把两个角色的对话组织成任务推进过程，是早期多 Agent 对话框架的代表。

[AutoGen](https://arxiv.org/abs/2308.08155)（论文/框架）更偏工程：多个可配置 Agent 通过对话协作，调用工具、写代码、执行任务。它把多 Agent 从“模拟社会”拉向“编排应用”。

[MetaGPT](https://arxiv.org/abs/2308.00352) 和 [ChatDev](https://arxiv.org/abs/2307.07924)（论文/系统）把软件公司式角色分工写进多 Agent 协作：产品经理、架构师、工程师、测试等角色按流程推进。这条线后来会和 workflow、SOP、agent orchestration 绑在一起。

这一阶段的转折是：

```text
多 Agent 不只是模拟很多角色生活。
它也可以把人类工作流拆成角色、消息和任务交接。
```

## 2023-2024：评测从文本题走向真实环境

Agent 一旦能行动，传统 NLP benchmark 就不够了。评测开始从“回答对不对”转向“环境状态有没有被正确改变”。

[WebArena](https://arxiv.org/abs/2307.13854)（评测）提供真实网站风格的网页环境，让 Agent 在网页中完成任务。它把 Web 操作变成可复现 benchmark。

[AgentBench](https://arxiv.org/abs/2308.03688)（评测）尝试从多个环境评估 LLM-as-Agent 能力，是早期比较系统的 Agent benchmark。

[SWE-bench](https://arxiv.org/abs/2310.06770)（评测）把代码生成从单函数题推到真实 repo issue 修复。模型要读 issue、理解代码库、定位文件、修改实现、跑测试，并让 patch 通过。

[GAIA](https://arxiv.org/abs/2311.12983)（评测）面向通用 AI assistant，任务需要检索、推理、工具使用和多步综合。

[OSWorld](https://arxiv.org/abs/2404.07972)（评测）把 Agent 放进真实计算机环境，评估 GUI/OS 任务能力。它说明 Agent 不能只会调 API 或网页按钮，还要能面对更开放的桌面环境。

[$\tau$-bench](https://arxiv.org/abs/2406.12045)（评测）强调状态化任务、用户模拟、业务规则和 pass^k。它关心的不只是单次成功，而是同一个 Agent 多次运行是否稳定完成任务。

这一阶段的转折是：

```text
Agent 评测开始看环境状态、真实 repo、网页、OS、业务规则和稳定性。
```

## 2023-2024：工程框架从链式调用走向状态化 runtime

当 Agent 从 demo 进入工程，问题会变成：状态在哪里？工具怎么注册？失败怎么恢复？人什么时候介入？

[DSPy](https://arxiv.org/abs/2310.03714)（框架/论文）不是典型 Agent 框架，但它重要在于把 LM pipeline 从手写 prompt 推向可声明、可优化的程序。它影响的是“LLM 应用如何系统化调参和编译”。

[LangGraph](https://langchain-ai.github.io/langgraph/)（框架）把 Agent 编排做成显式图和状态机，适合长流程、可恢复、人类介入的 Agent 应用。它代表了从 LangChain 式链式调用走向 stateful runtime 的工程趋势。

这一阶段的转折是：

```text
Agent 工程不再只是 prompt chain。
状态、恢复、人类介入和可观测性开始成为 runtime 设计问题。
```

## 2024：软件工程 Agent 变成独立战场

SWE-bench 之后，coding agent 很快从“代码生成”变成“软件工程自动化”。

[SWE-agent](https://arxiv.org/abs/2405.15793)（论文/系统）提出 Agent-Computer Interface 的重要性。它提醒我们：Agent 能不能修好 bug，不只取决于模型，也取决于 shell、文件编辑、搜索、测试反馈这些接口怎么设计。

[CodeAct](https://arxiv.org/abs/2402.01030)（论文）把 executable code 作为统一 action space。和 PAL、Voyager 一样，它抓住了一个关键工程抽象：让模型输出可执行代码，再由环境返回真实反馈。

[OpenHands](https://arxiv.org/abs/2407.16741)（开源平台/论文）把软件开发 Agent 所需的代码、shell、浏览器、沙盒和评测整合起来。它代表了一个趋势：coding agent 不再是单个 prompt，而是一个完整运行环境。

这一阶段的转折是：

```text
软件工程 Agent 的关键问题从“会不会写代码”，变成“能否在真实开发环境里闭环工作”。
```

## 2024：协议化和评测反思

2024 年之后，Agent 的工程问题开始从“框架怎么写”扩展到“系统之间怎么连接、评测到底有没有意义”。

[Model Context Protocol](https://www.anthropic.com/news/model-context-protocol)（协议）把 AI assistant 和外部工具/数据源的连接推向 client/server 协议层。它的意义不是“又一个插件系统”，而是把工具连接、权限边界和上下文供给标准化。

[Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)（工程博客）明确区分 workflow 和 agent：workflow 是沿预定义代码路径执行，agent 是让模型动态决定流程和工具。这是工程实践里非常重要的边界。

[AI Agents That Matter](https://arxiv.org/abs/2407.01502)（论文/评测反思）提醒我们，Agent benchmark 不能只看任务成功率，还要看成本、复现性、过拟合、真实任务对应关系和评测协议。

这一阶段的转折是：

```text
Agent 工程开始从框架内部走向协议边界。
Agent 评测也开始反思成本、复现和真实任务有效性。
```

## 2025：产品化和 Agent 互操作

2025 年的关键变化，是 Agent 能力开始更明确地进入产品形态，同时协议讨论从“工具怎么接”扩展到“Agent 之间怎么协作”。

[Operator](https://openai.com/index/introducing-operator/) 和 [Deep Research](https://openai.com/index/introducing-deep-research/)（产品）代表 Agent 能力进入普通用户产品：一个偏浏览器/网页操作，一个偏长程检索、综合和引用式研究。

[A2A](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)（协议）进一步把问题推到 Agent-to-Agent 互操作：如果未来不是一个 Agent 调所有工具，而是多个 Agent 跨系统协作，它们需要通信协议和能力发现机制。

[Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)（产品/开发工具）代表 coding agent 进入真实开发者工作流。它把代码搜索、文件读写、shell 执行、权限确认、上下文压缩、MCP、插件、技能、子 Agent、IDE bridge、Git workflow 和终端 UI 组织成长期运行工具。

这一阶段的转折是：

```text
Agent 不再只是模型能力展示。
它变成由协议、权限、沙盒、工具注册、可观测性和产品交互组成的工程系统。
```

## 2026：长期模拟和可靠性继续分化

到 2026 年，两个问题变得更突出：一边是更长时间尺度的 Agent 社会模拟，另一边是工程 Agent 的可靠性科学。

[Agentopia](https://arxiv.org/abs/2606.07513)（论文/系统；[单篇阅读](/posts/agentopia-paper-reading/)）更适合看作 Generative Agents 之后的社会模拟支线。它把模拟拉到 100 个 Agent、10 个模拟年，并尝试用 life reward 把长期生活轨迹变成训练数据。它不是主干转折点，但对理解“长期社会模拟 Agent”很有价值。

[Towards a Science of AI Agent Reliability](https://arxiv.org/abs/2602.16666)（论文）进一步把可靠性拆成 consistency、robustness、predictability、safety 等维度。这个方向对工程落地很重要，因为上线后的 Agent 不能只在某一次 seed 下“看起来能用”。

[EdgeBench](https://github.com/ByteDance-Seed/EdgeBench)（评测/技术报告；[单篇阅读](/posts/edgebench-paper-reading/)）可以接在这条线上。它不是再测一次 one-shot success rate，而是把 Agent 放进可执行任务环境，让它在 12 小时以上的时间预算里通过本地反馈和隐藏 judge 反馈持续迭代。它的 134 个任务覆盖科学与机器学习、系统与软件工程、组合优化、专业知识工作、形式化数学和交互游戏，并公开了其中 51 个任务和评测框架。对这条主线来说，EdgeBench 的关键价值在于把“Agent 会不会做题”推进到“Agent 能不能从真实环境反馈中学习，以及这种学习曲线是否可度量”。

这条线最终会回到系统问题：

```text
失败能不能被复现？
错误有没有边界？
工具权限能不能审计？
同一个任务多次运行是否稳定？
成本和时延是否可控？
用户如何接管？
```

## 时间线速览

| 时间 | 节点 | 标注 | 为什么重要 | 系列状态 |
| --- | --- | --- | --- | --- |
| 2021-12 | WebGPT | 论文 | 浏览器、引用、人类反馈雏形 | 已完成 |
| 2022-01 / 03 | CoT / Self-Consistency | 论文 | 推理过程显式化，多路径稳定化 | 待写 |
| 2022-05 | MRKL | 论文 | LLM 作为模块化系统路由器 | 已完成 |
| 2022-10 | ReAct | 论文 | reasoning + acting 闭环 | 已完成 |
| 2022-11 | PAL | 论文 | 程序作为可执行推理载体 | 待写 |
| 2023-02 | Toolformer | 论文 | 工具调用进入训练数据构造 | 已完成 |
| 2023-03 | Reflexion / Self-Refine | 论文 | 语言反思与测试时修正 | 待写 |
| 2023-03/04 | AutoGPT / BabyAGI | 开源项目 | 自主 Agent 进入开发者社区 | 待写 |
| 2023-04 | Generative Agents | 论文/系统 | 记忆、反思、规划支撑长期行为 | 已完成 |
| 2023-05 | Tree of Thoughts | 论文 | 多路径搜索式推理 | 待写 |
| 2023-05 | Voyager | 论文/系统 | 技能库、自动课程、开放环境探索 | 已完成 |
| 2023-06 | Function calling | 产品/API | 工具调用 schema 化 | 待写 |
| 2023-04/05/07 | API-Bank / Gorilla / ToolLLM | 论文/数据集 | 大规模真实 API 使用 | 待写 |
| 2023-07/08 | ChatDev / AutoGen / MetaGPT | 框架/论文 | 多 Agent 工程协作 | 待写 |
| 2023-10 | DSPy | 框架/论文 | LM pipeline 可声明、可优化 | 待写 |
| 2023-10 | MemGPT | 论文/系统 | 上下文管理作为 memory runtime | 待写 |
| 2023-10 | SWE-bench | 评测 | 真实 repo issue 修复 | 待写 |
| 2023-11 | GAIA | 评测 | 通用助手多步任务 | 待写 |
| 2024 | LangGraph | 框架 | 状态化 Agent runtime | 待写 |
| 2024-04 | OSWorld | 评测 | GUI/OS 真实环境 | 待写 |
| 2024-05 | SWE-agent | 论文/系统 | Agent-Computer Interface | 待写 |
| 2024-06 | tau-bench | 评测 | 状态化任务与 pass^k | 待写 |
| 2024-07 | AI Agents That Matter | 评测反思 | 成本、复现和 benchmark 有效性 | 待写 |
| 2024-11 | MCP | 协议 | 工具/数据连接协议化 | 待写 |
| 2024-12 | Building Effective Agents | 工程博客 | workflow 与 agent 边界 | 待写 |
| 2025-01/02 | Operator / Deep Research | 产品 | 浏览器操作和长程研究产品化 | 待写 |
| 2025-04 | A2A | 协议 | Agent-to-Agent 互操作 | 待写 |
| 2025 | Claude Code / coding agents | 产品/工程系统 | Agent 进入真实开发工作流 | 待写 |
| 2026-02 | Agent Reliability | 论文 | 可靠性拆解为可研究维度 | 待写 |
| 2026-06 | Agentopia | 论文/系统 | 长期社会模拟与轨迹训练数据 | 已完成 |
| 2026-07 | EdgeBench | 评测/技术报告 | 长时程真实环境反馈与 Agent 学习曲线 | 已完成 |

如果这组文章能写完，它应该不是“读过哪些论文”的清单，而是一条能支撑后续研究和工程判断的主线。
