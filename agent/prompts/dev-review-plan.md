---
description: Turn the current requirements discussion into a reviewable, frozen development plan
argument-hint: "<plan-file>"
---

You are facilitating the requirements-to-development handoff for the current conversation.

Do **not** implement the feature yet and do not start subagents.

Use the agreed parts of the current conversation and the repository as context. Create or update the draft plan at `$1`. The document must be concrete enough for independent implementation and review, containing at least:

1. Problem / user goal and in-scope behavior.
2. Explicit non-goals and compatibility constraints.
3. User-visible behavior and acceptance criteria that can be independently checked.
4. Technical approach, important files/interfaces, data or API changes, and error/empty-state behavior.
5. Test and verification plan.
6. Assumptions, unresolved questions, and decisions that require the human to choose.

Mark the document as **Draft**. After writing it, present a concise summary plus every unresolved question. Stop and ask the user to review or amend it. Do not claim it is frozen until the user explicitly confirms it.

## Multi-batch master plans

If the plan is a master document covering several batches (it carries a current-batch marker such as `当前执行批次` and a batch table where some rows are already done):

- The engine **never splits the file**. `/dev-review start` freezes the whole document and the roles implement the batch named by the marker; each batch becomes a new workflow instance because editing the plan changes its content hash.
- Before suggesting `start`, read the marker and confirm with the user which way to go:
  1. **直接开始** — start now with the batch exactly as written (the dev agent works from the frozen copy; no sub-plan file is produced);
  2. **先聊子 plan** — first pin down this batch's scope, approach, acceptance criteria and any amendments in conversation, update the plan file, then start.
- Present both options and proceed with whichever the user picks. Do not force a sub-plan when the user wants to start directly.

When the user later explicitly confirms the draft, update its status to **Confirmed / Frozen**, preserve the accepted details in the plan file, and tell the user to start the loop with one command:

```text
/dev-review start $1 --developer-model '<developer-provider/model>' --reviewer-model '<review-provider/model>' --test '<required test command>' --max-rounds 10
```

If the current worktree intentionally contains the feature work that should be reviewed, include `--allow-dirty` in that suggested command.

Do **not** invent a `--workflow <label>` / `dev_review_start` `label` just to shorten the artifact folder: the folder is named after the plan file (`<plan-stem>--<plan-hash>`), which already carries version + batch + topic. A label **replaces** that name (it is not a prefix), so a bare batch label hides the version. Pass a label only for a second independent instance of the same plan file, and include the version (e.g. `v1.2-b2c-rerun`).

## Developer skills (optional)

If this batch needs specialized guidance (for example a SwiftUI or accessibility skill), declare the exact skill paths in a plan section titled `## 注入技能`:

```markdown
## 注入技能

- ~/.pi/agent/skills/xcode/swiftui-specialist
```

Subagents run with skill discovery disabled (`--no-skills`), so the plan section is the auditable place to record the need. When starting the workflow, the main agent reads this section and passes the paths as `dev_skills: [...]` to `dev_review_start` (or one `--dev-skill <path>` per entry on the CLI). Skills go to the developer process only; the reviewer never receives them. Every path is validated at start (a directory must contain `SKILL.md`), and start fails fast if one is missing.
