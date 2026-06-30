---
title: PageRank 到 LLM 排行榜：排序算法到底在奖励什么
date: 2026-06-30 22:30:00 +0800
categories: [学习笔记, 数据结构与算法]
tags: [PageRank, Ranking, Agent Evaluation]
---

PageRank、Elo、TrueSkill 这些算法确实都不新。PageRank 和 HITS 来自早期 Web 搜索，Elo 更早，TrueSkill 也是 2000 年代中期的在线游戏匹配算法。但它们并没有因为“古早”就失去价值。更准确地说，它们今天很少作为完整系统的全部答案，却经常作为一个评分模块，被嵌进搜索、推荐、社交网络、游戏匹配、论文影响力评估、Agent 社会模拟和 LLM 排行榜里。

读这类算法时，不应该只问“公式是什么”，更应该问：

```text
这个排序算法把什么东西当作信号？
它把什么关系放大了？
它忽略了什么？
它最后奖励的是能力、声望、中心性、胜率，还是迎合评价器的能力？
```

## PageRank：被重要的人指向

PageRank 的核心直觉是：一个节点重要，不只是因为很多人指向它，还因为**重要的人**指向它。它最初用于网页链接图，但这个想法可以迁移到很多有向图里，例如引用网络、社交认可网络、推荐图、知识图谱。

经典形式可以写成：

```text
r_{k+1} = d P r_k + (1 - d) p
```

这里：

- `r` 是每个节点的分数。
- `P` 是图上的转移矩阵。
- `d` 是阻尼系数，常见值是 0.85。
- `p` 是随机跳转分布。

如果 `p` 是均匀分布，意思是随机跳转时每个节点机会一样。如果 `p` 不是均匀分布，就变成 personalized PageRank：系统会持续注入一个先验偏好。

这点很重要。比如在社会模拟里，如果 `p` 均匀，排名更像是从互动关系图里长出来的；如果 `p` 偏向老师、管理者、富人、热门角色，那么排名定义里就已经写进了制度地位或身份先验。表面看仍然是 PageRank，实际上奖励函数已经变了。

Agentopia 的社会奖励就用了加权 PageRank。代码里的 teleport 项是均匀的，也就是没有显式给某些身份更高的 `p`。但它又在 PageRank 收敛后加了互相重视加成，所以并不是最朴素版本。

## HITS：权威和枢纽是两种角色

HITS 和 PageRank 很像，也来自早期 Web 链接分析，但它拆出了两个分数：

- authority：被好 hub 指向的页面，是权威。
- hub：指向好 authority 的页面，是枢纽。

这比 PageRank 多了一层结构判断。一个节点可能自己不是权威内容，但它很擅长指向一组权威内容；另一个节点可能不怎么链接别人，但经常被好 hub 指向。Web 目录、论文综述、资料导航站都很适合用这个视角理解。

放到 Agent 或社会系统里也可以类比：有的人自己不是最强专家，但很会连接资源；有的人是领域权威，但不一定是社交中心。PageRank 容易把这些都压成一个分数，HITS 至少提醒我们“影响力”可能不是单维度。

## Elo、Glicko、TrueSkill：从比赛结果估计能力

另一类排序算法不是看图，而是看对战或比较结果。

Elo 的基本设定是：两个人比赛，系统根据赛前分差预测胜率；如果弱者赢了强者，弱者涨分更多。它适合国际象棋这类一对一、结果明确的场景。

Glicko 在 Elo 的基础上加入了不确定性。长期不比赛的人，分数可信度会下降；新选手的分数波动也应该更大。这比只维护一个分数更合理。

TrueSkill 更进一步，把技能看成一个概率分布，通常写成均值和方差。它适合多人、组队、带平局的游戏环境。Generative Agents 论文里的人类可置信度排序，就把不同系统条件之间的相对排序转成 TrueSkill 分数。

这类算法回答的问题是：

```text
从一堆胜负、排序、偏好比较里，如何估计每个对象的潜在能力？
```

它们的问题也很直接：如果比赛机制、匹配分布或评价人群有偏，分数会把这些偏差也吸进去。

## Bradley-Terry：LLM 排行榜常用的偏好模型

现在很多 LLM 排行榜不是让人直接给模型打绝对分，而是做成两两比较：

```text
同一个问题，模型 A 和模型 B 谁回答得更好？
```

Bradley-Terry 模型就是处理这种成对偏好的经典方法。它假设每个对象有一个潜在强度，两个对象相遇时，谁赢的概率由两者强度差决定。Chatbot Arena / LMArena 这类平台就采用过这种思路来聚合人类偏好。

这也是为什么 LLM 排行榜看起来很现代，底层统计模型却很经典：新的是数据来源、交互规模、模型对象和使用场景；老的是“从比较中估计潜在强度”的数学骨架。

近期更值得注意的不是“Bradley-Terry 被完全替代了”，而是围绕它出现的新问题：冷启动、新模型插入、恶意投票、排行榜稳定性、置信区间、top-k 是否容易被少量样本扰动。也就是说，今天的难点更多在系统设计和统计稳健性，而不是单个公式是否新。

## 学习排序：从手写公式到训练排序器

PageRank 和 Elo 这类算法通常有很强的手工建模味道：先定义信号，再写出公式。搜索和推荐系统后来走向 learning to rank，也就是让模型从训练数据中学习如何排序。

常见分法是：

- pointwise：单独判断一个候选项的分数。
- pairwise：学习 A 是否应该排在 B 前面。
- listwise：直接优化整个列表的排序质量。

传统工业系统里，LambdaRank、LambdaMART、梯度提升树、各种特征工程长期很重要。进入深度学习和大模型时代之后，排序又进一步变成了多阶段系统：

```text
召回：先从海量候选里取出一小批
粗排：用便宜模型快速过滤
精排：用更强模型重新排序
重排：加入多样性、公平性、业务规则或安全约束
```

这里 PageRank 这类静态图分数不一定消失，而是变成一个特征，和文本相关性、点击率、用户画像、时间衰减、内容质量、商业约束一起进入排序系统。

## 神经检索和 LLM 排序：新在哪里

近年的更新主要不在“再发明一个 PageRank”，而在两个方向。

第一是神经检索和神经排序。ColBERT 这类模型把查询和文档编码成向量，再用更细粒度的交互计算相关性。SPLADE 这类学习稀疏检索模型则尝试兼顾传统倒排索引效率和语义匹配能力。这些方法解决的是“文本/多模态内容如何相关”，不是“图上谁更中心”。

第二是 LLM 直接参与排序。比如让 LLM 做 pairwise ranking：每次比较两个候选，最后再把比较结果汇总成排序。这个方向和 Bradley-Terry、Elo、TrueSkill 的关系很近：LLM 可以做比较器，统计模型负责把比较结果变成稳定排名。

所以现在的排序系统经常是混合结构：

```text
图算法提供结构信号
学习排序模型融合多种特征
神经检索处理语义相关性
偏好模型聚合人类或模型比较
业务规则控制最终展示
```

单个经典算法还能讲清楚，但真实系统通常已经不是单算法系统。

## 这些算法分别在奖励什么

| 算法 | 主要输入 | 排名含义 | 典型应用 | 主要风险 |
| --- | --- | --- | --- | --- |
| PageRank | 有向图、边权 | 被重要节点指向 | 网页、引用、社交认可、Agent 社会奖励 | 放大中心节点，容易把结构性优势当能力 |
| personalized PageRank | 有向图、边权、先验分布 `p` | 带先验偏好的重要性 | 个性化推荐、主题搜索、局部图排序 | 先验分布会改变价值定义 |
| HITS | 查询相关子图 | authority 与 hub | Web 搜索、资料导航、引用网络 | 容易受子图构造影响 |
| Elo | 一对一胜负 | 相对胜率 | 棋类、竞技、简单排行榜 | 不表达不确定性，难处理多人/组队 |
| Glicko | 胜负 + 不确定性 | 带可信度的能力估计 | 棋类、在线竞技 | 仍依赖匹配分布和结果定义 |
| TrueSkill | 多人/组队比赛结果 | 技能分布 | 游戏匹配、人类排序评估 | 模型假设较强，解释成本更高 |
| Bradley-Terry | 成对偏好 | 潜在偏好强度 | LLM 排行榜、A/B 比较 | 对采样、投票人群、平局处理敏感 |
| learning to rank | 特征 + 标签 | 任务目标下的排序质量 | 搜索、推荐、广告 | 可解释性下降，训练数据偏差会固化 |
| 神经排序 | 文本、图像、向量、上下文 | 语义相关性或偏好相关性 | 现代检索、RAG、推荐 | 成本高，评估和鲁棒性更难 |

## 对 Agent 研究有什么用

Agent 研究里越来越常出现“排名”问题：

- 多个 Agent 互相评价，如何聚合成社会地位？
- 多个模型对同一任务作答，如何排 leaderboard？
- 多条轨迹都完成任务，如何选训练数据？
- 多个工具、技能、记忆片段都相关，如何决定先用哪个？
- 多个反思、计划或行动候选，如何选择下一步？

这时候不能只把 PageRank、Elo 或 Bradley-Terry 当作中立数学工具。它们都会把某种世界观写进系统。

比如 PageRank 会说“被重要者认可更重要”；Elo 会说“打败强者更说明能力”；Bradley-Terry 会说“成对偏好可以还原潜在强度”；learning to rank 会说“历史标签里的偏好值得学习”。这些假设在搜索、游戏和排行榜里已经需要小心，放进 Agent 社会模拟和模型训练里更要小心。

一个实用检查清单是：

```text
1. 输入信号是谁给的？
2. 边权、胜负、偏好是否可靠？
3. 排名是否会放大已有中心性？
4. 是否区分能力、受欢迎度、资源位置和迎合评价器？
5. 冷启动和长尾对象会不会被系统性压低？
6. 分数变化能不能解释到具体行为？
7. 少量扰动会不会改变 top-k？
```

## 参考

- Larry Page, Sergey Brin, Rajeev Motwani, Terry Winograd, *The PageRank Citation Ranking: Bringing Order to the Web*, 1998.
- Jon Kleinberg, [*Authoritative Sources in a Hyperlinked Environment*](https://www.cs.cornell.edu/home/kleinber/auth.pdf), 1999.
- Ralf Herbrich, Tom Minka, Thore Graepel, [*TrueSkill™: A Bayesian Skill Rating System*](https://www.microsoft.com/en-us/research/publication/trueskilltm-a-bayesian-skill-rating-system/), 2007.
- Microsoft Research, [*TrueSkill 2: An improved Bayesian skill rating system*](https://www.microsoft.com/en-us/research/publication/trueskill-2-improved-bayesian-skill-rating-system/), 2018.
- Omar Khattab, Matei Zaharia, [*ColBERT: Efficient and Effective Passage Search via Contextualized Late Interaction over BERT*](https://arxiv.org/abs/2004.12832), 2020.
- Zhen Qin et al., [*Large Language Models are Effective Text Rankers with Pairwise Ranking Prompting*](https://arxiv.org/abs/2306.17563), 2023.
- Wei-Lin Chiang et al., [*Chatbot Arena: An Open Platform for Evaluating LLMs by Human Preference*](https://arxiv.org/abs/2403.04132), 2024.
- Hosna Oyarhoseini, Jimmy Lin, Amir-Hossein Karimi, [*A Unified Perturbation Framework for Analyzing Leaderboard Stability and Manipulation*](https://arxiv.org/abs/2605.15761), 2026.
