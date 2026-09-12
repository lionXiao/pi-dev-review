import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolvePlanSource } from "../workflow.mjs";

test("resolvePlanSource: cwd wins, repo-root fallback carries a note, missing path explains both tries", async () => {
  const root = await mkdtemp(join(tmpdir(), "dev-review-plan-path-"));
  const nested = join(root, "docs", "prd");
  const plan = join(nested, "plan.md");
  await mkdir(nested, { recursive: true });
  await writeFile(plan, "# plan\n", "utf8");

  // Normal case: path relative to the current directory.
  assert.deepEqual(resolvePlanSource(root, "docs/prd/plan.md", root), { planSource: plan, note: null });
  assert.deepEqual(resolvePlanSource(nested, "plan.md", root), { planSource: plan, note: null });

  // The slip this guard exists for: repo-root-relative path from a deep cwd.
  const fallback = resolvePlanSource(nested, "docs/prd/plan.md", root);
  assert.equal(fallback.planSource, plan);
  assert.match(fallback.note, /repository root/);

  // Missing file: the error names the cwd resolution and the root attempt.
  assert.throws(
    () => resolvePlanSource(nested, "docs/prd/missing.md", root),
    /Plan file does not exist: .*docs\/prd\/docs\/prd\/missing\.md.*also tried .*docs\/prd\/missing\.md/,
  );

  await rm(root, { recursive: true, force: true });
});
