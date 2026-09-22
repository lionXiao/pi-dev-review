import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { extractJsonObject, extractReportObject, repairUnbalancedReport, runCommand } from "../workflow.mjs";

/** Top-level keys of the developer report, in task-packet order. */
const DEVELOPER_KEYS = [
  "status",
  "summary",
  "changed_files",
  "requirements_covered",
  "resolved_issues",
  "tests",
  "assumptions",
  "risks",
  "handoff_to_reviewer",
  "blockers",
];

// The shape that stopped the b9 workflow twice in a row (r5 21:49, r6 21:54): the
// developer closed the resolved_issues element but dropped its '}' together with
// the array's ']', then kept writing top-level fields — so tests/assumptions/…
// landed inside the array. Every character of the report is present; only the two
// closers are missing (stopReason "stop", output far below any limit).
const UNCLOSED_ARRAY_REPORT = `All gates pass for round 6. Here is the complete final report:

{"status":"done","summary":"round 6 复验并收尾 R4-001","changed_files":["src/a.swift"],"requirements_covered":["E6"],"resolved_issues":[{"id":"R4-001","status":"fixed","summary":"结构校验","files":["src/a.swift"],"verification":["testA 通过"],"tests":[{"command":"npm test","status":"passed","summary":"8 通过"}],"assumptions":[],"risks":[],"handoff_to_reviewer":"复验 E6","blockers":[]}`;

const EXPECTED_REPORT = {
  status: "done",
  summary: "round 6 复验并收尾 R4-001",
  changed_files: ["src/a.swift"],
  requirements_covered: ["E6"],
  resolved_issues: [
    { id: "R4-001", status: "fixed", summary: "结构校验", files: ["src/a.swift"], verification: ["testA 通过"] },
  ],
  tests: [{ command: "npm test", status: "passed", summary: "8 通过" }],
  assumptions: [],
  risks: [],
  handoff_to_reviewer: "复验 E6",
  blockers: [],
};

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

test("extractReportObject: an unclosed array is repaired when the splice is unambiguous", () => {
  const { value, repair } = extractReportObject(UNCLOSED_ARRAY_REPORT, { keys: DEVELOPER_KEYS });
  assert.deepEqual(value, EXPECTED_REPORT);
  const [insertion] = repair.insertions;
  assert.equal(insertion.text, "}]");
  assert.equal(insertion.beforeKey, "tests");
  // Insert-only proof: removing exactly what was inserted reproduces the raw output.
  const objectStart = repair.objectStart;
  const absolute = objectStart + insertion.offset;
  const rebuilt = `${UNCLOSED_ARRAY_REPORT.slice(0, absolute)}${insertion.text}${UNCLOSED_ARRAY_REPORT.slice(absolute)}`;
  assert.equal(rebuilt.slice(0, absolute) + rebuilt.slice(absolute + insertion.text.length), UNCLOSED_ARRAY_REPORT);
  assert.deepEqual(JSON.parse(rebuilt.slice(objectStart)), EXPECTED_REPORT);
  // Provenance records what was open when the agent stopped closing things.
  assert.equal(repair.containers.length, 3);
  assert.equal(repair.containers.find((container) => container.character === "[")?.key, "resolved_issues");
  assert.equal(repair.rawLength, UNCLOSED_ARRAY_REPORT.length);
});

test("extractReportObject: a clean report is returned untouched and unflagged", () => {
  const { value, repair } = extractReportObject(JSON.stringify(EXPECTED_REPORT), { keys: DEVELOPER_KEYS });
  assert.deepEqual(value, EXPECTED_REPORT);
  assert.equal(repair, null);
});

test("extractReportObject: output that merely stops is not repaired", () => {
  // Ends inside the array: nothing follows the missing bracket, so the engine
  // cannot tell a dropped bracket from a truncated response — escalate instead.
  const truncated = `{"status":"done","summary":"x","resolved_issues":[{"id":"R1-001"}`;
  assert.throws(() => extractReportObject(truncated, { keys: DEVELOPER_KEYS }), /unterminated JSON object/);
  try {
    extractReportObject(truncated, { keys: DEVELOPER_KEYS });
    assert.fail("expected the run to escalate");
  } catch (error) {
    assert.match(error.message, /never closed/);
    assert.match(error.message, /array for "resolved_issues"/);
  }
});

test("extractReportObject: bracket repair can be switched off", () => {
  assert.throws(
    () => extractReportObject(UNCLOSED_ARRAY_REPORT, { keys: DEVELOPER_KEYS, repair: false }),
    /unterminated JSON object/,
  );
});

test("repairUnbalancedReport: a splice that would duplicate a top-level key is refused", () => {
  // Closing before the inner `b` parses, but it turns the element key into a
  // second top-level `b` — JSON tolerates duplicates, the report schema does not.
  const result = repairUnbalancedReport(`{"b":[{"b":1},"b":2}`, ["b"]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "none");
});

async function readyFixture(configOverrides = {}) {
  const tempRoot = await mkdtemp(join(tmpdir(), "dev-review-protocol-"));
  // git reports the realpath (/private/var/... on macOS), so the fixture state
  // must use the same root or relativeTo() climbs out of the project.
  const root = realpathSync(tempRoot);
  execFileSync("git", ["init", "-q"], { cwd: root });
  // The engine fingerprints the worktree with `git diff HEAD`, which needs a commit.
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
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
        ...configOverrides,
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

test("run: a report with a dropped closing bracket keeps the round instead of blocking", async () => {
  const root = await readyFixture();
  try {
    const PASS_REVIEW = JSON.stringify({
      decision: "pass",
      summary: "独立复核通过",
      previous_issue_verdicts: [],
      new_findings: [],
      tests: [],
      spec_questions: [],
      handoff_to_developer: "none",
    });
    const result = await runCommand({
      args: "run",
      cwd: root,
      notify: () => {},
      invokeAgent: async ({ role }) => ({
        finalText: role === "developer" ? UNCLOSED_ARRAY_REPORT : PASS_REVIEW,
        usage: null,
      }),
    });
    assert.equal(result.state.status, "passed", "the round must survive the repair");

    const handoffs = join(root, ".ai-dev-review", "demo--abc12345", "handoffs");
    const repairedReport = JSON.parse(await readFile(join(handoffs, "developer-r01.json"), "utf8"));
    assert.equal(repairedReport.status, "done");
    assert.equal(repairedReport.tests.length, 1);

    const sidecar = JSON.parse(await readFile(join(handoffs, "developer-r01.repair.json"), "utf8"));
    assert.equal(sidecar.reason, "unbalanced-json-containers");
    assert.deepEqual(sidecar.insertions.map((entry) => [entry.text, entry.beforeKey]), [["}]", "tests"]]);
    assert.match(sidecar.rawTextPath, /developer-r01\.raw\.txt$/);
    assert.equal(await readFile(join(root, sidecar.rawTextPath), "utf8"), UNCLOSED_ARRAY_REPORT);

    const handoff = await readFile(join(handoffs, "developer-r01.md"), "utf8");
    assert.match(handoff, /## Report JSON auto-repaired/);
    assert.match(handoff, /content unchanged|verbatim/);

    const timeline = await readFile(join(root, ".ai-dev-review", "demo--abc12345", "reports", "timeline.md"), "utf8");
    assert.match(timeline, /report-repaired/);
    assert.match(timeline, /inserted `}\]` before `tests`/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run: a rejected report is retried in the same session and keeps the round", async () => {
  const root = await readyFixture();
  try {
    const PASS_REVIEW = JSON.stringify({
      decision: "pass",
      summary: "ok",
      previous_issue_verdicts: [],
      new_findings: [],
      tests: [],
      spec_questions: [],
      handoff_to_developer: "none",
    });
    const tasks = [];
    let developerCalls = 0;
    const result = await runCommand({
      args: "run",
      cwd: root,
      notify: () => {},
      invokeAgent: async ({ role, task }) => {
        if (role === "developer") {
          tasks.push(task);
          developerCalls += 1;
          return { finalText: developerCalls === 1 ? MALFORMED_REPORT : JSON.stringify(EXPECTED_REPORT), usage: null };
        }
        return { finalText: PASS_REVIEW, usage: null };
      },
    });
    assert.equal(result.state.status, "passed", "the retry must save the round");
    assert.equal(developerCalls, 2, "the developer is called twice");
    // The retry carries the reason and the no-redo instruction.
    assert.match(tasks[0], /You are the DEVELOPMENT role/);
    assert.doesNotMatch(tasks[0], /Report retry/);
    assert.match(tasks[1], /## Report retry \(attempt 1 of 2 — engine-injected\)/);
    assert.match(tasks[1], /must NOT be redone/);
    assert.match(tasks[1], /malformed JSON/);

    const handoffs = join(root, ".ai-dev-review", "demo--abc12345", "handoffs");
    // The rejected attempt is preserved under its own name.
    assert.equal(await readFile(join(handoffs, "developer-r01.raw.txt"), "utf8"), MALFORMED_REPORT);
    assert.equal(JSON.parse(await readFile(join(handoffs, "developer-r01.json"), "utf8")).status, "done");

    const timeline = await readFile(join(root, ".ai-dev-review", "demo--abc12345", "reports", "timeline.md"), "utf8");
    assert.match(timeline, /report-retry/);
    // A retried report is not a failed round.
    assert.equal(result.state.currentRound, 1);
    assert.equal(result.state.reportFailures ?? undefined, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run: --protocol-retries 0 escalates the first rejection without retrying", async () => {
  const root = await readyFixture();
  try {
    let developerCalls = 0;
    const result = await runCommand({
      args: "run --protocol-retries 0",
      cwd: root,
      notify: () => {},
      invokeAgent: async ({ role }) => {
        if (role !== "developer") return { finalText: "{}", usage: null };
        developerCalls += 1;
        return { finalText: MALFORMED_REPORT, usage: null };
      },
    });
    assert.equal(developerCalls, 1, "no retry when the limit is zero");
    assert.equal(result.state.status, "blocked");
    assert.equal(result.state.blocked.reason, "developer-protocol-or-execution-error");
    assert.equal(result.state.reportFailures.length, 1);
    assert.match(result.state.blocked.details.summary, /malformed JSON/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run: a failed round does not consume the review budget", async () => {
  // One configured round: the first attempt dies on a protocol error, the second
  // (after the human resolves) must still be allowed to run.
  const root = await readyFixture({ maxReviewRounds: 1, protocolRetries: 0 });
  try {
    const blocked = await runCommand({
      args: "run",
      cwd: root,
      notify: () => {},
      invokeAgent: async ({ role }) => ({
        finalText: role === "developer" ? MALFORMED_REPORT : "{}",
        usage: null,
      }),
    });
    assert.equal(blocked.state.status, "blocked");
    assert.equal(blocked.state.reportFailures.length, 1);
    assert.equal(blocked.state.reportFailures[0].round, 1);

    const PASS_REVIEW = JSON.stringify({
      decision: "pass",
      summary: "ok",
      previous_issue_verdicts: [],
      new_findings: [],
      tests: [],
      spec_questions: [],
      handoff_to_developer: "none",
    });
    const resolved = await runCommand({
      args: "resolve --choose retry --note 'protocol repair done'",
      cwd: root,
      notify: () => {},
    });
    assert.equal(resolved.state.status, "ready");

    const passed = await runCommand({
      args: "run",
      cwd: root,
      notify: () => {},
      invokeAgent: async ({ role }) => ({
        finalText: role === "developer" ? JSON.stringify(EXPECTED_REPORT) : PASS_REVIEW,
        usage: null,
      }),
    });
    assert.equal(passed.state.status, "passed", "the excluded round must not trigger max-rounds");
    assert.equal(passed.state.currentRound, 2);
    const timeline = await readFile(join(root, ".ai-dev-review", "demo--abc12345", "reports", "timeline.md"), "utf8");
    assert.match(timeline, /report-failure/);
    assert.match(timeline, /round budget extended/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tools: the extension syntax check strips types and rejects broken TS", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const tool = join(here, "..", "tools", "check-extension-syntax.mjs");
  const extension = join(here, "..", "..", "extensions", "dev-review-loop", "index.ts");
  const status = (file) => {
    try {
      execFileSync(process.execPath, [tool, file], { stdio: "pipe" });
      return 0;
    } catch (error) {
      return error.status ?? 1;
    }
  };
  assert.equal(status(extension), 0, "the shipped extension must pass its own syntax check");
  const broken = join(tmpdir(), `pi-dev-review-broken-${process.pid}.ts`);
  writeFileSync(broken, "type T = { a: string };\nexport const x: T = { a:  } ;\n", "utf8");
  try {
    assert.notEqual(status(broken), 0, "broken TypeScript must fail the check");
  } finally {
    rmSync(broken, { force: true });
  }
});

test("run: a parseable report with a schema error is recovered into the escalation", async () => {  const wrongStatus = JSON.stringify(
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
