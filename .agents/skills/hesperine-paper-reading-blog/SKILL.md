---
name: hesperine-paper-reading-blog
description: Read papers and turn them into rigorous, self-contained Chinese posts for the Hesperine blog. Use for paper reading, paper explanations intended for publication, Agent-series paper posts, literature lineage comparisons, implementation-oriented paper analysis, and updates to existing paper-reading posts. Use together with the repo's hesperine-blog-writer skill for Jekyll and site conventions.
---

# Hesperine Paper Reading Blog

Use `.codex/skills/hesperine-blog-writer/SKILL.md` alongside this skill for filenames, front matter, categories, links, Chirpy syntax, and validation.

## Reading Workflow

1. Verify the exact paper, version, authors, date, official PDF, project page, and code repository from primary sources. Do not infer identity from a nearby paper or product.
2. State the concrete problem and the missing capability that motivated the work. Supply the minimum historical context needed to understand why the problem mattered then.
3. Reconstruct the method as an executable pipeline: inputs, state, model calls, tools or modules, control flow, outputs, and feedback. Use a worked example when the paper's shorthand hides the mechanism.
4. Read the evidence, not only the method section. Explain datasets or benchmarks on first use, identify baselines and metrics, report the experiments that support the central claim, and note what the experiments do not establish.
5. Inspect official code or system artifacts when implementation is material. Distinguish the paper's conceptual diagram from the actual data flow, state representation, prompts, hard rules, and external runtime.
6. For older work, check current primary sources to distinguish what remains in use, what evolved into a newer interface or architecture, and what has largely been retired.
7. Translate durable ideas into engineering practice: minimal implementation pattern, validation strategy, cost controls, failure handling, permission boundaries, and observability where relevant.

## Completeness And Length

- Make every post complete enough for a reader who has not read the paper. A short article may contain fewer independent conclusions, but it must not omit premises, key terminology, the mechanism, a concrete example, decisive evidence, limitations, or present-day context needed for understanding.
- Match emphasis to information value rather than giving every section equal length. Compress repetition, long related-work inventories, secondary result tables, and historical detail that does not change the conclusion.
- Expand distinct conceptual insights, reusable engineering patterns, surprising experimental results, implementation details that overturn the conceptual picture, and limitations that materially change how the work should be interpreted.
- Do not pad a low-yield paper into a long post. Concision means removing redundancy, not removing explanation.

## Analysis And Writing

- Keep analytical judgments neutral unless the user explicitly supplies a personal judgment. Do not attribute the assistant's assessment to the user.
- Keep each claim beside the premise, result, code path, or source that supports it. Separate paper claims, observed implementation facts, deductions, and current-practice comparisons.
- Define jargon and benchmarks at first use. Replace paper-dependent shorthand with examples, tables, pseudocode, or diagrams when that makes the mechanism easier to reconstruct.
- Preserve a chronological or lineage-based series when it helps locate the work. Do not reject a sound route because some nodes have lower independent value; vary treatment and emphasis instead.
- Keep roadmap decisions, reading order, and future article plans out of visible prose unless the user explicitly asks to publish them.
- Start publishable prose with the substantive question or claim, not with notes about the reading process.

## Minimum Review Pass

Before publishing, confirm that the post answers:

1. What exact problem did this work address?
2. How does the mechanism run step by step?
3. What example lets a new reader reconstruct it?
4. Which evidence supports the main claim, and what remains unproven?
5. What implementation lesson survives today?
6. What changed between the original work and current practice?
