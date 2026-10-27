# Use the UI Design Master

This package gives Claude Code, Codex or a human designer a shared standard for product thinking, visual craft and meaningful invention.

## Contents

- [UI-DESIGN-MASTER.md](UI-DESIGN-MASTER.md): reusable design principles, novelty method, audit rubric, staged workflow, implementation handoff, reusable across future projects.
- This guide: adoption and task prompts.

## Adopt it

1. Copy both files into the project or a documented design-guidance folder.
2. Keep the project's existing `CLAUDE.md`, `AGENTS.md`, handoff, product decisions and platform rules. This is a companion, not their replacement.
3. For occasional design work, explicitly ask the active tool to read the masterfile before that task. This avoids loading a long design document for unrelated work.
4. For regular design work, merge a scoped pointer into the existing instructions: **“For UI/product design, critique or implementation of approved designs, read UI-DESIGN-MASTER.md in full and apply it within the current task's scope.”** Use the correct relative path. Explicit reading works across tools; do not assume an import syntax is supported by every tool.
5. Supply each project's current brief, approved design links, brand materials, typography/asset handoff and relevant implementation separately. The core master contains no project-specific identity or feature requirements; keep those in that project's own documents.

No product repository, global tool setting or Figma file is changed by receiving this package. The document's recommendations become part of the work when you adopt them for the task.

## Prompts you can use

### Develop a design direction

> Read our project instructions and UI-DESIGN-MASTER.md in full. Read the current project's brief and brand guidance separately. Inspect the current product. Develop three coherent directions for [journey], using the same realistic content and constraints. Recommend one and show its main task, a demanding state and a distinctive moment. Explain its user benefit, novelty, accessibility, implementation implications and what still needs validation. Preserve settled decisions.

### Audit an existing design

> Read our project instructions and UI-DESIGN-MASTER.md in full. Audit [frames or implemented journey] at product, journey, screen and interaction level. Inspect the relevant states. Distinguish observed defects from hypotheses and opportunities. Prioritise the three most valuable changes, give specific evidence and acceptance conditions, and identify what you could not inspect. This task authorises inspection and recommendations; do not change product behaviour yet.

### Implement an approved journey

> Read our project instructions, current handoff and UI-DESIGN-MASTER.md in full. Implement the approved [bounded journey] using [Figma frame links], [behaviour specification] and [asset folder]. Inspect existing code and current product contracts first. Reuse established components, preserve settled decisions and resolve material design/implementation discrepancies within project authority. Verify the running result and relevant states. Report what you observed, remaining issues and the next action in our existing handoff.

Replace bracketed placeholders before use. Give the implementation agent the relevant Figma links or reference exports **as well as** behaviour and asset guidance. A design masterfile supplies judgement; it cannot supply missing product facts.

## Keep it useful

Use one bounded journey per task. Ask for a concrete recommendation, review the result and preserve the decision for the next session. Update the masterfile when its universal principles evolve. Keep brand decisions and ordinary task progress in the project's own guidance and handoff.
