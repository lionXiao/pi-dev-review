import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCommand, timelineFilePath, timelineLine, classifyAgentFailure, localNow, localTimezoneLabel, detectMasterPlan } from "../workflow.mjs";

test("timelineLine: one chronological line with round, event, status, summary, artifact", () => {
  const line = timelineLine({
    round: 2,
    event: "review",
    status: "spec_blocked",
    summary: "卡在人工验收",
    artifact: ".ai-dev-review/x/handoffs/reviewer-r02.md",
  });
  assert.match(
    line,
    /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} · r2 · review · \*\*spec_blocked\*\* — 卡在人工验收 — `\.ai-dev-review\/x\/handoffs\/reviewer-r02\.md`$/,
  );

  const roundless = timelineLine({ event: "workflow", status: "passed" });
  assert.match(roundless, /· workflow · workflow · \*\*passed\*\*$/);
});

test("localNow: matches the machine's local clock, not UTC", () => {
  const date = new Date(2026, 8, 12, 13, 31, 7); // local 2026-09-12 13:31:07
  assert.equal(localNow(date), "2026-09-12 13:31:07");
  assert.match(localTimezoneLabel(date), /^.* \(UTC[+-]\d{2}:\d{2}\)$/);
});

test("classifyAgentFailure: names quota/auth/network/timeout, else null", () => {
  assert.match(classifyAgentFailure("Error: 429 Too Many Requests"), /quota/);
  assert.match(classifyAgentFailure("insufficient_quota: you exceeded your balance"), /quota/);
  assert.match(classifyAgentFailure("HTTP 401 Unauthorized: invalid api key"), /auth/);
  assert.match(classifyAgentFailure("fetch failed: ECONNRESET"), /network/);
  assert.match(classifyAgentFailure("request timed out after 60s"), /timeout/);
  assert.equal(classifyAgentFailure("reviewer.decision must be one of pass|fix_required"), null);
});

test("detectMasterPlan: finds the current-batch marker, else falls back to heuristics", () => {
  const master = "# 总纲\n\n**当前执行批次**：`批 3 — RunwayModel 拆分`（批 2 已提交）\n\n|批|范围|\n|0|基线|\n|1|输入|\n|2|Store|\n|3|Model|";
  assert.deepEqual(detectMasterPlan(master), { currentBatch: "批 3 — RunwayModel 拆分", explicitMarker: true });

  const english = "# Master plan\n\nCurrent batch: `batch 2 - store split`\n";
  assert.equal(detectMasterPlan(english).currentBatch, "batch 2 - store split");

  // No marker, but clearly multi-batch.
  const unmarked = "# 总纲\n批 0 基线\n批 1 输入\n批 2 Store\n批 3 Model\n";
  assert.deepEqual(detectMasterPlan(unmarked), { currentBatch: null, explicitMarker: false });

  assert.equal(detectMasterPlan("# 单批次计划\n\n只做一件事。"), null);
  assert.equal(detectMasterPlan(""), null);
});

test("timelineFilePath: reports/timeline.md under the workflow artifacts", () => {
  assert.equal(timelineFilePath({ reports: "/tmp/x/reports" }), join("/tmp/x/reports", "timeline.md"));
});

async function blockedFixture() {
  const tempRoot = await mkdtemp(join(tmpdir(), "dev-review-timeline-"));
  // git reports the realpath (/private/var/... on macOS), so the fixture state
  // must use the same root or relativeTo() climbs out of the project.
  const root = realpathSync(tempRoot);
  execFileSync("git", ["init", "-q"], { cwd: root });
  const artifact = join(root, ".ai-dev-review", "demo--abc12345");
  await mkdir(join(artifact, "reports"), { recursive: true });
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
      projectRoot: root,
      workflow: { key: "demo--abc12345" },
      status: "blocked",
      phase: "human_decision",
      currentRound: 2,
      updatedAt: new Date().toISOString(),
      plan: {
        sourcePath: "PLAN.md",
        snapshotPath: ".ai-dev-review/demo--abc12345/inputs/plan-v1.md",
        sha256: "a".repeat(64),
      },
      base: { head: "b".repeat(40) },
      config: { maxReviewRounds: 10, developerModel: "x/y", reviewerModel: "z/w" },
      openIssues: [],
      blocked: {
        reason: "reviewer-spec-blocked",
        escalationPath: ".ai-dev-review/demo--abc12345/escalation/01-reviewer-spec-blocked.md",
        details: {
          summary: "卡在人工验收",
          questions: [{ question: "谁验收？", options: ["用户", "agent"] }],
        },
      },
    }),
    "utf8",
  );
  return root;
}

test("status: shows blocked details and the unified timeline path", async () => {
  const root = await blockedFixture();
  try {
    const result = await runCommand({ args: "status", cwd: root });
    assert.equal(result.ok, true);
    assert.ok(result.message.includes("Status: blocked (human_decision)"));
    assert.ok(result.message.includes("Blocked (reviewer-spec-blocked)"));
    assert.ok(result.message.includes("Q1: 谁验收？"));
    assert.ok(result.message.includes("1) 用户"));
    assert.ok(result.message.includes("Timeline: .ai-dev-review/demo--abc12345/reports/timeline.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
