---
name: hesperine-blog-writer
description: Write, edit, classify, and maintain posts for the Hesperine GitHub Pages blog built with Jekyll Chirpy. Use when working on this repository's blog posts, categories, tags, Chirpy prompt blocks, post assets, post cross-links, or site writing conventions.
---

# Hesperine Blog Writer

Use this skill for this repository's Chirpy/Jekyll blog.

## Local Rules

- Posts live in `_posts/` and use `YYYY-MM-DD-slug.md`.
- Drafts can live in `_drafts/`.
- Images and attachments live under `assets/`, preferably `assets/img/posts/YYYY-MM-DD-slug/`.
- `_tabs/` is for fixed navigation pages, not ordinary posts.
- Use lowercase ASCII slugs with hyphens, even for Chinese posts.

## Categories

Use `categories` as a hierarchy with up to two elements. One level is fine; do not use three or more levels. The first element is the parent group shown on the Categories page; the second element is its child category.

Chirpy/Jekyll Archives generates category pages globally by category name. Therefore second-level category names must be unique across the whole site. Do not reuse broad names like `Agent` under multiple parents; use names such as `Agent 论文`, `Agent 笔记`, or `Agent 项目`. Use `tags` for parallel labels.

Top-level categories:

- `学习笔记`: learning notes, concepts, course notes, and notes from reading other people's code or engineering implementations.
- `论文阅读`: posts centered on papers.
- `项目展示`: the author's own projects, demos, experiments, or portfolio writeups.
- `实用技巧`: practical workflows, tools, account setup, environment setup, and operational notes.
- `随笔`: loose thoughts and posts intentionally outside the above buckets.

Examples:

```yaml
categories: [论文阅读, Agent 论文]
categories: [学习笔记, Agent 笔记]
categories: [实用技巧, 数字服务]
tags: [Agent, ReAct, LLM Agent, Tool Use, 论文阅读]
```

## Chirpy Docs

The detailed Chirpy component docs are external, not vendored in this repo. Browse them when syntax details are needed:

- Writing posts, front matter, categories, tags, images, pinned posts, math, Mermaid: https://chirpy.cotes.page/posts/write-a-new-post/
- Prompt blocks, filepath styling, typography, code blocks, visual Markdown examples: https://chirpy.cotes.page/posts/text-and-typography/

Site reminders:

- Current post links use `/posts/:slug/`.
- Use `prompt-tip` for related-post links.
- Use `prompt-warning` for unstable account/payment/platform rules.
- Use absolute site paths for assets, such as `/assets/img/posts/example/image.png`.

Minimal examples:

```markdown
> 如果还没有美区 Apple Account，可以先看前一篇：[注册美区 Apple Account](/posts/register-us-apple-account/)。
{: .prompt-tip }

> 账号地区、订阅价格和支付规则都可能变化，付款前以页面显示为准。
{: .prompt-warning }

`_posts/2026-06-24-example.md`{: .filepath }

![示例图](/assets/img/posts/2026-06-24-example/screenshot.png)
```

## Style

- Write in Chinese by default.
- Prefer personal blog voice over generic instruction-manual voice.
- For paper-reading notes, keep analytical judgments neutral unless the user explicitly states them. Avoid phrasing such as `我认为`, `我觉得`, `我的 reviewer 视角`, `从审稿人角度看`, or `reviewer 式评价` when the judgment is the assistant's reading; prefer `这篇论文...`, `评价这篇论文时...`, or `可以这样概括...`.
- In publishable drafts, omit process filler such as `概读之后，这篇有必要精读`, `这篇值得精读`, or explanations that only report the reading workflow. Start with the substantive claim or evidence instead.
- Avoid AI-sounding section names like `适用场景`, `不适合`, `关键风险` unless genuinely needed.
- Keep roadmap/meta-planning content out of publishable prose by default. Reading routes, why a topic follows another topic, future article plans, and similar author notes may be kept in Jekyll/Liquid comments (`{% comment %} ... {% endcomment %}`) for editing context, but should not appear as visible Blog headings, body text, or generated HTML unless the user explicitly asks.
- Prefer one-level categories when the second level would be a broad field like `Agent`; put fields in `tags` to avoid duplicated category pages.
- For Agent memory topics, use the tag `Agent Memory`; do not use the bare tag `Memory`.
- Classify notes about other people's engineering as `学习笔记`, not `项目展示`.
- Classify only the author's own work as `项目展示`.

## Validation

- Run `git diff --check`.
- If categories changed, run `rg -n "categories:|tags:" _posts`.
- If Ruby/Bundler is available, run `bundle exec jekyll build`; otherwise say `bundle` is unavailable.
- Do not stage or commit unless the user asks.
