# Repository Guidance

This file is the canonical guidance for agents working in this repository. `AGENTS-ZH.md` is a Chinese review mirror and must stay aligned with this file.

## Blog Workflow

- Use `.codex/skills/hesperine-blog-writer/SKILL.md` for work involving posts, drafts, categories, tags, assets, cross-links, or site-wide writing conventions.
- For paper reading or paper-centered blog posts, also use `.agents/skills/hesperine-paper-reading-blog/SKILL.md`. The general skill owns Jekyll and site conventions; the paper skill owns research, explanation, evidence, current-status checks, and engineering interpretation.
- Treat the user's corrections about writing, interpretation, terminology, scope, and article value as important evidence for improving that skill.
- After a correction reveals a reusable rule, review the relevant skill and edit it so later work benefits from the correction.
- Maintain the skill editorially, not as an append-only log. Add, rewrite, merge, narrow, or remove rules as needed. A newer explicit correction may replace an older rule.
- Do not turn one-off preferences or artifact-specific judgments into universal rules. Preserve the underlying principle only when it is likely to recur.
- Keep the skill concise and internally consistent. When adding a rule, check nearby rules for duplication, conflict, or wording that should be retired.

## Writing Quality

- A chronological or lineage-based roadmap is a valid way to organize a series. Do not treat a few low-yield nodes as evidence that the overall route is wrong.
- Match depth and length to the node's information value. Expand work that offers a distinct conceptual insight, engineering pattern, important experiment, or evidence-backed judgment; cover lower-yield but historically useful nodes more concisely.
- A roadmap is a working index, not a requirement that every item receive equal space. Depending on its value, a node may become a full reading note, a short article, background within another post, or a deferred item.
- Prefer analysis grounded in primary sources, code, experiments, and current practice. Clearly separate what an original paper claimed from what remains useful today.

## Repository Hygiene

- Preserve unrelated working-tree changes and do not stage or commit unless the user asks.
- Keep roadmap and author-planning notes out of visible post prose unless the user explicitly wants them published.
- Run the validation required by the repo-local blog-writing skill after edits.
