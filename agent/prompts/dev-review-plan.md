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

When the user later explicitly confirms the draft, update its status to **Confirmed / Frozen**, preserve the accepted details in the plan file, and tell the user to start the loop with one command:

```text
/dev-review start $1 --developer-model '<developer-provider/model>' --reviewer-model '<review-provider/model>' --test '<required test command>' --max-rounds 10
```

If the current worktree intentionally contains the feature work that should be reviewed, include `--allow-dirty` in that suggested command.
