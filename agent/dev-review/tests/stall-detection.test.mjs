import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_STALL_GATE,
  STALL_CANDIDATES,
  STALL_DIRECTIVE,
  detectStallClusters,
  makeDeveloperTask,
  makeReviewerTask,
  normalizeReviewerReport,
  normalizeStallGate,
  renderStallCandidateSection,
  renderStallDirective,
  runCommand,
  stallIdentifiers,
  stallLinkScore,
  stallLinkSignals,
  stallLocationFiles,
  stallRequirementBigrams,
} from "../workflow.mjs";

// Stall-detection tests. The 17 frozen fixtures under tests/fixtures/stall are
// the human ground truth (labels.json); this file replays them, unit-tests the
// mechanical link signals, and checks that a non-firing round changes no task
// packet while a firing round injects the compensation text.

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "fixtures", "stall");
const labels = JSON.parse(readFileSync(join(FIXTURE_DIR, "labels.json"), "utf8"));

const fixtures = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith(".json") && name !== "labels.json")
  .sort()
  .map((name) => ({ name, fixture: JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) }));

/** Detector output after every fix_required round, keyed by round number. */
function evaluationsByRound(fixture, gate = DEFAULT_STALL_GATE) {
  const evaluations = new Map();
  for (let index = 0; index < fixture.rounds.length; index += 1) {
    const record = fixture.rounds[index];
    if (record.decision !== "fix_required") continue;
    evaluations.set(record.round, detectStallClusters(fixture.rounds.slice(0, index + 1), undefined, gate));
  }
  return evaluations;
}

function lastEvaluation(fixture, gate = DEFAULT_STALL_GATE) {
  const evaluations = evaluationsByRound(fixture, gate);
  const rounds = [...evaluations.keys()];
  return evaluations.get(Math.max(...rounds));
}

test("fixture replay: firePolicy, family clustering and L3 candidate coverage match labels.json", () => {
  for (const { name, fixture } of fixtures) {
    const label = labels.scenarios[fixture.scenario];
    assert.ok(label, `${name}: missing label`);

    const evaluations = evaluationsByRound(fixture);
    const softRounds = [...evaluations.values()].filter((entry) => entry.soft.fired).map((entry) => entry.round);
    const hardRounds = [...evaluations.values()].filter((entry) => entry.hard.fired).map((entry) => entry.round);

    if (label.soft.expect === "must-not-fire") {
      assert.deepEqual(softRounds, [], `${name}: soft must not fire`);
    }
    if (label.soft.expect === "must-fire-by") {
      assert.ok(softRounds.length > 0, `${name}: soft never fired (deadline r${label.soft.round})`);
      assert.ok(softRounds[0] <= label.soft.round, `${name}: soft first fired r${softRounds[0]}, deadline r${label.soft.round}`);
    }
    if (label.hard.expect === "must-not-fire") {
      assert.deepEqual(hardRounds, [], `${name}: hard must not fire`);
    }
    if (label.hard.expect === "not-before") {
      for (const round of hardRounds) {
        assert.ok(round >= label.hard.round, `${name}: hard fired r${round}, not-before r${label.hard.round}`);
      }
    }

    if (label.class !== "stalled-family") continue;
    const final = lastEvaluation(fixture);
    for (const family of label.expectedFamilies) {
      const required = family.filter((id) => !label.knownL2Misses.includes(id));
      const cluster = final.clusters.find((candidate) => required.every((id) => candidate.members.includes(id)));
      assert.ok(cluster, `${name}: family ${required.join(", ")} is not one cluster (${final.clusters.map((c) => c.members.join("|")).join(" ; ")})`);
    }
    for (const miss of label.knownL2Misses) {
      const birth = fixture.rounds.find((round) => round.findings.some((finding) => finding.id === miss))?.round;
      const evaluation = evaluations.get(birth);
      assert.ok(evaluation, `${name}: no evaluation at ${miss} birth round r${birth}`);
      assert.ok(
        evaluation.candidates.some((candidate) => candidate.id === miss),
        `${name}: known L2 miss ${miss} missing from L3 candidates (${evaluation.candidates.map((c) => c.id).join(", ")})`,
      );
    }
  }
});

test("link signals: sameFile, ref, reqSim and identSim each fire independently", () => {
  const parent = {
    id: "R1-003",
    severity: "major",
    location: "src/app/Reminders.swift:100",
    requirement: "提醒错误反馈必须随提醒恢复或数据删除清理，不得把旧错误带入新的钱包状态",
    evidence: "reminderErrorMessage 没有清空，scheduleReminder 不调用 clearInlineNotice",
    required_fix: "在确认删除及无快照清理路径统一清除 reminderNotice 和 reminderErrorMessage",
  };
  const baseline = {
    id: "R3-001",
    severity: "minor",
    location: "src/app/Reminders.swift:225",
    requirement: "键盘动画开始时将被遮挡的聚焦行预滚动",
    evidence: "keyboardAnimation focusRow preScroll",
    required_fix: "adjust keyboardAnimation",
  };

  const sameFileOnly = stallLinkSignals(baseline, parent);
  assert.equal(sameFileOnly.sameFile, 1);
  assert.equal(sameFileOnly.ref, 0);
  assert.ok(sameFileOnly.reqSim < DEFAULT_STALL_GATE.reqSim, `reqSim ${sameFileOnly.reqSim}`);
  assert.ok(sameFileOnly.identSim < DEFAULT_STALL_GATE.identSim, `identSim ${sameFileOnly.identSim}`);

  const refOnly = stallLinkSignals(
    { ...baseline, location: "src/core/Other.swift:1", requirement: "F8 / R1-003：提醒权限失败后必须清理旧状态" },
    parent,
  );
  assert.equal(refOnly.ref, 1);
  assert.equal(refOnly.sameFile, 0);

  const reqOnly = stallLinkSignals(
    {
      ...baseline,
      location: "src/core/Other.swift:1",
      requirement: parent.requirement,
      evidence: "alpha beta gamma delta epsilon",
      required_fix: "nothing",
    },
    parent,
  );
  assert.equal(reqOnly.sameFile, 0);
  assert.equal(reqOnly.ref, 0);
  assert.ok(reqOnly.reqSim >= DEFAULT_STALL_GATE.reqSim, `reqSim ${reqOnly.reqSim}`);
  assert.ok(reqOnly.identSim < DEFAULT_STALL_GATE.identSim, `identSim ${reqOnly.identSim}`);

  const identOnly = stallLinkSignals(
    {
      ...baseline,
      location: "src/core/Other.swift:1",
      evidence: parent.evidence,
      required_fix: "nothing",
    },
    parent,
  );
  assert.equal(identOnly.sameFile, 0);
  assert.equal(identOnly.ref, 0);
  assert.ok(identOnly.reqSim < DEFAULT_STALL_GATE.reqSim, `reqSim ${identOnly.reqSim}`);
  assert.ok(identOnly.identSim >= DEFAULT_STALL_GATE.identSim, `identSim ${identOnly.identSim}`);

  // parentOpen adds the plan's half weight. At the shipped 1.75 threshold a
  // lone sameFile signal stays below the line either way; one additional weak
  // signal (sameFile + identSim = 2.0) is what links.
  assert.equal(stallLinkScore(sameFileOnly, false, DEFAULT_STALL_GATE), 1);
  assert.equal(stallLinkScore(sameFileOnly, true, DEFAULT_STALL_GATE), 1.5);
  assert.equal(
    stallLinkScore(sameFileOnly, true, DEFAULT_STALL_GATE) - stallLinkScore(sameFileOnly, false, DEFAULT_STALL_GATE),
    0.5,
  );
  assert.ok(stallLinkScore(sameFileOnly, true, DEFAULT_STALL_GATE) < DEFAULT_STALL_GATE.linkThreshold);
  assert.ok(stallLinkScore({ ...sameFileOnly, identSim: 1 }, false, DEFAULT_STALL_GATE) >= DEFAULT_STALL_GATE.linkThreshold);

  // identSim reads evidence+required_fix only (plan §4.2): a requirement-only
  // shared identifier must not fire it, even when the identifier is a code one.
  const requirementOnlyIdentifier = stallLinkSignals(
    {
      ...baseline,
      location: "src/core/Other.swift:1",
      requirement: "需要调用 applySnapshot 重建快照",
      evidence: "键盘动画开始时将被遮挡的聚焦行预滚动",
      required_fix: "调整聚焦行",
    },
    {
      ...parent,
      requirement: "applySnapshot 的调用时机必须在写锁内",
      evidence: "顺序未保证",
      required_fix: "先排空",
    },
  );
  assert.equal(requirementOnlyIdentifier.identSim, 0, "requirement identifiers must not feed identSim");

  // Multi-location findings compare the set of files; plan references are
  // stripped before requirement bigrams are built.
  assert.deepEqual([...stallLocationFiles("src/a.swift:718-732; src/b.swift:716,719")].sort(), ["src/a.swift", "src/b.swift"]);
  const bigrams = stallRequirementBigrams("冻结计划 §1.1、§1.2：提醒错误反馈");
  assert.ok(bigrams.has("提醒"));
  assert.ok(![...bigrams].some((gram) => gram.includes("§")));
  assert.deepEqual([...stallIdentifiers("handleReminderResult 调用了 applySnapshot")].sort(), ["applySnapshot", "handleReminderResult"]);
});

test("link gating: a parent closed in an earlier round is never resurrected", () => {
  const parentFinding = {
    id: "R1-001",
    severity: "major",
    location: "src/app/Thing.swift:10",
    requirement: "设置页提交必须排空未落盘的合法输入",
    evidence: "pendingUpload flush 顺序未保证",
    required_fix: "drain first",
  };
  const unrelatedSameFile = {
    id: "R3-001",
    severity: "minor",
    location: "src/app/Thing.swift:40",
    // Identical requirement (so sameFile + reqSim would link if the parent were
    // still a pairing candidate), unrelated evidence.
    requirement: parentFinding.requirement,
    evidence: "keyboardAnimation focusRow",
    required_fix: "adjust keyboardAnimation",
  };
  const closedLog = [
    { round: 1, decision: "fix_required", verdicts: [], findings: [parentFinding] },
    { round: 2, decision: "fix_required", verdicts: [{ id: "R1-001", verdict: "verified_closed" }], findings: [] },
    { round: 3, decision: "fix_required", verdicts: [], findings: [unrelatedSameFile] },
  ];
  const closed = detectStallClusters(closedLog, undefined, DEFAULT_STALL_GATE);
  const closedCluster = closed.clusters.find((cluster) => cluster.members.includes("R3-001"));
  assert.deepEqual(closedCluster.members, ["R3-001"], "a parent closed in an earlier round is not even a pairing candidate");

  const openLog = [
    { round: 1, decision: "fix_required", verdicts: [], findings: [parentFinding] },
    { round: 2, decision: "fix_required", verdicts: [{ id: "R1-001", verdict: "partially_fixed" }], findings: [] },
    { round: 3, decision: "fix_required", verdicts: [], findings: [unrelatedSameFile] },
  ];
  const open = detectStallClusters(openLog, undefined, DEFAULT_STALL_GATE);
  const openCluster = open.clusters.find((cluster) => cluster.members.includes("R3-001"));
  assert.deepEqual(openCluster.members, ["R1-001", "R3-001"], "the same pair links while the parent is open");
});

test("identSim ignores identifiers that appear only in requirement text", () => {
  // The exact R2-001 counterexample: same file, both requirements name
  // applySnapshot, but evidence/required_fix share nothing.
  const parent = {
    id: "R1-001",
    severity: "major",
    location: "src/app/Thing.swift:10",
    requirement: "applySnapshot 的调用时机必须在写锁内",
    evidence: "顺序未保证",
    required_fix: "先排空",
  };
  const child = {
    id: "R2-001",
    severity: "minor",
    location: "src/app/Thing.swift:40",
    requirement: "需要调用 applySnapshot 重建快照",
    evidence: "键盘动画开始时将被遮挡的聚焦行预滚动",
    required_fix: "调整聚焦行",
  };
  const signals = stallLinkSignals(child, parent);
  assert.equal(signals.identSim, 0);
  assert.ok(signals.reqSim < DEFAULT_STALL_GATE.reqSim, `reqSim ${signals.reqSim}`);

  const log = [
    { round: 1, decision: "fix_required", verdicts: [], findings: [parent] },
    { round: 2, decision: "fix_required", verdicts: [], findings: [child] },
  ];
  const detection = detectStallClusters(log, undefined, DEFAULT_STALL_GATE);
  assert.deepEqual(
    detection.clusters.find((cluster) => cluster.members.includes("R2-001")).members,
    ["R2-001"],
    "requirement-only identifiers must not create a link",
  );
});

test("link gating: a parent verified_closed by this round keeps no parentOpen weight", () => {
  const parentFinding = {
    id: "R1-001",
    severity: "major",
    location: "src/app/Thing.swift:10",
    requirement: "设置页提交必须排空未落盘的合法输入",
    evidence: "pendingUpload flush 顺序未保证",
    required_fix: "drain first",
  };
  const unrelatedSameFile = {
    id: "R2-001",
    severity: "minor",
    location: "src/app/Thing.swift:40",
    requirement: "键盘动画开始时预滚动聚焦行",
    evidence: "keyboardAnimation focusRow",
    required_fix: "adjust keyboardAnimation",
  };
  // The parent is open when r2 starts but r2 itself closes it: with the
  // boundary gate (1.5) the sameFile match alone (1.0) must not link now that
  // parentOpen is computed from the current round's verdicts.
  const boundaryGate = { ...DEFAULT_STALL_GATE, linkThreshold: 1.5 };
  const closedNow = [
    { round: 1, decision: "fix_required", verdicts: [], findings: [parentFinding] },
    { round: 2, decision: "fix_required", verdicts: [{ id: "R1-001", verdict: "verified_closed" }], findings: [unrelatedSameFile] },
  ];
  const closed = detectStallClusters(closedNow, undefined, boundaryGate);
  assert.deepEqual(
    closed.clusters.find((cluster) => cluster.members.includes("R2-001")).members,
    ["R2-001"],
    "a parent verified_closed in the same round must not link through sameFile alone",
  );

  // Control: the same pair with a still-open parent links (sameFile + parentOpen).
  const stillOpen = [
    { round: 1, decision: "fix_required", verdicts: [], findings: [parentFinding] },
    { round: 2, decision: "fix_required", verdicts: [{ id: "R1-001", verdict: "partially_fixed" }], findings: [unrelatedSameFile] },
  ];
  const open = detectStallClusters(stillOpen, undefined, boundaryGate);
  assert.deepEqual(
    open.clusters.find((cluster) => cluster.members.includes("R2-001")).members,
    ["R1-001", "R2-001"],
  );

  // Shipped gate: the sameFile-only pair never reaches 1.75, open or closed.
  const shipped = detectStallClusters(stillOpen, undefined, DEFAULT_STALL_GATE);
  assert.deepEqual(shipped.clusters.find((cluster) => cluster.members.includes("R2-001")).members, ["R2-001"]);
});

test("candidates: a family that first becomes hot this round surfaces the round's unconnected findings", () => {
  const linked = (id, line) => ({
    id,
    severity: "major",
    location: `src/app/Same.swift:${line}`,
    requirement: "设置页提交必须排空未落盘的合法输入与待写队列",
    evidence: "flush 顺序未保证",
    required_fix: "drain first",
  });
  const unconnected = {
    id: "R2-002",
    severity: "minor",
    location: "src/core/Other.swift:9",
    requirement: "键盘动画开始时预滚动聚焦行",
    evidence: "keyboardAnimation focusRow",
    required_fix: "adjust keyboardAnimation",
  };
  const log = [
    { round: 1, decision: "fix_required", verdicts: [], findings: [linked("R1-001", 10)] },
    { round: 2, decision: "fix_required", verdicts: [], findings: [linked("R2-001", 20), unconnected] },
  ];
  const detection = detectStallClusters(log, undefined, DEFAULT_STALL_GATE);
  const family = detection.clusters.find((cluster) => cluster.members.includes("R1-001"));
  assert.deepEqual(family.members, ["R1-001", "R2-001"], "the new finding must link into the family");
  assert.ok(detection.candidates.some((candidate) => candidate.id === "R2-002"), `candidates ${detection.candidates.map((c) => c.id)}`);
  assert.ok(!detection.candidates.some((candidate) => candidate.id === "R2-001"), "connected findings are not candidates");

  // Same shape, but this round also closes the original member: the family was
  // alive when the round started, so the unconnected finding must still surface.
  const closingLog = [
    { round: 1, decision: "fix_required", verdicts: [], findings: [linked("R1-001", 10)] },
    {
      round: 2,
      decision: "fix_required",
      verdicts: [{ id: "R1-001", verdict: "verified_closed" }],
      findings: [linked("R2-001", 20), unconnected],
    },
  ];
  const closing = detectStallClusters(closingLog, undefined, DEFAULT_STALL_GATE);
  assert.ok(
    closing.candidates.some((candidate) => candidate.id === "R2-002"),
    `candidates ${closing.candidates.map((c) => c.id)}`,
  );
});

test("spec_blocked findings never drive stall triggers", () => {
  const specFinding = {
    id: "R1-001",
    severity: "major",
    location: "docs/plan.md:1",
    requirement: "口径未决的代码问题必须在计划中先定口径",
    evidence: "spec question",
    required_fix: "decide first",
  };
  const tail = [
    { round: 2, decision: "fix_required", verdicts: [{ id: "R1-001", verdict: "still_open" }], findings: [] },
    { round: 3, decision: "fix_required", verdicts: [{ id: "R1-001", verdict: "still_open" }], findings: [] },
    { round: 4, decision: "fix_required", verdicts: [{ id: "R1-001", verdict: "partially_fixed" }], findings: [] },
  ];
  const fromSpecBlocked = detectStallClusters(
    [{ round: 1, decision: "spec_blocked", verdicts: [], findings: [specFinding] }, ...tail],
    undefined,
    DEFAULT_STALL_GATE,
  );
  assert.equal(fromSpecBlocked.soft.fired, false);
  assert.equal(fromSpecBlocked.hard.fired, false);
  assert.deepEqual(fromSpecBlocked.hard.clusters, []);

  // Control: the same streak on a code-signal finding does fire — and hard always
  // names at least one cluster, so the escalation can render a family report.
  const fromCode = detectStallClusters(
    [{ round: 1, decision: "fix_required", verdicts: [], findings: [specFinding] }, ...tail],
    undefined,
    DEFAULT_STALL_GATE,
  );
  assert.equal(fromCode.hard.fired, true);
  assert.ok(fromCode.hard.clusters.length > 0, "hard fire must name a cluster");
  assert.ok(fromCode.clusters.some((cluster) => cluster.members.includes("R1-001")));
});

test("family report chains record verified_closed for closed members", () => {
  const base = {
    severity: "major",
    location: "src/app/Same.swift:10",
    requirement: "设置页提交必须排空未落盘的合法输入与待写队列",
    evidence: "flush 顺序未保证",
    required_fix: "drain first",
  };
  const log = [
    { round: 1, decision: "fix_required", verdicts: [], findings: [{ ...base, id: "R1-001" }] },
    { round: 2, decision: "fix_required", verdicts: [], findings: [{ ...base, id: "R2-001", location: "src/app/Same.swift:20" }] },
    {
      round: 3,
      decision: "fix_required",
      verdicts: [
        { id: "R1-001", verdict: "verified_closed" },
        { id: "R2-001", verdict: "still_open" },
      ],
      findings: [],
    },
  ];
  const detection = detectStallClusters(log, undefined, DEFAULT_STALL_GATE);
  const family = detection.clusters.find((cluster) => cluster.members.includes("R1-001"));
  const member = family.memberDetails.find((entry) => entry.id === "R1-001");
  assert.equal(member.last_verdict, "verified_closed");
  assert.equal(member.chain, "r3:verified_closed");
  assert.equal(member.last_round, 3);
  assert.equal(member.open, false);
});

test("hard family-span: a member born in the previous round keeps the two-round window open", () => {
  const member = (id, line) => ({
    id,
    severity: "major",
    location: `src/app/Same.swift:${line}`,
    requirement: "设置页提交必须排空未落盘的合法输入与待写队列",
    evidence: "flush 顺序未保证",
    required_fix: "drain first",
  });
  // Streak triggers are disabled so only the family-span window is under test.
  const gate = { ...DEFAULT_STALL_GATE, softStreak: 99, hardStreak: 99 };
  const log = [
    { round: 1, decision: "fix_required", verdicts: [], findings: [member("R1-001", 10)] },
    { round: 2, decision: "fix_required", verdicts: [], findings: [member("R2-001", 20)] },
    { round: 3, decision: "fix_required", verdicts: [], findings: [member("R3-001", 30)] },
    { round: 4, decision: "fix_required", verdicts: [], findings: [member("R4-001", 40)] },
    { round: 5, decision: "fix_required", verdicts: [], findings: [] },
  ];
  const detection = detectStallClusters(log, undefined, gate);
  assert.equal(detection.hard.fired, true, "r4 lies inside the r4-r5 window even though r5 added nothing");
  assert.ok(detection.hard.reasons.some((reason) => reason.startsWith("family-span:")));
  assert.ok(detection.hard.clusters.length > 0);
  const family = detection.clusters.find((cluster) => cluster.members.includes("R1-001"));
  assert.equal(family.span, 4);
  assert.equal(family.openMembers.length, 4);

  // Negative control: two quiet rounds later the window holds no new member.
  const later = [...log, { round: 6, decision: "fix_required", verdicts: [], findings: [] }];
  assert.equal(detectStallClusters(later, undefined, gate).hard.fired, false);
});

function taskState(overrides = {}) {
  return {
    schemaVersion: 1,
    workflowId: "00000000-0000-4000-8000-000000000000",
    projectRoot: "/repo",
    artifactDir: ".ai-dev-review/demo",
    plan: { snapshotPath: ".ai-dev-review/demo/inputs/plan-v1.md" },
    base: { head: "b".repeat(40) },
    config: { testCommands: ["node --test"], stallGate: { ...DEFAULT_STALL_GATE } },
    openIssues: [
      {
        id: "R01-001",
        severity: "major",
        location: "src/a.ts:1",
        requirement: "requirement",
        evidence: "evidence",
        required_fix: "fix",
        first_round: 1,
        last_review_round: 1,
        partial_streak: 0,
        rounds_open: 0,
      },
    ],
    stall: null,
    ...overrides,
  };
}

function stallFromFixture(file, throughRound) {
  const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"));
  const rounds = fixture.rounds.filter((round) => round.round <= throughRound);
  const detection = detectStallClusters(rounds, undefined, DEFAULT_STALL_GATE);
  const keys = new Set([...detection.soft.clusters, ...detection.hard.clusters]);
  return {
    detection,
    stall: {
      round: detection.round,
      soft: detection.soft,
      hard: detection.hard,
      candidates: detection.candidates,
      families: detection.clusters.filter((cluster) => keys.has(cluster.key)),
    },
  };
}

test("zero injection: a non-firing round is byte-identical with the gate on or off", () => {
  const enabled = taskState();
  const disabled = taskState({
    config: { testCommands: ["node --test"], stallGate: { ...DEFAULT_STALL_GATE, enabled: false } },
  });
  for (const round of [1, 2, 3]) {
    assert.equal(
      makeDeveloperTask(enabled, {}, round, null, null),
      makeDeveloperTask(disabled, {}, round, null, null),
      `developer task r${round} must not change when detection is off`,
    );
    assert.equal(
      makeReviewerTask(enabled, {}, round, "handoffs/developer-r01.md"),
      makeReviewerTask(disabled, {}, round, "handoffs/developer-r01.md"),
      `reviewer task r${round} must not change when detection is off`,
    );
  }
  assert.ok(!makeDeveloperTask(enabled, {}, 2, null, null).includes("Stall-family acceptance criteria"));
  assert.ok(!makeReviewerTask(enabled, {}, 2, "dev.md").includes("Unlinked-candidate confirmation"));
});

test("injection: soft fire adds the family directive, candidates add the confirm/separate section", () => {
  const soft = stallFromFixture("stalled-family-reminder-errors.json", 4);
  assert.equal(soft.detection.soft.fired, true);
  const softState = taskState({ stall: soft.stall });

  const directiveTask = makeDeveloperTask(softState, {}, 5, null, null);
  assert.ok(directiveTask.includes("Stall-family acceptance criteria"));
  assert.ok(directiveTask.includes("R1-003"));
  assert.ok(directiveTask.includes("Accept this family as a whole"));
  // The signal belongs to the review that produced it, never to its own round.
  assert.ok(!makeDeveloperTask(softState, {}, 4, null, null).includes("Stall-family acceptance criteria"));

  // A stale signal cannot leak through a disabled gate.
  const disabledState = taskState({
    stall: soft.stall,
    config: { testCommands: ["node --test"], stallGate: { ...DEFAULT_STALL_GATE, enabled: false } },
  });
  assert.ok(!makeDeveloperTask(disabledState, {}, 5, null, null).includes("Stall-family acceptance criteria"));
  assert.ok(!makeReviewerTask(disabledState, {}, 5, "dev.md").includes("Unlinked-candidate confirmation"));

  const candidates = stallFromFixture("stalled-family-exit-gate.json", 16);
  assert.ok(candidates.detection.candidates.some((candidate) => candidate.id === "R16-001"));
  const candidateState = taskState({ stall: candidates.stall });
  const reviewerTask = makeReviewerTask(candidateState, {}, 17, "handoffs/developer-r17.md");
  assert.ok(reviewerTask.includes("Unlinked-candidate confirmation"));
  assert.ok(reviewerTask.includes("R16-001"));
  assert.ok(reviewerTask.includes("repeat_of"));
  assert.ok(!makeReviewerTask(candidateState, {}, 16, "dev.md").includes("Unlinked-candidate confirmation"));
});

test("injection: both compensation texts are English-only and fully substituted", () => {
  const soft = stallFromFixture("stalled-family-reminder-errors.json", 4);
  const directiveTask = makeDeveloperTask(taskState({ stall: soft.stall }), {}, 5, null, null);
  assert.ok(directiveTask.includes("Accept this family as a whole"), "criteria present");
  assert.ok(directiveTask.includes("still open"), "family summary");
  assert.ok(!directiveTask.includes("{families}"), "family placeholder must be substituted everywhere");

  const candidates = stallFromFixture("stalled-family-exit-gate.json", 16);
  const reviewerTask = makeReviewerTask(taskState({ stall: candidates.stall }), {}, 17, "handoffs/developer-r17.md");
  assert.ok(reviewerTask.includes("Confirm or separate each of them"), "criteria present");
  assert.equal(reviewerTask.match(/repeat_of/g).length, 1, "declared exactly once");
  assert.ok(!reviewerTask.includes("{family}"), "family placeholder must be substituted");
  assert.ok(!reviewerTask.includes("{candidates}"));

  // English-only: no parallel Chinese copy that could drift from the English
  // wording. The family/candidate data lines are excluded on purpose — their
  // requirement text follows the frozen plan's language, not this one.
  assert.ok(!/[\u4e00-\u9fff]/.test(STALL_DIRECTIVE), "directive template must stay English-only");
  assert.ok(!/[\u4e00-\u9fff]/.test(STALL_CANDIDATES), "candidate template must stay English-only");
});

test("injection: `$&`-style sequences in finding text survive substitution literally", () => {
  const requirement = "价格 $& 与 $1 和 $' 必须原样保留";
  const section = renderStallCandidateSection([
    {
      family: "R1-001",
      id: "R9-001",
      severity: "major",
      location: "src/a.ts:1",
      first_round: 9,
      last_verdict: "new",
      requirement,
    },
  ]);
  assert.ok(section.includes(requirement), "requirement text must not be rewritten by the replacer");
  assert.ok(!section.includes("{candidates}"));
  assert.ok(renderStallDirective([{ key: "R1-001", span: 2, members: ["R1-001"], openMembers: ["R1-001"], memberDetails: [] }]).includes("still open"));
});

test("config off: stallGate.enabled=false yields zero triggers, zero clusters, zero candidates", () => {
  for (const { name, fixture } of fixtures) {
    const detection = detectStallClusters(fixture, undefined, { enabled: false });
    assert.equal(detection.round, null, `${name}: round`);
    assert.deepEqual(detection.soft, { fired: false, reasons: [], clusters: [] }, `${name}: soft`);
    assert.deepEqual(detection.hard, { fired: false, reasons: [], clusters: [] }, `${name}: hard`);
    assert.deepEqual(detection.clusters, [], `${name}: clusters`);
    assert.deepEqual(detection.candidates, [], `${name}: candidates`);
  }
  assert.equal(normalizeStallGate(undefined).enabled, true);
  assert.equal(normalizeStallGate({ enabled: false }).enabled, false);
  assert.equal(normalizeStallGate({ softStreak: 0 }).softStreak, DEFAULT_STALL_GATE.softStreak);
  assert.equal(normalizeStallGate({ stallGate: { softStreak: 4 } }).softStreak, 4);
  // An empty log (old instances without findings.jsonl) never fires and never throws.
  assert.equal(detectStallClusters([], undefined, DEFAULT_STALL_GATE).round, null);
  assert.equal(detectStallClusters(undefined, undefined, DEFAULT_STALL_GATE).round, null);
});

test("evaluation only follows fix_required: a spec_blocked tail never re-fires a stale signal", () => {
  const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, "stalled-family-reminder-errors.json"), "utf8"));
  const throughR4 = fixture.rounds.filter((round) => round.round <= 4);
  const fired = detectStallClusters(throughR4, undefined, DEFAULT_STALL_GATE);
  assert.equal(fired.soft.fired, true);

  const withSpecBlockedTail = [...throughR4, { round: 5, decision: "spec_blocked", verdicts: [], findings: [] }];
  const tail = detectStallClusters(withSpecBlockedTail, undefined, DEFAULT_STALL_GATE);
  assert.equal(tail.round, null);
  assert.equal(tail.soft.fired, false);
  assert.equal(tail.hard.fired, false);

  // Append-only logs can repeat a round after a resumed review; the last
  // record wins so verdict streaks are not double-counted.
  const duplicated = [...throughR4, throughR4[throughR4.length - 1]];
  assert.deepEqual(detectStallClusters(duplicated, undefined, DEFAULT_STALL_GATE).soft, fired.soft);
});

test("repeat_of: a declared finding joins the family and leaves the candidate list for good", () => {
  const finding = (id, requirement, location, extra = {}) => ({
    id,
    severity: "major",
    location,
    requirement,
    evidence: `证据 ${id} 的现象描述`,
    required_fix: `修复 ${id}`,
    ...extra,
  });
  const baseRequirement = "设置页提交必须排空未落盘的合法输入与待写队列";
  const log = [
    { round: 1, decision: "fix_required", verdicts: [], findings: [finding("R1-001", baseRequirement, "src/app/Home.swift:10")] },
    {
      round: 2,
      decision: "fix_required",
      verdicts: [{ id: "R1-001", verdict: "still_open" }],
      findings: [finding("R2-001", baseRequirement, "src/app/Home.swift:20")],
    },
    {
      round: 3,
      decision: "fix_required",
      verdicts: [{ id: "R1-001", verdict: "still_open" }, { id: "R2-001", verdict: "still_open" }],
      findings: [
        finding("R3-001", "键盘动画开始时预滚动聚焦行", "src/core/Keyboard.swift:5"),
        finding("R3-002", "输入校验必须规范化千分位", "src/core/Input.swift:7", { repeat_of: "R1-001" }),
      ],
    },
    {
      round: 4,
      decision: "fix_required",
      verdicts: [
        { id: "R1-001", verdict: "still_open" },
        { id: "R2-001", verdict: "still_open" },
        { id: "R3-001", verdict: "still_open" },
        { id: "R3-002", verdict: "still_open" },
      ],
      findings: [finding("R4-001", "文档截图索引需要更新", "docs/index.md:3")],
    },
  ];

  const at3 = detectStallClusters(log.slice(0, 3), undefined, DEFAULT_STALL_GATE);
  assert.deepEqual(at3.candidates.map((candidate) => candidate.id), ["R3-001"]);
  const family = at3.clusters.find((cluster) => cluster.members.includes("R1-001"));
  assert.ok(family.members.includes("R3-002"), "declared repeat_of must join the family");

  const at4 = detectStallClusters(log, undefined, DEFAULT_STALL_GATE);
  assert.ok(!at4.candidates.some((candidate) => candidate.id === "R3-002"), "declared finding must not reappear as a candidate");
  assert.ok(at4.candidates.some((candidate) => candidate.id === "R4-001"));

  // Optional schema field: present when supplied, absent otherwise.
  const existing = [{ id: "R1-001", severity: "major", location: "src/app/Home.swift:10", requirement: baseRequirement, evidence: "e", required_fix: "f", first_round: 1, last_review_round: 1, last_verdict: "new", partial_streak: 0, rounds_open: 0 }];
  const report = normalizeReviewerReport(
    {
      decision: "fix_required",
      summary: "still churning",
      previous_issue_verdicts: [{ id: "R1-001", verdict: "still_open", evidence: "not fixed" }],
      new_findings: [
        {
          id: "R2-001",
          severity: "major",
          location: "src/app/Home.swift:20",
          requirement: baseRequirement,
          evidence: "same path",
          required_fix: "drain first",
          repeat_of: "R1-001",
        },
      ],
      tests: [],
      spec_questions: [],
      handoff_to_developer: "fix",
    },
    2,
    existing,
  );
  assert.equal(report.new_findings[0].repeat_of, "R1-001");

  const withoutRepeat = normalizeReviewerReport(
    {
      decision: "fix_required",
      summary: "still churning",
      previous_issue_verdicts: [{ id: "R1-001", verdict: "still_open", evidence: "not fixed" }],
      new_findings: [
        { id: "R2-001", severity: "major", location: "src/app/Home.swift:20", requirement: baseRequirement, evidence: "same path", required_fix: "drain first" },
      ],
      tests: [],
      spec_questions: [],
      handoff_to_developer: "fix",
    },
    2,
    existing,
  );
  assert.ok(!("repeat_of" in withoutRepeat.new_findings[0]));
});

// ---- Engine integration ---------------------------------------------------

async function gitFixture(prefix) {
  const tempRoot = await mkdtemp(join(tmpdir(), prefix));
  const root = realpathSync(tempRoot);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  await writeFile(join(root, "PLAN.md"), "# Plan\n", "utf8");
  return root;
}

function developerReport(round) {
  return {
    status: "done",
    summary: `round ${round} implemented`,
    changed_files: [],
    requirements_covered: [],
    resolved_issues: [],
    tests: [],
    assumptions: [],
    risks: [],
    handoff_to_reviewer: "check",
    blockers: [],
  };
}

function reviewerReport({ round, verdicts = [], findings = [], decision = "fix_required", specQuestions = [] }) {
  return {
    decision,
    summary: `round ${round} review`,
    previous_issue_verdicts: verdicts,
    new_findings: findings,
    tests: [],
    spec_questions: specQuestions,
    handoff_to_developer: "continue",
  };
}

test("engine: soft fire injects the developer directive and records the log/timeline/stallEvents", async () => {
  const root = await gitFixture("dev-review-stall-soft-");
  const tasks = [];
  try {
    const requirement = "设置页提交必须排空未落盘的合法输入与待写队列";
    const scriptedReviewer = new Map([
      [1, reviewerReport({
        round: 1,
        findings: [{ id: "R1-001", severity: "major", location: "src/app/Home.swift:10", requirement, evidence: "flush before drain", required_fix: "drain first" }],
      })],
      [2, reviewerReport({
        round: 2,
        verdicts: [{ id: "R1-001", verdict: "partially_fixed", evidence: "still racing" }],
        findings: [{ id: "R2-001", severity: "major", location: "src/app/Home.swift:20", requirement, evidence: "second path", required_fix: "drain first" }],
      })],
      [3, reviewerReport({
        round: 3,
        verdicts: [
          { id: "R1-001", verdict: "partially_fixed", evidence: "still racing" },
          { id: "R2-001", verdict: "partially_fixed", evidence: "still racing" },
        ],
      })],
      [4, reviewerReport({
        round: 4,
        decision: "pass",
        verdicts: [
          { id: "R1-001", verdict: "verified_closed", evidence: "drained" },
          { id: "R2-001", verdict: "verified_closed", evidence: "drained" },
        ],
      })],
    ]);

    const result = await runCommand({
      args: "start PLAN.md --allow-dirty --developer-model fake/dev --reviewer-model fake/rev",
      cwd: root,
      notify: () => {},
      onReport: async () => {},
      invokeAgent: async ({ role, round, task }) => {
        tasks.push({ role, round, task });
        const report = role === "developer" ? developerReport(round) : scriptedReviewer.get(round);
        assert.ok(report, `unscripted ${role} round ${round}`);
        return { finalText: JSON.stringify(report), usage: null };
      },
    });

    assert.equal(result.state.status, "passed");

    const developerTask = (round) => tasks.find((entry) => entry.role === "developer" && entry.round === round).task;
    assert.ok(!developerTask(1).includes("Stall-family acceptance criteria"));
    assert.ok(!developerTask(2).includes("Stall-family acceptance criteria"));
    assert.ok(!developerTask(3).includes("Stall-family acceptance criteria"));
    assert.ok(developerTask(4).includes("Stall-family acceptance criteria"), "round 4 developer task must carry the family directive");
    assert.ok(developerTask(4).includes("R1-001"));

    const logLines = (await readFile(join(result.paths.reports, "findings.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(logLines.map((line) => line.round), [1, 2, 3, 4]);
    assert.equal(logLines[2].decision, "fix_required");
    assert.equal(logLines[2].verdicts[0].verdict, "partially_fixed");

    assert.equal(result.state.stall.round, 3);
    assert.equal(result.state.stall.soft.fired, true);
    assert.ok(result.state.stall.families.some((family) => family.members.includes("R1-001")));
    const softEvent = result.state.stallEvents.find((event) => event.kind === "soft");
    assert.ok(softEvent);
    assert.equal(softEvent.injected, true);
    assert.ok(softEvent.members.includes("R1-001") && softEvent.members.includes("R2-001"), JSON.stringify(softEvent.members));

    const timeline = await readFile(join(result.paths.reports, "timeline.md"), "utf8");
    assert.match(timeline, /· r3 · stall-soft · \*\*fired\*\*/);
    assert.match(timeline, /成员 R1-001, R2-001/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function stallReadyFixture(stallGate, overrides = {}) {
  const root = await gitFixture("dev-review-stall-hard-");
  const artifact = join(root, ".ai-dev-review", "demo--abc12345");
  await mkdir(join(artifact, "inputs"), { recursive: true });
  await writeFile(join(artifact, "inputs", "plan-v1.md"), "# plan\n", "utf8");
  await writeFile(
    join(root, ".ai-dev-review", "active-workflow.json"),
    JSON.stringify({ schemaVersion: 1, workflowKey: "demo--abc12345", artifactDir: ".ai-dev-review/demo--abc12345" }),
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
        developerThinking: null,
        reviewerThinking: null,
        maxReviewRounds: 10,
        developerResetAfterRounds: 4,
        agentRetries: 0,
        testCommands: [],
        stallGate,
        ...overrides,
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

test("engine: hard fire escalates stalled-issue-family with the family report and three options", async () => {
  const root = await stallReadyFixture({ ...DEFAULT_STALL_GATE, hardStreak: 1 });
  try {
    const requirement = "设置页提交必须排空未落盘的合法输入与待写队列";
    const result = await runCommand({
      args: "run",
      cwd: root,
      notify: () => {},
      onReport: async () => {},
      invokeAgent: async ({ role, round }) => {
        if (role === "developer") return { finalText: JSON.stringify(developerReport(round)), usage: null };
        if (round === 1) {
          return {
            finalText: JSON.stringify(reviewerReport({
              round: 1,
              findings: [{ id: "R1-001", severity: "major", location: "src/app/Home.swift:10", requirement, evidence: "flush before drain", required_fix: "drain first" }],
            })),
            usage: null,
          };
        }
        return {
          finalText: JSON.stringify(reviewerReport({
            round,
            verdicts: [{ id: "R1-001", verdict: "partially_fixed", evidence: "still racing" }],
          })),
          usage: null,
        };
      },
    });

    assert.equal(result.state.status, "blocked");
    assert.equal(result.state.blocked.reason, "stalled-issue-family");
    const hardEvent = result.state.stallEvents.find((event) => event.kind === "hard");
    assert.ok(hardEvent);
    assert.equal(hardEvent.injected, false);
    assert.deepEqual(hardEvent.members, ["R1-001"]);

    const timeline = await readFile(join(result.paths.reports, "timeline.md"), "utf8");
    assert.match(timeline, /· r2 · stall-hard · \*\*fired\*\*/);
    assert.match(timeline, /成员 R1-001/);

    const escalation = await readFile(join(root, result.state.blocked.escalationPath), "utf8");
    assert.match(escalation, /停滞家族报告/);
    assert.match(escalation, /家族 R1-001/);
    assert.match(escalation, /授权一轮钉死范围的系统性修复/);
    assert.match(escalation, /登记为已知限制并顺延到后续批次/);
    assert.match(escalation, /修订计划\/口径/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("engine: a spec_blocked finding cannot escalate stalled-issue-family", async () => {
  const root = await stallReadyFixture(
    { ...DEFAULT_STALL_GATE, softStreak: 1, hardStreak: 1, softSpan: 99, hardSpan: 99 },
    { maxReviewRounds: 2 },
  );
  try {
    const specFinding = {
      id: "R1-001",
      severity: "major",
      location: "docs/plan.md:1",
      requirement: "口径未决的代码问题必须在计划中先定口径",
      evidence: "spec question",
      required_fix: "decide first",
    };
    const invokeAgent = async ({ role, round }) => {
      if (role === "developer") return { finalText: JSON.stringify(developerReport(round)), usage: null };
      if (round === 1) {
        return {
          finalText: JSON.stringify(reviewerReport({
            round: 1,
            decision: "spec_blocked",
            findings: [specFinding],
            specQuestions: [{ question: "口径如何定？", why: "计划未写明", options: ["A", "B"] }],
          })),
          usage: null,
        };
      }
      return {
        finalText: JSON.stringify(reviewerReport({
          round,
          verdicts: [{ id: "R1-001", verdict: "still_open", evidence: "spec answer pending" }],
        })),
        usage: null,
      };
    };

    let result = await runCommand({ args: "run", cwd: root, notify: () => {}, onReport: async () => {}, invokeAgent });
    assert.equal(result.state.blocked.reason, "reviewer-spec-blocked");

    result = await runCommand({ args: "resolve --choose continue --note test", cwd: root, notify: () => {}, onReport: async () => {} });
    assert.equal(result.ok, true);

    result = await runCommand({ args: "run", cwd: root, notify: () => {}, onReport: async () => {}, invokeAgent });
    assert.notEqual(result.state.blocked?.reason, "stalled-issue-family");
    assert.equal(result.state.blocked.reason, "max-rounds");
    assert.ok(!(result.state.stallEvents || []).some((event) => event.kind === "hard"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
