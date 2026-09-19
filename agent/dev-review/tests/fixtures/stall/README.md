# Stall-detection fixtures

Sanitized, frozen replay data for the stall detector (`detectStallClusters`) that the
dev-review workflow uses to recognise repeated findings, whack-a-mole families and
non-converging loops.

Each `*.json` file is one real review history: per round it keeps the round decision,
the verdicts the reviewer returned for prior issues, and the new findings (id, severity,
location, requirement, evidence, required_fix). Nothing else is copied — no project
metadata, no model names, no timestamps, no git hashes, no human-decision prose, no
plan text.

`labels.json` holds the **human** ground truth (what the detector must find). It is
authored by hand from the human decisions and timelines recorded in the source runs and
is deliberately separate from the machine export.

## Provenance and sanitisation

- Source: local `.ai-dev-review` runs of an external iOS project, exported 2026-09.
- Renaming is done by `../tools/stall-fixture-map.json` and is **rename-only**, never
  redaction: issue ids (`R12-002`), plan section references (`F8`, `§1.1`) and generic
  behaviour text stay verbatim because the detector consumes them (cross references,
  requirement similarity, identifier overlap). Paths and product/class names are
  replaced one-to-one, so the same original token always becomes the same pseudonym and
  the similarity structure is preserved. A residual scan fails the export if any source
  identifier survives.
- The human-readable language of the source plan is Chinese; that is retained on purpose.
  Do not translate fixture text — it changes the bigram similarity the fixtures calibrate.

## Labels

| Class | Meaning | Detector expectation |
| --- | --- | --- |
| `stalled-family` | One root-cause family survived several rounds | cluster the named members (minus `knownL2Misses`) and soft-fire by the `soft.round` deadline; hard fire unconstrained |
| `churn` | Same-subsystem churn in a run that still converged | soft fire allowed; hard fire must not come before `hard.round` (the run's last fix round) |
| `healthy` | No stall signal | neither soft nor hard may fire |

`knownL2Misses` lists family members the text/identifier linker is known not to connect
at export time (paraphrased siblings). They are the acceptance target for the
hot-context candidate layer (L3): the engine should surface them as candidates for the
reviewer to confirm, not silently claim a link.

## Regenerating

```
node agent/dev-review/tools/export-stall-fixtures.mjs --source <path-to-project>/.ai-dev-review
```

The exporter is deterministic (stable ordering, fixed map): re-running it must produce a
byte-identical diff. If it does not, the map or the exporter changed — review that diff
before committing.

**Do not edit fixture files by hand, and do not let an implementing agent "fix" a
fixture or a label to make a test pass.** If a label looks wrong, resolve it as a human
decision; the fixtures are the contract, the detector is what changes.
