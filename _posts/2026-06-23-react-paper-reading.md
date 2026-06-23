---
title: ReAct 论文阅读：把语言模型从回答器变成会行动的 Agent
date: 2026-06-23 16:30:00 +0800
categories: [论文阅读, Agent]
tags: [ReAct, LLM Agent, Chain of Thought, Tool Use, 论文阅读]
---

## 原文信息

- 论文：ReAct: Synergizing Reasoning and Acting in Language Models
- 作者：Shunyu Yao, Jeffrey Zhao, Dian Yu, Nan Du, Izhak Shafran, Karthik Narasimhan, Yuan Cao
- 会议：ICLR 2023
- arXiv：[2210.03629](https://arxiv.org/abs/2210.03629)
- 项目页：[react-lm.github.io](https://react-lm.github.io/)

这篇文章是现代 LLM Agent 很重要的起点之一。它真正提出的问题不是“怎么让模型回答得更好”，而是：

> 一个语言模型如何在任务过程中一边推理，一边行动，并根据外部反馈继续调整后续行为？

## 先澄清几个概念

ReAct 里的 `Reasoning` 不是一个单独的 Python 工具，也不是模型内部显式存在的 `reasoning.py` 模块。它在论文里主要表现为模型生成的自然语言 `Thought`。

`Thought` 的作用不是直接改变外部环境，而是写入当前上下文，帮助模型维护计划、记录状态、分解目标、解释观察结果，并决定下一步动作。

`Action` 则是真正作用于外部环境的操作，例如：

```text
Search[entity]
Lookup[string]
Finish[answer]
```

或者在文本游戏里：

```text
go to cabinet
open drawer
take knife
```

`Observation` 是环境返回给模型的信息。模型下一步会基于完整轨迹继续生成 `Thought` 或 `Action`。

所以 ReAct 不是固定的“先想一步，再做一步”，而是允许模型在轨迹里交错插入推理和行动。

## ReAct 要解决什么问题

论文对比了两类已有范式。

第一类是 **Reasoning-only**，典型代表是 Chain-of-Thought prompting。模型会生成中间推理步骤，但它主要依赖内部参数知识。问题是它没有外部 grounding，容易出现事实幻觉，也可能在错误推理链上继续传播错误。

第二类是 **Acting-only**。模型可以调用搜索、点击网页、移动、拿取物体等动作，但缺少显式计划和状态追踪。它可能会重复无效动作，也可能忘记当前目标和已经完成的子目标。

ReAct 的核心想法是把两者合在一起：

```text
reason to act:
    用推理决定下一步该做什么。

act to reason:
    用行动获取外部信息，再把观察结果纳入后续推理。
```

这就是它标题里的 synergizing reasoning and acting。

## 方法：把 Thought 也放进 Agent 轨迹

论文从一个通用 agent 设定出发：agent 在每个时间步接收观察，基于历史上下文选择动作。

普通 agent 的动作空间可以写成：

```text
A = {Search, Lookup, Click, Move, Take, Finish, ...}
```

ReAct 做的事情是扩展动作空间：

```text
A_hat = A ∪ L
```

其中 `L` 是语言空间，也就是 `Thought`。这一步很关键：论文不是把 Thought 当作最终答案前的解释，而是把它当成 agent 轨迹中的一种中间操作。

区别在于：

```text
Action:
    会作用于外部环境，并得到 Observation。

Thought:
    不作用于外部环境，只写入上下文，影响后续生成。
```

一个典型 HotpotQA 轨迹类似：

```text
Question: Aside from the Apple Remote, what other device can control Front Row?

Thought 1: I need to search Front Row and find how it can be controlled.
Action 1: Search[Front Row software]
Observation 1: Front Row is a discontinued media center software...

Thought 2: I need to look up what devices control it.
Action 2: Lookup[controlled]
Observation 2: Front Row can be controlled by an Apple Remote or keyboard function keys.

Thought 3: The answer is keyboard function keys.
Action 3: Finish[keyboard function keys]
```

这里真正重要的是闭环：

```text
上下文 -> Thought/Action -> Observation -> 新上下文 -> 下一步
```

## 用伪代码理解 ReAct Agent

可以把 ReAct 写成下面这个最小 agent loop：

```python
def react_agent(task, llm, environment, max_steps=10):
    trajectory = []

    for _ in range(max_steps):
        prompt = build_prompt(task, trajectory)
        next_step = llm.generate(prompt)
        step = parse_step(next_step)

        if step.type == "thought":
            trajectory.append({
                "type": "thought",
                "content": step.content,
            })
            continue

        if step.type == "action":
            trajectory.append({
                "type": "action",
                "name": step.name,
                "args": step.args,
            })

            if step.name == "finish":
                return step.args["answer"], trajectory

            observation = environment.step(step.name, step.args)
            trajectory.append({
                "type": "observation",
                "content": observation,
            })
            continue

    return None, trajectory
```

这个伪代码里有一个容易误解的点：agent runtime 不需要强制每个动作后都生成 Thought。

更准确地说，每一步模型都可以生成：

```text
Thought
```

或者：

```text
Action
```

知识推理任务里 Thought 往往很密集，因为每次检索结果都需要被解释和转化为下一次查询。交互决策任务里 Thought 可以更稀疏，只在目标分解、状态更新、错误恢复、下一阶段规划时出现。

因此 ReAct 不是机械模板：

```text
Thought -> Action -> Observation -> Thought -> Action -> Observation
```

而是更一般的轨迹：

```text
Thought / Action / Observation / Action / Observation / Thought / Action ...
```

## 实验一：知识密集型推理

论文首先测试 HotpotQA 和 FEVER。

HotpotQA 是多跳问答，需要跨多个 Wikipedia 页面推理。FEVER 是事实验证，需要判断 claim 是 `SUPPORTS`、`REFUTES` 还是 `NOT ENOUGH INFO`。

ReAct 在这两个任务中使用一个简化 Wikipedia API：

```text
Search[entity]:
    搜索实体页面，返回前几句，或返回相似实体建议。

Lookup[string]:
    在当前页面中查找包含指定字符串的下一句。

Finish[answer]:
    输出最终答案并结束任务。
```

实验结果里，ReAct 明显优于 Act-only，说明推理能帮助模型更好地使用检索动作和综合最终答案。

但 ReAct 单独并没有在所有场景里压过 CoT。HotpotQA 上，ReAct 的 EM 是 27.4，CoT 是 29.4，CoT-SC 是 33.4。FEVER 上，ReAct 是 60.9，高于 CoT 的 56.3，也略高于 CoT-SC 的 60.4。

最好的结果来自 ReAct 和 CoT-SC 的组合：

| 方法 | HotpotQA EM | FEVER Acc |
| --- | ---: | ---: |
| Standard | 28.7 | 57.1 |
| CoT | 29.4 | 56.3 |
| CoT-SC | 33.4 | 60.4 |
| Act-only | 25.7 | 58.9 |
| ReAct | 27.4 | 60.9 |
| CoT-SC -> ReAct | 34.2 | 64.6 |
| ReAct -> CoT-SC | 35.1 | 62.0 |

这个结果很重要。它说明 ReAct 不是简单地“替代 CoT”，而是在某些地方补足 CoT。

可以这样理解：

```text
CoT:
    更擅长用模型内部知识组织推理结构，
    但容易事实幻觉。

ReAct:
    更擅长通过外部检索 grounding，
    但依赖搜索结果质量，也受限于动作空间。

ReAct + CoT-SC:
    同时利用内部知识和外部信息。
```

## 实验二：交互式决策任务

论文还测试了 ALFWorld 和 WebShop。

ALFWorld 是文本家居环境，agent 需要完成类似“把清洁过的刀放到柜台上”的任务。任务可能有很多地点和物体，需要长程规划、探索、状态追踪和常识判断。

WebShop 是网页购物任务，agent 需要搜索商品、比较属性、选择选项并购买符合要求的商品。

这类任务里，ReAct 的优势更明显。

ALFWorld 上：

| 方法 | 总成功率 |
| --- | ---: |
| Act best-of-6 | 45 |
| ReAct avg | 57 |
| ReAct best-of-6 | 71 |
| ReAct-IM best-of-6 | 53 |
| BUTLER best-of-8 | 37 |

WebShop 上：

| 方法 | Score | Success Rate |
| --- | ---: | ---: |
| Act | 62.3 | 30.1 |
| ReAct | 66.6 | 40.0 |
| IL | 59.9 | 29.1 |
| IL+RL | 62.4 | 28.7 |
| Human Expert | 82.1 | 59.6 |

这里的核心结论是：在长程交互任务里，Thought 的价值不只是解释，而是帮助 agent 做状态管理。

比如：

```text
我已经找到了刀。
现在需要清洗它。
清洗通常要去 sinkbasin。
清洗完成后再把它放到 countertop。
```

如果没有这种中间状态，Act-only 很容易连续执行动作但忘记自己为什么这么做。

## Failure modes：ReAct 不是万能的

论文有一段很值得看的人类标注分析。它比较了 ReAct 和 CoT 在 HotpotQA 上的成功和失败类型。

ReAct 的优势是幻觉少。成功样本中，ReAct false positive 只有 6%，CoT 是 14%。失败样本中，CoT 有 56% 是 hallucination，而 ReAct 是 0%。

但 ReAct 也有自己的问题：

```text
Reasoning error:
    Thought 写错，或者无法跳出重复步骤。

Search result error:
    搜索结果为空，或者没有返回有用信息。

Label ambiguity:
    预测其实合理，但和数据集标签不完全匹配。
```

这说明 ReAct 的可靠性依赖几个条件：

- 外部工具返回的信息要有用。
- 模型要能根据 Observation 改写下一步计划。
- 模型不能陷入重复 Thought/Action。
- 动作空间本身要足够表达任务需要。

所以 ReAct 降低了纯 CoT 的事实幻觉，但把一部分风险转移到了工具质量、检索策略和闭环控制上。

## 我对这篇文章的理解

ReAct 的贡献不是发明了工具调用，也不是简单加了一个 `Thought:` 标签。它真正重要的地方在于把 LLM 从一次性回答器改造成了一个交互式 policy。

在这个视角下，LLM 每次输出的不一定是最终答案，而是下一步轨迹项：

```text
可能是 Thought，用来维护内部计划；
可能是 Action，用来查询或改变外部环境；
可能是 Finish，用来结束任务。
```

这带来了一个更 general 的 agent mental model：

```text
Agent = LLM policy + trajectory context + environment feedback + action space
```

ReAct 之后，很多 agent 框架本质上都在工程化这个循环：

- prompt 里定义可用工具；
- runtime 解析模型输出；
- 执行工具调用；
- 把 observation 写回上下文；
- 继续让模型决定下一步。

后来的 function calling、LangGraph、AutoGen、MCP，都可以看成是在不同层面把这个循环做得更稳定、更结构化、更可控。

## 总结

如果只用一句话总结 ReAct：

> ReAct 把自然语言推理变成 agent 轨迹中的一种中间操作，让模型可以在外部反馈中持续更新计划、状态和行动。

它的关键不是每一步都要显式 Thought，而是 agent 在需要时能用语言维护自己的任务状态，并把外部 Observation 纳入后续决策。

这也是为什么 ReAct 虽然形式简单，却成为 LLM Agent 领域的基础论文：它定义了一个最小但完整的闭环。
