---
title: Toolformer 论文精读：语言模型如何通过自监督学习获得工具使用能力
date: 2026-06-24 10:30:00 +0800
categories: [论文阅读, Agent]
tags: [Toolformer, LLM Agent, Tool Use, Self-supervised Learning, 论文阅读]
---

## 原文信息

- 论文：Toolformer: Language Models Can Teach Themselves to Use Tools
- 作者：Timo Schick, Jane Dwivedi-Yu, Roberto Dessi, Roberta Raileanu, Maria Lomeli, Luke Zettlemoyer, Nicola Cancedda, Thomas Scialom
- 机构：Meta AI Research
- arXiv：[2302.04761](https://arxiv.org/abs/2302.04761)

这篇文章的核心并不是简单地“给语言模型外挂几个工具”，而是讨论一个更具体的研究问题：

> 如果没有大量人工标注，语言模型能不能自己学会什么时候该调用工具、调用哪个工具、传什么参数，以及如何把工具结果接回后续生成？

Toolformer 给出的方案是：让模型在未标注语料中自动插入候选 API call，再用一个基于语言建模损失的自监督准则筛选有效调用。

> 读这篇时我觉得最重要的不是“它接入了哪些工具”，而是它把工具调用标注问题转化成了自监督数据构造问题。
{: .prompt-tip }

## 这篇论文要解决的问题

大语言模型已经表现出较强的 zero-shot 与 few-shot 泛化能力，但在若干基础能力上仍然存在结构性短板。

例如：

- 模型可以生成复杂解释，但精确算术仍不稳定。
- 模型可以回答事实问题，但容易受到知识过时和事实幻觉影响。
- 模型具备一定多语言能力，但低资源语言理解仍不稳定。
- 模型可以生成时间相关文本，但参数化知识无法可靠表示当前日期。

这些短板不一定只能通过扩大模型规模解决。很多能力更适合交给外部工具：

```text
Calculator:
    负责精确计算。

Search / QA:
    负责事实查询。

Calendar:
    负责当前日期。

Machine Translation:
    负责翻译。
```

真正的问题在于：模型如何学习工具调用策略？

如果每个工具都要人工标注大量样本，比如：

```text
这里应该调用 Calculator
这里应该调用 Search
这里不该调用工具
这个 query 应该这样写
```

这种范式难以扩展到大量工具和开放域场景。Toolformer 的目标就是绕开人工标注瓶颈。

> 这里的目标不是构建 ReAct 式多步交互 agent，而是让基础语言模型在自回归生成过程中学习插入单步 API call。
{: .prompt-warning }

## Toolformer 的核心想法

一句话概括：

> 让模型在普通文本中采样候选工具调用，并根据工具返回结果是否降低后续 token 的预测损失来筛选训练样本。

这里有三个关键环节。

第一个是 **未标注文本**。原始语料不是人工标注的工具调用数据，而是普通网页文本，例如：

```text
The Nile has an approximate length of 6,853 kilometers.
```

第二个是 **候选 API call 生成**。模型可能生成如下候选插入：

```text
The Nile has an approximate length of
<API> QA(What is the approximate length of the Nile?) -> 6,853 km </API>
6,853 kilometers.
```

第三个是 **基于损失的自动筛选**。如果插入 `6,853 km` 这个工具返回结果后，模型预测后续 `6,853 kilometers` 的损失下降，那么该 API call 就被视为对语言建模有贡献，可以保留为训练样本。

这就是论文所谓的 self-supervised：监督信号不是人工标签，而是原文本提供的未来 token 预测目标。

## API Call 的表示形式

Toolformer 将工具调用线性化为文本序列。

没有返回结果时：

```text
<API> API_NAME(input) </API>
```

带返回结果时：

```text
<API> API_NAME(input) -> result </API>
```

例如计算器：

```text
Out of 1400 participants, 400
(or <API> Calculator(400 / 1400) -> 0.29 </API> 29%)
passed the test.
```

或者翻译：

```text
la tortuga, the Spanish word for
<API> MT("tortuga") -> turtle </API>
turtle
```

这个设计看似朴素，但很关键：工具调用被转化为语言模型可以继续建模的 token 序列。

因此训练时仍然可以使用标准 language modeling objective。模型并不是额外学习一个工具选择分类器，而是在自回归生成过程中学习 API 调用格式及其上下文条件。

> 这也是 Toolformer 和后来 function calling 的一个区别：Toolformer 论文里的 API call 首先是训练文本中的一段 token 序列；现代 API 产品中的 tool call 则往往由协议层结构化为独立字段。
{: .prompt-tip }

## 自监督训练数据如何构造

Toolformer 从未标注文本语料 `C` 出发，构造带 API 调用标注的增强语料 `C*`。

整个过程可以分成三步。

**第一步：采样候选 API Call。** 作者先为每个工具提供少量示例，然后利用原模型的 in-context learning 能力，在文本中采样可能的工具调用。

例如原文是：

```text
Pittsburgh is also known as the Steel City.
```

模型可能生成两个候选：

```text
QA(What other name is Pittsburgh known by?)
QA(Which country is Pittsburgh in?)
```

这一步只是候选生成。模型会提出大量可能调用，其中相当一部分并不真正有用。

**第二步：执行 API Call。** 候选调用会被真实执行：

```text
QA(What other name is Pittsburgh known by?) -> Steel City
QA(Which country is Pittsburgh in?) -> United States
```

执行以后，候选调用获得真实工具返回值，后续才能评估其对语言建模目标的贡献。

**第三步：用语言建模损失筛选。** 这是整篇论文最关键的地方。

作者并不人工判断 API call 是否合理，而是比较模型预测后续文本时的语言建模损失。

直观地说，比较的是：

```text
不插入 API call 时，模型预测后文的损失。

插入 API call 但不包含 result 时，模型预测后文的损失。

插入 API call 且包含 result 时，模型预测后文的损失。
```

如果包含工具结果的版本能够显著降低后续 token 的损失，就保留该调用。

例如：

```text
Pittsburgh is also known as
<API> QA(What other name is Pittsburgh known by?) -> Steel City </API>
the Steel City.
```

这里 `Steel City` 正好帮助模型预测后面的 `the Steel City`，所以这个调用有用。

但这个候选：

```text
QA(Which country is Pittsburgh in?) -> United States
```

对预测 `the Steel City` 没什么帮助，所以会被过滤掉。

这就是 Toolformer 最核心的机制：**不是由人工标注工具调用是否正确，而是由语言建模目标筛掉对未来 token 预测无贡献的调用。**

可以把这一段压缩成如下流程：

```text
Plain text C
    -> sample candidate API calls with the LM
    -> execute candidate calls
    -> keep calls that reduce future-token loss
    -> build augmented corpus C*
    -> finetune the LM on C*
```

## 模型真正学习到什么

筛选结束后，作者用增强语料 `C*` 对模型继续微调。

这个微调并不是面向某个特定 benchmark 的监督训练，而是让模型在通用语言建模过程中学习预定义工具的调用策略：

```text
遇到需要事实补全的地方，可以调用 QA 或 Search。
遇到需要算术的地方，可以调用 Calculator。
遇到外语短语，可以调用 Machine Translation。
遇到日期问题，可以调用 Calendar。
```

更准确地说，模型需要同时学习四个子能力：

```text
which APIs to call:
    该调用哪个工具。

when to call them:
    什么时候调用。

what arguments to pass:
    如何构造参数。

how to incorporate the results:
    如何把返回结果接回后续生成。
```

因此，Toolformer 内化进参数的不是工具能力本身，而是工具调用策略。Calculator 的计算仍由外部计算器完成；模型学习的是何时生成 `Calculator(...)`，如何构造表达式，以及如何把返回结果接回后续文本。

## 推理阶段如何执行工具调用

当模型生成 API call 并输出到 `->` 时，系统暂停解码，执行对应 API，将返回结果和结束标记插入上下文，然后继续生成。

伪代码可以写成：

```python
while generating:
    next_text = model.generate_until_special_point(context)

    if next_text.contains_api_call_waiting_for_result():
        api_name, args = parse_api_call(next_text)
        result = execute_api(api_name, args)
        context += next_text
        context += format_result(result)
        context += "</API>"
        continue

    context += next_text
```

与 ReAct 的 agent loop 相比，Toolformer 更像是在语言模型生成流中插入单步工具调用。

ReAct 是：

```text
Thought -> Action -> Observation -> Thought -> ...
```

Toolformer 是：

```text
文本生成 -> API call -> API result -> 继续文本生成
```

## 工具集合

论文使用了五类工具。

| 工具 | 作用 |
| --- | --- |
| Question Answering | 回答简单事实问题 |
| Wikipedia Search | 返回 Wikipedia 片段 |
| Calculator | 做四则运算 |
| Calendar | 返回当前日期 |
| Machine Translation | 把外语短语翻译成英文 |

这些工具满足两个共同约束：

```text
输入输出都能表示成文本。
只需要少量示例就能说明使用方式。
```

## 实验结果说明了什么

Toolformer 用 GPT-J 6.7B 作为基础模型，并和几个 baseline 比较：

```text
GPT-J:
    原始模型。

GPT-J + CC:
    在普通 CCNet 文本上继续微调。

Toolformer disabled:
    用带 API call 的数据训练，但推理时禁用 API。

Toolformer:
    用带 API call 的数据训练，推理时允许执行 API。
```

它区分了两件事：

```text
带 API call 的增强语料本身是否有帮助？
推理时真实执行外部工具是否带来额外收益？
```

> 读实验时不要只看 Toolformer 是否超过 GPT-3。更关键的对照是 `Toolformer disabled`：它能区分收益究竟来自 API call 增强语料，还是来自推理阶段真实执行工具。
{: .prompt-tip }

**事实补全。** 在 LAMA 事实补全任务上，Toolformer 主要调用 QA 工具。

结果显示，Toolformer 明显超过 GPT-J、GPT-J + CC、Toolformer disabled，也超过更大的 OPT 66B 和 GPT-3 175B。

这说明在事实补全场景中，外部 QA 工具可以显著补足模型的参数化知识。

**数学任务。** 数学任务是 Toolformer 效果最直观的实验场景。

论文在 ASDiv、SVAMP、MAWPS 上测试。结果如下：

| 模型 | ASDiv | SVAMP | MAWPS |
| --- | ---: | ---: | ---: |
| GPT-J | 7.5 | 5.2 | 9.9 |
| GPT-J + CC | 9.6 | 5.0 | 9.3 |
| Toolformer disabled | 14.8 | 6.3 | 15.0 |
| Toolformer | 40.4 | 29.4 | 44.0 |
| GPT-3 175B | 14.0 | 10.0 | 19.8 |

这里可以看出：

```text
增强语料微调本身带来一定收益；
但推理时真实执行 Calculator 后，性能才大幅提升。
```

这说明工具返回结果确实参与了后续生成，而 API call 并非只是训练文本中的装饰性标记。

**问答任务。** 在 WebQuestions、Natural Questions、TriviaQA 上，Toolformer 主要使用 Wikipedia Search。

它超过同规模 GPT-J baseline，但仍落后于 GPT-3 175B。

作者认为原因包括：

```text
搜索工具较为简单；
返回结果有时不匹配；
Toolformer 不能改写 query；
Toolformer 不能浏览多个搜索结果；
Toolformer 不能交互式检索。
```

这一点很重要，因为它直接说明 Toolformer 还不是完整的交互式 search agent。

**多语言问答和日期任务。** 在 MLQA 上，Toolformer 使用 Machine Translation，把非英文问题翻译成英文，各语言都有提升。

在时间相关任务上，Calendar API 明显有用，因为当前日期本来就不应该指望模型参数记住。

## 是否损害原有语言建模能力

论文还检查了语言建模 perplexity。

结论是：Toolformer 没有明显损害原模型的语言建模能力。

原因是 `C*` 并不是一批完全不同的任务数据；它基本保留原始文本分布，只是在少量位置插入 API call。

## 模型规模与工具使用能力

论文还用不同大小的 GPT-2 模型做实验，观察工具使用能力是否随模型大小变化。

结论是：

```text
小模型基本不能有效利用工具。
工具使用能力大约在 775M 参数左右开始明显出现。
模型越大，不用工具时能力更强，用工具时能力也更强。
```

这个结论说明，工具调用能力并不是简单的格式模仿。

模型需要先有足够能力理解上下文，才能判断：

```text
这里是否需要工具；
该调用哪个工具；
query 如何构造；
返回结果如何使用。
```

因此，Toolformer 并不是把任意弱模型简单接上工具就能获得强能力，而是在已有语言理解能力基础上训练出工具使用能力。

## Decoding 策略：为什么还需要 top-k 触发

Toolformer 推理时并不总是自然地调用 API。

如果采用严格 greedy decoding，模型可能不会主动生成 `<API>`。因此作者采用了一个修改版解码策略：

```text
如果 <API> token 在 top-k 候选里，就允许生成 <API>。
```

k 越大，API 调用越频繁。

这说明 Toolformer 学到的调用决策还不完全稳定。它确实学习到了工具调用模式，但实际调用频率仍受 decoding 策略影响。

这也是读这篇文章时需要注意的地方：Toolformer 不是一个“完全自主且鲁棒”的工具调用系统，它仍然依赖一些推理时策略来释放能力。

> 这一点会影响我们对它的评价：Toolformer 证明了模型能够学习工具调用倾向，但尚未解决“可靠、低成本、按需调用工具”的工程问题。
{: .prompt-warning }

## 局限性

Toolformer 的局限很清楚，而这些局限也解释了为什么后续 agent 研究仍需要继续发展。

**不能发现新工具。** Toolformer 的自监督并不意味着模型能自动发现任意新工具。工具集合、API 名称、输入输出格式和少量 demonstrations 都需要人预先提供。

如果引入一个新工具，例如：

```text
Weather(city)
SQL(query)
CodeExecutor(code)
BrowserClick(selector)
```

原版 Toolformer 不会凭空发现它，也不会自动理解它的 affordance。需要重新提供示例、采样候选调用、执行工具、基于 loss 过滤，再进行微调。

换句话说，Toolformer 学到的是给定工具集合上的 API 调用分布，而不是开放世界中的工具发现能力。

**不能链式调用工具。** 它不能自然表达：

```text
先搜索一个实体；
再把搜索结果中的数字交给计算器；
最后根据计算结果回答。
```

原因是训练数据中的 API call 是独立生成和筛选的，并不包含多工具链式调用轨迹。

**不能交互式使用工具。** 如果搜索结果不好，Toolformer 不会像 ReAct 那样：

```text
观察搜索结果；
发现不够好；
改写 query；
再次搜索；
继续观察。
```

它更像是在文本生成中插入一次 API call，而不是维护一个多步交互循环。

**对输入表述敏感。** 是否调用 API 会受输入表述影响。这和 LLM 的 prompt sensitivity 属于同一类问题。

**样本效率不高。** 部分工具需要处理大量文本，最后才能筛出少量有效样本。论文中特别提到 calculator 调用较为稀疏。

**不考虑工具调用成本。** 筛选标准只关注工具结果是否降低语言建模损失，并不考虑工具调用的价格、延迟、失败率或安全风险。

这在真实系统里是明显不够的，因为工具调用本身有成本。

> 这些限制不是细节瑕疵，而是 Toolformer 与完整 agent 系统之间的分界线：它能够插入工具调用，但还不会围绕工具结果进行多轮规划和纠错。
{: .prompt-warning }

## 和 ReAct 的区别

ReAct 和 Toolformer 都是 tool use 相关的基础论文，但二者的问题设定不同。

| 问题 | ReAct | Toolformer |
| --- | --- | --- |
| 核心对象 | Agent 运行轨迹 | 模型训练数据 |
| 工具调用来源 | Prompt 示例和运行时循环 | 自监督采样、执行、筛选、微调 |
| 是否多步交互 | 是 | 基本不是 |
| 重点 | Thought / Action / Observation 闭环 | 学会何时插入 API call |
| 主要边界 | 依赖 prompt 和外部 loop | 不能链式、不能交互式使用工具 |

可以这样理解：

```text
ReAct:
    把工具调用放进 agent loop。

Toolformer:
    把工具调用训练进 language model。
```

把这两篇连在一起读，刚好对应 tool-using agent 的两个层面：

```text
运行时：
    agent 如何循环观察、思考、行动。

训练时：
    模型如何学会在生成中主动调用工具。
```

## 我的理解

Toolformer 的主要贡献，是在一组预先给定的文本 API 上，展示了如何把工具调用标注转化为自监督数据构造问题。

它的思路可以压缩成：

```text
让模型提出工具调用候选；
真实执行工具；
用 future-token loss 判断工具结果是否有用；
保留有用样本；
再训练模型。
```

这个机制的价值在于，它不要求人类为每个调用位置提供监督标签，也不要求每个 API 都有大规模标注数据。

但它的边界也很明显。论文标题和叙事比较 general，但实验证据支持的是 bounded tool-use learning，而不是 open-ended tool-use generalization。Toolformer 学到的是“在文本生成中插入预定义单步 API call”的能力，而不是完整 agent 的长期规划、工具发现或工具组合能力。

所以它在 agent 发展脉络里的位置可以这样放：

```text
ReAct:
    定义了 LLM agent 的基本交互循环。

Toolformer:
    证明了工具调用可以通过自监督方式进入模型能力。
```

后来的 function calling、tool-use fine-tuning、API benchmark、MCP 等工作，可以看成是在两个方向上继续工程化：一边把工具调用协议做得更结构化，一边把模型使用工具的能力训练得更可靠。

因此，Toolformer 的历史价值大于方法本身的延续性。它提出了一个早期的 self-supervised tool-use training 视角，但贡献主要停留在预定义工具集合上的调用模式学习；距离开放式工具发现、组合式工具使用和可靠 agent runtime 还有明显距离。

## 总结

一句话总结：

> Toolformer 通过自监督数据构造，让语言模型从未标注文本中自动挖掘有效 API 调用样本，并通过微调学习在生成过程中调用工具。

它不是一个完整的 agent 框架，但回答了一个关键问题：工具调用能力不一定完全依赖人工标注，也可以通过模型自身的候选生成、工具执行和基于 loss 的筛选获得。
