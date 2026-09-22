import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
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
      config: { maxReviewRounds: 10, developerModel: "x/y", reviewerModel: "z/w", developerThinking: "max", reviewerThinking: "high" },
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

// Fake pi child that streams a thinking block, an assistant answer, a tool call
// and a big tool result before returning the protocol JSON — the event stream a
// real run produces, minus the provider.
const TRANSCRIPT_FAKE_PI = `const args = process.argv.slice(2);
const model = args[args.indexOf("--model") + 1] || "";
const developer = model.includes("dev");
const report = developer
  ? { status: "done", summary: "implemented", changed_files: [], requirements_covered: [], resolved_issues: [], tests: [], assumptions: [], risks: [], handoff_to_reviewer: "check", blockers: [] }
  : { decision: "pass", summary: "looks good", previous_issue_verdicts: [], new_findings: [], spec_questions: [], handoff_to_developer: "none" };
const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 5, totalTokens: 35, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
write({ type: "message_start", message: { role: "assistant", content: [], timestamp: Date.now() } });
write({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "t" } });
write({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [
  { type: "thinking", thinking: "THINKING-MARKER" },
  { type: "text", text: "TEXT-MARKER-" + (developer ? "dev" : "review") },
  { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/big-file.txt" } }
], usage } });
write({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "src/big-file.txt" } });
write({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", isError: false, result: { content: [{ type: "text", text: "RESULT-HEAD" + "x".repeat(9000) + "RESULT-TAIL" }] } });
write({ type: "message_start", message: { role: "assistant", content: [], timestamp: Date.now() } });
write({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(report) }], usage } });
process.exit(0);
`;

async function transcriptFixture() {
  const tempRoot = await mkdtemp(join(tmpdir(), "dev-review-transcript-"));
  const root = realpathSync(tempRoot);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  await writeFile(join(root, "PLAN.md"), "# Plan\n", "utf8");
  const script = join(root, "fake-pi.mjs");
  await writeFile(script, TRANSCRIPT_FAKE_PI, "utf8");
  return { root, script };
}

async function runTranscriptFixture({ transcript = null } = {}) {
  const { root, script } = await transcriptFixture();
  const previous = {
    dev: process.env.DEV_REVIEW_DEVELOPER_MODEL,
    rev: process.env.DEV_REVIEW_REVIEWER_MODEL,
    transcript: process.env.DEV_REVIEW_TRANSCRIPT,
  };
  process.env.DEV_REVIEW_DEVELOPER_MODEL = "fake/dev";
  process.env.DEV_REVIEW_REVIEWER_MODEL = "fake/rev";
  if (transcript) process.env.DEV_REVIEW_TRANSCRIPT = transcript;
  else delete process.env.DEV_REVIEW_TRANSCRIPT;
  try {
    const result = await runCommand({
      args: "start PLAN.md --allow-dirty",
      cwd: root,
      piInvocation: { command: process.execPath, args: [script] },
      notify: () => {},
      onReport: async () => {},
    });
    return { result, timeline: await readFile(join(result.paths.reports, "timeline.md"), "utf8") };
  } finally {
    for (const [key, value] of [
      ["DEV_REVIEW_DEVELOPER_MODEL", previous.dev],
      ["DEV_REVIEW_REVIEWER_MODEL", previous.rev],
      ["DEV_REVIEW_TRANSCRIPT", previous.transcript],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

test("timeline: development and review process is appended to the milestones in order", async () => {
  const { result, timeline } = await runTranscriptFixture();
  assert.equal(result.state.status, "passed");

  // One phase header per role+round, with the frozen model.
  assert.match(timeline, /^## dev r1 · fake\/dev · \d{4}-\d{2}-\d{2} /m);
  assert.match(timeline, /^## review r1 · fake\/rev · \d{4}-\d{2}-\d{2} /m);

  // Assistant text is verbatim; thinking is a one-line marker by default.
  assert.match(timeline, /^### .* · assistant$/m);
  assert.ok(timeline.includes("TEXT-MARKER-dev"), "developer answer");
  assert.ok(timeline.includes("TEXT-MARKER-review"), "reviewer answer");
  assert.ok(timeline.includes("**🧠 thinking** · 5 tok · full text in private/ session transcript"), "thinking marker");
  assert.ok(!timeline.includes("THINKING-MARKER"), "thinking text is not inlined by default");

  // Tool intent and result, with the oversized output capped but head+tail kept.
  assert.ok(timeline.includes('- `read` · {"path":"src/big-file.txt"}'), "tool call line");
  assert.ok(timeline.includes("↳ ✅ `read` · 1 line · 9022 chars"), "tool result header");
  assert.ok(timeline.includes("RESULT-HEAD") && timeline.includes("RESULT-TAIL"), "result head+tail");
  assert.ok(timeline.includes("chars omitted"), "truncation marker");
  assert.ok(!timeline.includes("x".repeat(6000)), "middle of the capped result is dropped");

  // Strict chronological order: dev phase → dev tool result → review phase.
  const positions = [
    timeline.indexOf("## dev r1"),
    timeline.indexOf("TEXT-MARKER-dev"),
    timeline.indexOf("↳ ✅"),
    timeline.indexOf("## review r1"),
    timeline.indexOf("TEXT-MARKER-review"),
  ];
  assert.ok(positions.every((value) => value >= 0), `missing section: ${positions}`);
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));

  // Milestone lines still mark the same file.
  assert.match(timeline, /· r1 · development · \*\*done\*\*/);
  assert.match(timeline, /· r1 · review · \*\*pass\*\*/);
});

test("timeline: DEV_REVIEW_TRANSCRIPT=full inlines the thinking text", async () => {
  const { timeline } = await runTranscriptFixture({ transcript: "full" });
  assert.ok(timeline.includes("**🧠 thinking**") && timeline.includes("> THINKING-MARKER"), "thinking block");
});

test("timeline: DEV_REVIEW_TRANSCRIPT=0 keeps milestones only", async () => {
  const { timeline } = await runTranscriptFixture({ transcript: "0" });
  assert.match(timeline, /· r1 · development · \*\*done\*\*/);
  assert.doesNotMatch(timeline, /^## (dev|review) r1/m);
  assert.doesNotMatch(timeline, /^### /m);
  assert.ok(!timeline.includes("TEXT-MARKER-dev"));
  assert.ok(!timeline.includes("↳"));
});

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
    assert.ok(result.message.includes("Developer model: x/y · thinking max"));
    assert.ok(result.message.includes("Reviewer model: z/w · thinking high"));
    assert.ok(result.message.includes("Active role: human_decision"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
