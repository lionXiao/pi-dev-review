import { test } from "node:test";
import assert from "node:assert/strict";

import { blockedNotice } from "../workflow.mjs";

test("blockedNotice: carries reason, summary, questions with options and the decision file", () => {
  const state = {
    status: "blocked",
    blocked: {
      reason: "reviewer-spec-blocked",
      escalationPath: ".ai-dev-review/demo/escalation/01-reviewer-spec-blocked.md",
      details: {
        summary: "代码全过，卡在人工 UI 验收。",
        questions: [
          {
            question: "L1 人工验收由谁执行？",
            why: "计划要求提交前完成",
            options: ["用户执行", "授权 developer 机器复核", "授权 coordinator 机器复核"],
          },
          "为什么不全用 git worktree 并行？",
        ],
      },
    },
  };

  const notice = blockedNotice(state);
  assert.match(notice, /^Blocked \(reviewer-spec-blocked\)/);
  assert.ok(notice.includes("Why: 代码全过"));
  assert.ok(notice.includes("Q1: L1 人工验收由谁执行？"));
  assert.ok(notice.includes("1) 用户执行"));
  assert.ok(notice.includes("3) 授权 coordinator 机器复核"));
  // Plain-string questions (developer blockers reuse this shape) still show up.
  assert.ok(notice.includes("Q2: 为什么不全用 git worktree 并行？"));
  assert.ok(
    notice.includes("Decision file: .ai-dev-review/demo/escalation/01-reviewer-spec-blocked.md"),
  );
});

test("blockedNotice: degrades safely and truncates long text", () => {
  assert.equal(blockedNotice({ status: "blocked", blocked: { reason: "max-rounds" } }), "Blocked (max-rounds)");

  const long = "字".repeat(2000);
  const notice = blockedNotice(
    { blocked: { reason: "x", details: { summary: long } } },
    { summaryLimit: 100 },
  );
  assert.ok(notice.includes("…"));
  assert.ok(notice.length < 400);

  assert.ok(blockedNotice({ status: "blocked", blocked: null }).includes("no recorded blocking reason"));
});

test("blockedNotice: caps the number of questions and options it prints", () => {
  const questions = Array.from({ length: 6 }, (_, index) => ({
    question: `问题 ${index + 1}`,
    options: Array.from({ length: 10 }, (_, option) => `选项 ${index + 1}-${option + 1}`),
  }));
  const notice = blockedNotice(
    { blocked: { reason: "spec", details: { questions } } },
    { questionLimit: 2, optionLimit: 3 },
  );
  assert.ok(notice.includes("Q1:") && notice.includes("Q2:"));
  assert.ok(!notice.includes("Q3:"));
  assert.ok(notice.includes("1) 选项 1-1"));
  assert.ok(notice.includes("3) 选项 1-3"));
  assert.ok(!notice.includes("4) 选项 1-4"));
  assert.ok(notice.includes("还有 4 个决策问题"));
});
