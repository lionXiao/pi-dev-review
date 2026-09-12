import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findProjectRoot,
  readWorkflowState,
  readOverride,
  writeOverride,
  clearOverride,
  loadDiscipline,
  loadPolicy,
  loadExtensionConfig,
  renderDiscipline,
  renderPolicy,
  renderSuspended,
} from "../discipline-runtime.mjs";

async function tempProject() {
  const root = await mkdtemp(join(tmpdir(), "dev-review-disc-"));
  await mkdir(join(root, ".git"), { recursive: true });
  return root;
}

function stateFixture(status = "blocked") {
  return {
    workflow: { key: "demo--abc12345" },
    status,
    phase: "human_decision",
    currentRound: 3,
    config: {
      maxReviewRounds: 10,
      developerModel: "opencode-go/deepseek-flash",
      reviewerModel: "bigfish/gpt-5.6-luna",
      developerThinking: "max",
      reviewerThinking: "high",
    },
    openIssues: [{ id: "R1-001", severity: "major", requirement: "举例" }],
    blocked: {
      reason: "reviewer-spec-blocked",
      details: {
        summary: "卡在人工验收",
        questions: [
          { question: "谁做 L1 验收？", why: "计划要求", options: ["用户", "developer", "coordinator"] },
          "纯字符串问题",
        ],
      },
      escalationPath: ".ai-dev-review/demo--abc12345/escalation/01-reviewer-spec-blocked.md",
    },
  };
}

test("findProjectRoot: nearest workflow pointer wins, else git root", async () => {
  const root = await tempProject();
  const nested = join(root, "docs", "prd");
  await mkdir(nested, { recursive: true });
  assert.equal(findProjectRoot(nested), root);

  await mkdir(join(nested, ".ai-dev-review"), { recursive: true });
  await writeFile(join(nested, ".ai-dev-review", "active-workflow.json"), '{}\n', "utf8");
  assert.equal(findProjectRoot(nested), nested);
  await rm(root, { recursive: true, force: true });
});

test("readWorkflowState: reads pointer + state, degrades gracefully", async () => {
  const root = await tempProject();
  const artifact = join(root, ".ai-dev-review", "demo--abc12345");
  await mkdir(artifact, { recursive: true });
  await writeFile(
    join(root, ".ai-dev-review", "active-workflow.json"),
    JSON.stringify({ workflowKey: "demo--abc12345", artifactDir: ".ai-dev-review/demo--abc12345" }),
    "utf8",
  );
  await writeFile(join(artifact, "state.json"), JSON.stringify(stateFixture()), "utf8");

  const wf = await readWorkflowState(root);
  assert.equal(wf.found, true);
  assert.equal(wf.status, "blocked");
  assert.equal(wf.currentRound, 3);
  assert.equal(wf.openIssue.id, "R1-001");
  assert.equal(wf.blocked.reason, "reviewer-spec-blocked");
  assert.equal(wf.blocked.summary, "卡在人工验收");
  assert.equal(wf.blocked.escalationPath, ".ai-dev-review/demo--abc12345/escalation/01-reviewer-spec-blocked.md");
  assert.deepEqual(wf.blocked.questions, [
    { question: "谁做 L1 验收？", options: ["用户", "developer", "coordinator"] },
    { question: "纯字符串问题", options: [] },
  ]);
  assert.equal(wf.timelinePath, ".ai-dev-review/demo--abc12345/reports/timeline.md");
  assert.equal(wf.developerModel, "opencode-go/deepseek-flash");
  assert.equal(wf.reviewerModel, "bigfish/gpt-5.6-luna");
  assert.equal(wf.developerThinking, "max");
  assert.equal(wf.reviewerThinking, "high");

  assert.deepEqual(await readWorkflowState(null), { found: false });
  assert.deepEqual(await readWorkflowState(join(root, "nope")), { found: false });
  await rm(root, { recursive: true, force: true });
});

test("override round-trip: write, read while valid, expiry hides it, clear removes it", async () => {
  const root = await tempProject();

  const rec = await writeOverride(root, { reason: "线上热修", minutes: 30 });
  assert.equal(rec.forever, false);
  assert.ok(Date.parse(rec.until) > Date.now());

  const read = await readOverride(root);
  assert.equal(read.reason, "线上热修");

  await writeOverride(root, { reason: "已过期", minutes: -1 });
  assert.equal(await readOverride(root), null);

  const forever = await writeOverride(root, { reason: "永久挂起", minutes: null });
  assert.equal(forever.until, null);
  assert.equal((await readOverride(root)).reason, "永久挂起");

  await clearOverride(root);
  assert.equal(await readOverride(root), null);

  const audit = await readFile(join(root, ".ai-dev-review", "discipline-audit.jsonl"), "utf8");
  const actions = audit.trim().split("\n").map((line) => JSON.parse(line).action);
  assert.deepEqual(actions, ["suspend", "suspend", "suspend", "resume"]);
  await rm(root, { recursive: true, force: true });
});

test("rendering: discipline carries the cache marker and live state line", async () => {
  const { text, version } = await loadDiscipline();
  assert.ok(text.length > 0);
  assert.ok(/^[0-9a-f]{8}$/.test(version));

  const rendered = renderDiscipline(text, await readWorkflowState(null));
  assert.ok(rendered.includes("<!-- dev-review-discipline -->"));
  assert.ok(rendered.includes("当前工作流：未知"));

  const suspended = renderSuspended({ reason: "热修", until: new Date(Date.now() + 60_000).toISOString() });
  assert.ok(suspended.includes("热修"));
});

test("policy: always-on working agreement loads with its own marker", async () => {
  const { text, version } = await loadPolicy();
  assert.ok(text.length > 0);
  assert.ok(/^[0-9a-f]{8}$/.test(version));

  const rendered = renderPolicy(text);
  assert.ok(rendered.startsWith("<!-- dev-review-policy -->"));
  assert.ok(rendered.includes("改动分级"));
  assert.ok(rendered.includes("提问线"));
  // The marker is added by renderPolicy; the source file must not carry its own
  // copy (it would be duplicated in the system prompt).
  assert.equal(rendered.split("<!-- dev-review-policy -->").length - 1, 1);
  assert.ok(!text.includes("<!-- dev-review-policy -->"));
});

test("config: working-agreement injection defaults on", async () => {
  const config = await loadExtensionConfig();
  assert.equal(typeof config.injectWorkingAgreement, "boolean");
});
