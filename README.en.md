# pi-dev-review

[中文](README.md) | **English**

[![CI](https://github.com/lionXiao/pi-dev-review/actions/workflows/ci.yml/badge.svg)](https://github.com/lionXiao/pi-dev-review/actions/workflows/ci.yml)

A human-signed-off, two-agent **development → review workflow** for [Pi](https://github.com/earendil-works/pi) (the `@earendil-works/pi-coding-agent` CLI): freeze a plan → a developer agent implements it → an independent reviewer agent verifies it → pass or blocked, repeat. The main agent is a secretary, not a construction crew; the decision is always human.

> **verification-first** — local-first, auditable, human-decided. Everyone else sells "letting go"; this sells the preconditions for daring to let go.

> The Chinese [README.md](README.md) is the canonical document (every option, artifact and edge case). This page is the English entry point; where the two disagree, the Chinese one wins.

## What it actually does

1. **Freeze a plan.** Write it (or draft one with the `/dev-review-plan` prompt template) and mark it `Confirmed` / `Frozen`. The plan file is snapshotted, hash-named and becomes the developer's single source of truth. Changing the plan means a new instance — it cannot drift under the work.
2. **The developer agent implements it** in your real repository, runs the required tests, and returns a structured report.
3. **A separate reviewer agent verifies it independently.** It runs with read-only tools, never sees the developer's private session, and re-checks every open issue against the actual code and diff rather than trusting the handoff.
4. **Fix-required loops, human gates stop it.** `pass` closes the instance; `blocked` asks *you* — with the question, the context and concrete options — and waits.

## Why it is different

| Neighbor | What it is | What this does differently |
| --- | --- | --- |
| [github/spec-kit](https://github.com/github/spec-kit) | spec-driven development toolkit | no artifact format of its own; just the frozen-plan → implement → review loop |
| [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) | multi-role agile methodology (docs) | an executable engine + state machine + human decision protocol, not a methodology |
| Ralph-style loops | let the agent run until it passes | role separation, frozen-plan attribution, human decision gates, audit trail |
| Pi's built-in subagent example | worker → reviewer → worker | round budget, protocol validation, decision record, always-on main-agent discipline |

Good fit: local repositories, individuals or small teams, changes where reproducibility and auditability matter more than raw speed, and where you are willing to pay with a human acceptance step.

Not a fit: handing acceptance itself to the model ("just let it run and ship whatever it says is done").

Overnight batch runs (`agent/dev-review/unattended.md`) are the exception that proves the rule: they require a **one-time human pre-authorization**, blocked runs self-triage and skip what they cannot verify, results land on an `unattended/<date>` branch with an explicit leftover list, and a morning summary is reviewed by you. Letting go is authorized, revertible and auditable — that is not the same as the agent deciding acceptance.

## Install

Requires Pi installed and working, plus Node (the engine is a plain `.mjs` script).

```bash
git clone https://github.com/lionXiao/pi-dev-review.git
cd pi-dev-review
bash install.sh        # installs into ~/.pi/agent/ (extension + engine + discipline + prompts + tests)
cp ~/.pi/agent/dev-review/local.json.example ~/.pi/agent/dev-review/local.json
# edit local.json: developerModel / reviewerModel (must differ) + the two thinking levels
```

Verify with `/dev-review help` inside a Pi session. **Fully restart Pi after installing** — `/reload` refreshes the extension entry point only, while the imported `.mjs` modules stay cached from process start.

## Use

```text
/dev-review-plan docs/prd/checkout-v2-plan.md     # draft a plan (optional; your own plan is fine)
# ...discuss, edit, confirm, mark it Confirmed / Frozen...
/dev-review start docs/prd/checkout-v2-plan.md \
  --test "npm test && bash scripts/lint.sh" \
  --max-rounds 10
```

`start` returns immediately: the engine keeps running in the background with a live progress widget, and a wake-up message tells the main agent *why* it stopped (reason code, summary, decision question and options).

When the run is blocked you have three equivalent ways to decide:

- **Tell the main agent in plain language** — it calls `dev_review_resolve`, then `dev_review_run`.
- **Inline command**: `/dev-review resolve --choose "<option>" --note "<details>"` then `/dev-review run`.
- **Write a decision file** and pass it to `/dev-review resolve <decision.md>`.

Passing decisions, unlock-after-kill (`/dev-review unlock --note "..."`), switching between instances (`list` / `use`) and re-adopting a copied `.ai-dev-review/` directory (`adopt`) are covered in the Chinese README §3–4.

## What you get on disk (auditability)

Everything lives in `.ai-dev-review/<plan-stem>--<plan-hash>/`, project-local and gitignored:

| Path | Contents |
| --- | --- |
| `inputs/plan-v1.md` | the frozen plan snapshot the run was reviewed against |
| `handoffs/` | every round's developer and reviewer handoff, JSON + Markdown |
| `reports/timeline.md` | the full process log: milestone rows *and* each phase's assistant text, thinking markers, tool calls and tool results — readable as one dev+review transcript |
| `reports/final-report.md`, `reports/usage.json` | outcome and per-role token/latency accounting |
| `reports/findings.jsonl` | one record per review round, feeding stall detection (below) |
| `private/*-sessions/*.jsonl` | verbatim Pi sessions for both roles, replays with `pi --session-dir ... -r` |
| `discipline-audit.jsonl` | every suspension of the main-agent discipline, with reason |

While an instance is active the engine also holds the **main agent** to a discipline: it may not edit or write files (hard gate), and it must translate your decisions into tool calls instead of doing the work itself. That discipline is injected automatically, and it lifts itself the moment the instance passes.

## Stall detection

Reviewers repeatedly find "the next reachable path" while the developer fixes only the path that was named — the same root-cause family surviving round after round. Stall detection turns that into a mechanical signal (counting plus string comparison: same file, explicit `ref`, requirement bigram similarity, identifier overlap, parent still open — never an LLM verdict, and it never claims "same root cause").

- **Soft hit**: the next developer task packet gets a family-level acceptance criterion (state the invariant, enumerate the boundaries, give a verdict and evidence for each), and the reviewer gets an unlinked-candidate section asking it to confirm or separate, declaring `repeat_of` when confirmed. A round that does not hit leaves the task packet byte-identical.
- **Hard hit**: the instance blocks with reason `stalled-issue-family`, carrying a machine-generated family table and three structured options (authorize one scoped systemic fix / register as a known limitation / amend the plan).
- Thresholds live in `stallGate` (`defaults.json`, overridable per project), are calibrated against 17 frozen labelled runs and are frozen per instance. Old instances without `findings.jsonl` behave as empty history.

Details in [README.md §3.6](README.md) and `docs/known-issues.md`.

## Limits

- **Local-only by design**: the workflow itself opens no network connection, has no account and no telemetry. Model calls go through Pi's own provider configuration.
- **Human cost is real**: every blocked run waits for you. That is the feature, not a defect.
- **One run at a time** per worktree; parallel work needs separate `git worktree` checkouts.
- **Not unattended by default**; see the batch protocol above for the authorized version.
- Changing `workflow.mjs`, the extension or `discipline.md` requires a full Pi restart (the CLI path always uses the file on disk).

## Tests

```bash
node --test agent/dev-review/tests/*.test.mjs    # 76 tests, incl. fixture replay for stall detection
```

CI runs the same suite plus syntax checks and `bash -n install.sh`.

## License

MIT — see [LICENSE](LICENSE).
