import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentFailureRetryable, runCommand } from "../workflow.mjs";

// Emulates pi's `--mode json` behaviour for the b2a incident: an upstream
// stream break marks the final assistant message with stopReason "error" and
// pi still exits 0, so the engine must detect the stop reason itself.
const FAKE_PI = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const sessionId = args[args.indexOf("--session-id") + 1] || "unknown";
const model = args[args.indexOf("--model") + 1] || "";
const developer = model.includes("dev");
const counterPath = \`\${process.env.FAKE_PI_STATE_DIR}/\${sessionId}.count\`;
const attempt = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) + 1 : 1;
writeFileSync(counterPath, String(attempt));

const write = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 10, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const start = () => write({ type: "message_start", message: { role: "assistant", content: [], timestamp: Date.now() - 200 } });

if (process.env.FAKE_PI_MODE === "fatal-quota") {
  start();
  write({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "quota" }], stopReason: "error", errorMessage: "insufficient_quota: balance exhausted", usage } });
} else if (attempt === 1) {
  // Developer attempt 1 dies with no text at all (the real incident);
  // reviewer attempt 1 dies with partial text that must never be parsed.
  const content = developer
    ? [{ type: "thinking", thinking: "stream died" }]
    : [{ type: "thinking", thinking: "stream died" }, { type: "text", text: '{"decision":"pa' }];
  start();
  write({ type: "message_end", message: { role: "assistant", content, stopReason: "error", errorMessage: "stream_read_error", usage: { ...usage, input: 0, output: 0, reasoning: 0, totalTokens: 0 } } });
} else {
  const report = developer
    ? { status: "done", summary: "implemented", changed_files: [], requirements_covered: [], resolved_issues: [], tests: [], assumptions: [], risks: [], handoff_to_reviewer: "check", blockers: [] }
    : { decision: "pass", summary: "looks good", previous_issue_verdicts: [], new_findings: [], spec_questions: [], handoff_to_developer: "none" };
  start();
  write({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(report) }], stopReason: "stop", usage } });
}
`;

async function retryFixture() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "dev-review-retry-")));
  const stateDir = realpathSync(await mkdtemp(join(tmpdir(), "dev-review-retry-state-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  await writeFile(join(root, "PLAN.md"), "# Plan\n", "utf8");
  const script = join(root, "fake-pi.mjs");
  await writeFile(script, FAKE_PI, "utf8");
  return { root, stateDir, script };
}

async function runWithEnv(env, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("agentFailureRetryable: transient stream/network failures retry; quota/auth/abort/spawn do not", () => {
  assert.equal(agentFailureRetryable({ kind: "stream-error", errorMessage: "stream_read_error" }), true);
  assert.equal(agentFailureRetryable({ kind: "exit", stderr: "ECONNRESET while reading" }), true);
  assert.equal(agentFailureRetryable({ kind: "no-final-message", stderr: "Warning: No project session found" }), true);
  assert.equal(agentFailureRetryable({ kind: "stream-error", errorMessage: "insufficient_quota" }), false);
  assert.equal(agentFailureRetryable({ kind: "exit", stderr: "401 unauthorized" }), false);
  assert.equal(agentFailureRetryable({ kind: "aborted", errorMessage: "stream_read_error" }), false);
  assert.equal(agentFailureRetryable({ kind: "spawn", errorMessage: "ENOENT" }), false);
});

test("run: stream errors on the first attempt are retried and the round completes", async () => {
  const { root, stateDir, script } = await retryFixture();
  const notifications = [];
  try {
    const result = await runWithEnv({
      DEV_REVIEW_DEVELOPER_MODEL: "fake/dev",
      DEV_REVIEW_REVIEWER_MODEL: "fake/rev",
      FAKE_PI_STATE_DIR: stateDir,
      FAKE_PI_MODE: "",
      DEV_REVIEW_RETRY_BASE_MS: "1",
    }, () => runCommand({
      args: "start PLAN.md --allow-dirty --agent-retries 2",
      cwd: root,
      piInvocation: { command: process.execPath, args: [script] },
      notify: (message) => notifications.push(String(message)),
      onReport: async () => {},
    }));

    assert.equal(result.state.status, "passed");
    assert.equal(result.state.config.agentRetries, 2);

    // Both roles died once on stream_read_error and were retried automatically.
    assert.equal(await readFile(join(stateDir, "developer-g1.count"), "utf8"), "2");
    assert.equal(await readFile(join(stateDir, "reviewer-r01.count"), "utf8"), "2");
    assert.ok(
      notifications.some((line) => line.includes("attempt 1/3 failed: stream_read_error")),
      notifications.join("\n"),
    );

    const timeline = await readFile(join(result.paths.reports, "timeline.md"), "utf8");
    const retries = timeline.split("\n").filter((line) => line.includes("agent-retry"));
    assert.equal(retries.length, 2);
    assert.match(retries[0], /stream_read_error/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("run: quota exhaustion is not retried and escalates immediately", async () => {
  const { root, stateDir, script } = await retryFixture();
  try {
    const result = await runWithEnv({
      DEV_REVIEW_DEVELOPER_MODEL: "fake/dev",
      DEV_REVIEW_REVIEWER_MODEL: "fake/rev",
      FAKE_PI_STATE_DIR: stateDir,
      FAKE_PI_MODE: "fatal-quota",
      DEV_REVIEW_RETRY_BASE_MS: "1",
    }, () => runCommand({
      args: "start PLAN.md --allow-dirty --agent-retries 2",
      cwd: root,
      piInvocation: { command: process.execPath, args: [script] },
      notify: () => {},
      onReport: async () => {},
    }));

    assert.equal(result.state.status, "blocked");
    assert.equal(result.state.blocked.reason, "developer-protocol-or-execution-error");
    assert.match(result.state.blocked.details.summary, /insufficient_quota/);
    assert.doesNotMatch(result.state.blocked.details.summary, /attempts/);
    assert.equal(await readFile(join(stateDir, "developer-g1.count"), "utf8"), "1");
    const timeline = await readFile(join(result.paths.reports, "timeline.md"), "utf8");
    assert.doesNotMatch(timeline, /agent-retry/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});
