import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addUsageRequest, createUsageStats, formatTokenCount, runCommand, usageEntry, usageLine } from "../workflow.mjs";

test("formatTokenCount / usageLine: pi-style summary with cache hit rate, speed and TTFT", () => {
  assert.equal(formatTokenCount(950), "950");
  assert.equal(formatTokenCount(12345), "12.3k");
  assert.equal(formatTokenCount(2_500_000), "2.5M");

  const stats = createUsageStats();
  addUsageRequest(stats, {
    startAt: 1000,
    firstDeltaAt: 1800, // TTFT 800ms
    endAt: 3800, // generation 2000ms for 2000 output tokens => 1000 tok/s
    usage: { input: 1000, output: 2000, cacheRead: 99_000, cacheWrite: 0, reasoning: 500, totalTokens: 102_000 },
  });
  const line = usageLine(stats);
  assert.match(line, /tokens ↑1\.0k ↓2\.0k/);
  assert.match(line, /R99\.0k \(CH 99\.0%\)/);
  assert.match(line, /1000\.0 tok\/s/);
  assert.match(line, /TTFT 0\.80s/);
  assert.match(line, /think 500/);

  const entry = usageEntry({ role: "developer", round: 2, stats });
  assert.equal(entry.requests, 1);
  assert.equal(entry.ttftAvgMs, 800);
  assert.equal(entry.setupAvgMs, null);
  assert.equal(entry.outputPerSec, 1000);
  assert.equal(entry.cacheHitRate, 0.99);
  assert.equal(entry.line, line);
});

test("usageLine/usageEntry: standard client-side TTFT plus the pre-stream setup breakdown", () => {
  const stats = createUsageStats();
  addUsageRequest(stats, {
    requestAt: 200, // child stamped the request just before provider fetch
    startAt: 1000, // SSE response headers received
    firstDeltaAt: 1800, // first streamed token
    endAt: 3800,
    usage: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 300 },
  });
  const line = usageLine(stats);
  assert.match(line, /TTFT 1\.60s \(setup 0\.80s\)/);
  const entry = usageEntry({ role: "developer", round: 1, stats });
  assert.equal(entry.ttftAvgMs, 1600);
  assert.equal(entry.setupAvgMs, 800);
});

test("usageLine: no cache reporting and no timing degrades gracefully", () => {
  const stats = createUsageStats();
  addUsageRequest(stats, {
    startAt: null,
    firstDeltaAt: null,
    endAt: null,
    usage: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 105 },
  });
  assert.equal(usageLine(stats), "tokens ↑100 ↓5");
  assert.equal(usageLine(createUsageStats()), null);
});

async function fakePiFixture() {
  const tempRoot = await mkdtemp(join(tmpdir(), "dev-review-usage-"));
  const root = realpathSync(tempRoot);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  await writeFile(join(root, "PLAN.md"), "# Plan\n", "utf8");

  const script = join(root, "fake-pi.mjs");
  await writeFile(
    script,
    `const args = process.argv.slice(2);
const model = args[args.indexOf("--model") + 1] || "";
const developer = model.includes("dev");
const report = developer
  ? { status: "done", summary: "implemented", changed_files: [], requirements_covered: [], resolved_issues: [], tests: [], assumptions: [], risks: [], handoff_to_reviewer: "check", blockers: [] }
  : { decision: "pass", summary: "looks good", previous_issue_verdicts: [], new_findings: [], spec_questions: [], handoff_to_developer: "none" };
const usage = developer
  ? { input: 1000, output: 2000, cacheRead: 50000, cacheWrite: 0, reasoning: 500, totalTokens: 53000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  : { input: 500, output: 1000, cacheRead: 80000, cacheWrite: 100, reasoning: 200, totalTokens: 81600, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
write({ type: "message_start", message: { role: "assistant", content: [], timestamp: Date.now() - 500 } });
await new Promise((resolve) => setTimeout(resolve, 30));
write({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" }, usage: {} });
await new Promise((resolve) => setTimeout(resolve, 60));
write({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(report) }], usage } });
process.exit(0);
`,
    "utf8",
  );
  return { root, script };
}

test("usage tracking: engine writes reports/usage.json, timeline and status lines", async () => {
  const { root, script } = await fakePiFixture();
  const previous = {
    dev: process.env.DEV_REVIEW_DEVELOPER_MODEL,
    rev: process.env.DEV_REVIEW_REVIEWER_MODEL,
  };
  process.env.DEV_REVIEW_DEVELOPER_MODEL = "fake/dev";
  process.env.DEV_REVIEW_REVIEWER_MODEL = "fake/rev";
  try {
    const statsSeen = [];
    const result = await runCommand({
      args: "start PLAN.md --allow-dirty",
      cwd: root,
      piInvocation: { command: process.execPath, args: [script] },
      notify: () => {},
      onReport: async () => {},
      onStats: (stats) => statsSeen.push(stats),
    });
    assert.equal(result.state.status, "passed");

    const usageFile = JSON.parse(await readFile(join(result.paths.reports, "usage.json"), "utf8"));
    const dev = usageFile.entries.find((entry) => entry.role === "developer");
    const review = usageFile.entries.find((entry) => entry.role === "reviewer");
    assert.ok(dev && review);
    assert.equal(dev.round, 1);
    assert.equal(dev.requests, 1);
    assert.equal(dev.input, 1000);
    assert.equal(dev.output, 2000);
    assert.equal(dev.cacheRead, 50000);
    assert.equal(dev.cacheHitRate, 0.9804);
    assert.ok(dev.ttftAvgMs >= 500, `standard ttft ${dev.ttftAvgMs}`);
    assert.ok(dev.setupAvgMs >= 450, `setup ${dev.setupAvgMs}`);
    assert.ok(dev.line.includes("TTFT") && dev.line.includes("(setup "), dev.line);
    assert.ok(dev.outputPerSec > 0);
    assert.ok(dev.line.includes("CH 98.0%"));
    assert.ok(dev.line.includes("TTFT"));
    assert.equal(review.cacheWrite, 100);

    // Live callback fired once per role with a preformatted line.
    assert.deepEqual(statsSeen.map((item) => item.role), ["developer", "reviewer"]);
    assert.ok(statsSeen.every((item) => typeof item.line === "string" && item.line.length > 0));

    const timeline = await readFile(join(result.paths.reports, "timeline.md"), "utf8");
    const devLine = timeline.split("\n").find((line) => line.includes("· r1 · development ·"));
    assert.ok(devLine && devLine.includes("CH 98.0%"), devLine);
    assert.ok(devLine.includes("tok/s"));

    const status = await runCommand({ args: "status", cwd: root });
    assert.ok(status.message.includes("Usage dev r1: tokens"));
    assert.ok(status.message.includes("Usage review r1: tokens"));
  } finally {
    if (previous.dev === undefined) delete process.env.DEV_REVIEW_DEVELOPER_MODEL;
    else process.env.DEV_REVIEW_DEVELOPER_MODEL = previous.dev;
    if (previous.rev === undefined) delete process.env.DEV_REVIEW_REVIEWER_MODEL;
    else process.env.DEV_REVIEW_REVIEWER_MODEL = previous.rev;
    await rm(root, { recursive: true, force: true });
  }
});
