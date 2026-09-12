import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { planChangedSinceFrozen } from "../workflow.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

async function fixture(planText = "# plan v1\n") {
  const root = await mkdtemp(join(tmpdir(), "devrev-planhash-"));
  await mkdir(join(root, "docs", "prd"), { recursive: true });
  await writeFile(join(root, "docs", "prd", "plan.md"), planText, "utf8");
  return root;
}

test("planChangedSinceFrozen: unchanged plan returns null", async () => {
  const root = await fixture("# plan v1\n");
  const state = { plan: { sourcePath: "docs/prd/plan.md", sha256: sha256("# plan v1\n") } };
  assert.equal(await planChangedSinceFrozen(state, root), null);
  await rm(root, { recursive: true, force: true });
});

test("planChangedSinceFrozen: amended plan reports both hash prefixes", async () => {
  const root = await fixture("# plan v2 (batch 2)\n");
  const state = { plan: { sourcePath: "docs/prd/plan.md", sha256: sha256("# plan v1\n") } };
  const changed = await planChangedSinceFrozen(state, root);
  assert.ok(changed, "detects the change");
  assert.equal(changed.frozen, sha256("# plan v1\n").slice(0, 8));
  assert.equal(changed.current, sha256("# plan v2 (batch 2)\n").slice(0, 8));
  assert.equal(changed.sourcePath, "docs/prd/plan.md");
  await rm(root, { recursive: true, force: true });
});

test("planChangedSinceFrozen: missing file or missing plan metadata is a no-op", async () => {
  const root = await fixture();
  assert.equal(await planChangedSinceFrozen({ plan: { sourcePath: "docs/prd/nope.md", sha256: "x" } }, root), null);
  assert.equal(await planChangedSinceFrozen({}, root), null);
  assert.equal(await planChangedSinceFrozen(null, root), null);
  await rm(root, { recursive: true, force: true });
});
