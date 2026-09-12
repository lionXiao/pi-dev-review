import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractJsonObject, runCommand } from "../workflow.mjs";

// The exact shape that stopped the b3 workflow: a complete-looking developer report
// whose tests[1].command uses Python-style '+' concatenation. The outer object and
// that test entry are invalid JSON; the nested resolved_issues entries are valid.
const MALFORMED_REPORT = `Both review issues are fixed and verified. Final response:

{
  "status": "done",
  "summary": "docs only",
  "resolved_issues": [
    {"id": "R3-001", "status": "fixed", "summary": "count 48 -> 63"},
    {"id": "R3-002", "status": "fixed", "summary": "coverage table"}
  ],
  "tests": [
    {"command": "git diff --check" + "git status --short dieMoneyTests/", "status": "passed"}
  ],
  "blockers": []
}`;

test("extractJsonObject: prose + one valid object still parses", () => {
  assert.deepEqual(
    extractJsonObject(`Here it is:\n\n{"status":"done","summary":"ok"}`),
    { status: "done", summary: "ok" },
  );
});

test("extractJsonObject: malformed outer object does not degrade to a nested fragment", () => {
  // Before the fix this returned resolved_issues[0] and the workflow reported the
  // misleading schema error "developer.status must be one of: done, blocked".
  assert.throws(() => extractJsonObject(MALFORMED_REPORT), /malformed JSON/);
  try {
    extractJsonObject(MALFORMED_REPORT);
    assert.fail("expected malformed JSON to throw");
  } catch (error) {
    assert.match(error.message, /position|line/);
    assert.doesNotMatch(error.message, /developer\.status/);
  }
});

test("extractJsonObject: truncated outer object is reported as truncation, not a fragment", () => {
  const truncated = `{"status":"done","summary":"x","nested":{"a":1}`;
  assert.throws(() => extractJsonObject(truncated), /unterminated JSON object/);
});

async function readyFixture() {
  const tempRoot = await mkdtemp(join(tmpdir(), "dev-review-protocol-"));
  // git reports the realpath (/private/var/... on macOS), so the fixture state
  // must use the same root or relativeTo() climbs out of the project.
  const root = realpathSync(tempRoot);
  execFileSync("git", ["init", "-q"], { cwd: root });
  const artifact = join(root, ".ai-dev-review", "demo--abc12345");
  await mkdir(join(artifact, "inputs"), { recursive: true });
  await writeFile(join(artifact, "inputs", "plan-v1.md"), "# plan\n", "utf8");
  await writeFile(
    join(root, ".ai-dev-review", "active-workflow.json"),
    JSON.stringify({
      schemaVersion: 1,
      workflowKey: "demo--abc12345",
      artifactDir: ".ai-dev-review/demo--abc12345",
    }),
    "utf8",
  );
  await writeFile(
    join(artifact, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      workflowId: "00000000-0000-4000-8000-000000000000",
      projectRoot: root,
      artifactDir: ".ai-dev-review/demo--abc12345",
      workflow: { key: "demo--abc12345" },
      repository: { origin: null, baseHead: "b".repeat(40) },
      migrations: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "ready",
      phase: "idle",
      currentRound: 0,
      base: { head: "b".repeat(40), initializedDirty: false },
      plan: {
        sourcePath: "PLAN.md",
        snapshotPath: ".ai-dev-review/demo--abc12345/inputs/plan-v1.md",
        sha256: "a".repeat(64),
        version: 1,
      },
      config: {
        developerModel: "x/y",
        reviewerModel: "z/w",
        developerThinking: "max",
        reviewerThinking: "high",
        maxReviewRounds: 10,
        developerResetAfterRounds: 4,
        testCommands: [],
      },
      developerSession: { generation: 1, sessionId: "developer-g1" },
      openIssues: [],
      history: [],
      pendingHumanDecisionPath: null,
      blocked: null,
    }),
    "utf8",
  );
  return root;
}

test("run: malformed developer JSON blocks with the syntax error plus a raw-text dump", async () => {
  const root = await readyFixture();
  try {
    const result = await runCommand({
      args: "run",
      cwd: root,
      notify: () => {},
      invokeAgent: async () => ({ finalText: MALFORMED_REPORT, usage: null }),
    });
    assert.equal(result.state.status, "blocked");
    assert.equal(result.state.blocked.reason, "developer-protocol-or-execution-error");
    assert.match(result.state.blocked.details.summary, /malformed JSON/);
    assert.doesNotMatch(result.state.blocked.details.summary, /developer\.status must be/);
    assert.equal(result.state.blocked.details.rawReport, undefined);

    const rawPath = join(root, result.state.blocked.details.rawTextPath);
    assert.equal(await readFile(rawPath, "utf8"), MALFORMED_REPORT);
    const escalation = await readFile(join(root, result.state.blocked.escalationPath), "utf8");
    assert.match(escalation, /Raw agent output \(verbatim\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run: a parseable report with a schema error is recovered into the escalation", async () => {
  const wrongStatus = JSON.stringify(
    { status: "fixed", summary: "r4 docs fixes already applied on disk", blockers: [] },
    null,
    2,
  );
  const root = await readyFixture();
  try {
    const result = await runCommand({
      args: "run",
      cwd: root,
      notify: () => {},
      invokeAgent: async () => ({ finalText: wrongStatus, usage: null }),
    });
    assert.equal(result.state.status, "blocked");
    assert.match(result.state.blocked.details.summary, /developer\.status must be one of/);
    assert.match(result.state.blocked.details.summary, /r4 docs fixes already applied on disk/);
    assert.equal(JSON.parse(result.state.blocked.details.rawReport).status, "fixed");

    const escalation = await readFile(join(root, result.state.blocked.escalationPath), "utf8");
    assert.match(escalation, /Developer report \(recovered\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
