import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DISCIPLINE_MARKER,
  INACTIVE_STATUSES,
  isWorkflowActive,
  isOverrideActive,
  desiredDiscipline,
  routeDiscipline,
  shouldBlockTool,
} from "../discipline-router.mjs";

const activeWorkflow = { found: true, status: "running" };
const blockedWorkflow = { found: true, status: "blocked" };
const readyWorkflow = { found: true, status: "ready" };
const passedWorkflow = { found: true, status: "passed" };
const noWorkflow = { found: false };

const V = "abcd1234";

function route(overrides) {
  return routeDiscipline({
    event: "user_turn",
    desired: false,
    reason: "inactive",
    version: V,
    baselineActive: false,
    appendedKey: "none",
    ...overrides,
  });
}

test("isWorkflowActive: running/blocked/ready active, passed/abandoned inactive, missing inactive", () => {
  assert.equal(isWorkflowActive(activeWorkflow), true);
  assert.equal(isWorkflowActive(blockedWorkflow), true);
  assert.equal(isWorkflowActive(readyWorkflow), true);
  assert.equal(isWorkflowActive(passedWorkflow), false);
  assert.equal(isWorkflowActive({ found: true, status: "abandoned" }), false);
  assert.equal(isWorkflowActive({ found: true, status: "" }), false);
  assert.equal(isWorkflowActive(noWorkflow), false);
  assert.equal(isWorkflowActive(null), false);
  assert.ok(INACTIVE_STATUSES.has("passed"));
});

test("isOverrideActive: expiry semantics", () => {
  const now = Date.parse("2026-09-12T10:00:00Z");
  assert.equal(isOverrideActive(null, now), false);
  assert.equal(isOverrideActive({ until: "2026-09-12T10:30:00Z" }, now), true);
  assert.equal(isOverrideActive({ until: "2026-09-12T09:59:00Z" }, now), false);
  assert.equal(isOverrideActive({ until: null, forever: true }, now), true);
  assert.equal(isOverrideActive({ until: null, forever: false }, now), false);
});

test("desiredDiscipline: active / inactive / suspended", () => {
  assert.deepEqual(desiredDiscipline(activeWorkflow, null), { desired: true, reason: "active" });
  assert.deepEqual(desiredDiscipline(passedWorkflow, null), { desired: false, reason: "inactive" });
  const override = { reason: "hotfix", until: new Date(Date.now() + 60_000).toISOString() };
  assert.deepEqual(desiredDiscipline(activeWorkflow, override), { desired: false, reason: "suspended" });
});

test("checkpoint folds state into the baseline and marks the tail in sync", () => {
  const active = routeDiscipline({
    event: "checkpoint", desired: true, reason: "active", version: V,
    baselineActive: false, appendedKey: "none",
  });
  assert.deepEqual(active, { action: "checkpoint", baselineActive: true, appendedKey: `active:${V}` });

  const inactive = routeDiscipline({
    event: "checkpoint", desired: false, reason: "inactive", version: V,
    baselineActive: true, appendedKey: `active:${V}`,
  });
  assert.deepEqual(inactive, { action: "checkpoint", baselineActive: false, appendedKey: "lifted" });
});

test("user_turn: appends once on activation, then stays silent", () => {
  const first = route({ desired: true, reason: "active" });
  assert.equal(first.action, "append");
  assert.equal(first.kind, "active");
  assert.equal(first.appendedKey, `active:${V}`);

  const second = route({ desired: true, reason: "active", appendedKey: first.appendedKey });
  assert.equal(second.action, "none");
});

test("user_turn: activation after a checkpoint does not duplicate the baseline", () => {
  const r = route({ desired: true, reason: "active", baselineActive: true, appendedKey: `active:${V}` });
  assert.equal(r.action, "none");
});

test("user_turn: appends a lifted notice when an active workflow ends", () => {
  const r = route({ desired: false, reason: "inactive", baselineActive: false, appendedKey: `active:${V}` });
  assert.equal(r.action, "append");
  assert.equal(r.kind, "lifted");
});

test("user_turn: no spurious lifted notice when nothing was ever active", () => {
  const r = route({ desired: false, reason: "inactive", baselineActive: false, appendedKey: "none" });
  assert.equal(r.action, "none");
  assert.equal(r.appendedKey, "lifted");
});

test("user_turn: suspension and resume produce their own notices", () => {
  const override = { reason: "hotfix", createdAt: "2026-09-12T10:00:00Z", until: "2026-09-12T10:30:00Z" };
  const suspended = route({ desired: false, reason: "suspended", override, appendedKey: `active:${V}` });
  assert.equal(suspended.action, "append");
  assert.equal(suspended.kind, "suspended");
  assert.equal(suspended.appendedKey, "suspended:2026-09-12T10:00:00Z");

  const resumed = route({ desired: true, reason: "active", override, appendedKey: suspended.appendedKey });
  assert.equal(resumed.action, "append");
  assert.equal(resumed.kind, "active");
});

test("tool gate: blocks edit/write only while the discipline applies", () => {
  assert.equal(shouldBlockTool("edit", { desired: true }), true);
  assert.equal(shouldBlockTool("write", { desired: true }), true);
  assert.equal(shouldBlockTool("bash", { desired: true }), false);
  assert.equal(shouldBlockTool("read", { desired: true }), false);
  assert.equal(shouldBlockTool("edit", { desired: false }), false);
});

test("marker is a non-empty system-prompt-safe comment", () => {
  assert.ok(DISCIPLINE_MARKER.startsWith("<!--") && DISCIPLINE_MARKER.endsWith("-->"));
});
