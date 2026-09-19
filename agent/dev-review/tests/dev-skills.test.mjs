import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeDevSkills, runCommand } from "../workflow.mjs";

// Records argv per session so the test can assert exactly what the developer and
// reviewer processes received, then answers with a protocol-valid report.
const FAKE_PI = `
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const model = args[args.indexOf("--model") + 1] || "";
const sessionId = args[args.indexOf("--session-id") + 1] || "unknown";
const developer = model.includes("dev");
writeFileSync(\`\${process.env.FAKE_PI_STATE_DIR}/argv-\${sessionId}.json\`, JSON.stringify(args));

const report = developer
  ? { status: "done", summary: "implemented", changed_files: [], requirements_covered: [], resolved_issues: [], tests: [], assumptions: [], risks: [], handoff_to_reviewer: "check", blockers: [] }
  : { decision: "pass", summary: "looks good", previous_issue_verdicts: [], new_findings: [], spec_questions: [], handoff_to_developer: "none" };

const write = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 10, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
write({ type: "message_start", message: { role: "assistant", content: [], timestamp: Date.now() - 200 } });
write({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(report) }], stopReason: "stop", usage } });
`;

async function writeSkill(dir, name = "guide") {
  const skill = join(dir, name);
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), `---\nname: ${name}\ndescription: test skill\n---\n\n# ${name}\n`, "utf8");
  return realpathSync(skill);
}

async function skillsFixture() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "dev-review-skills-")));
  const stateDir = realpathSync(await mkdtemp(join(tmpdir(), "dev-review-skills-state-")));
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

function scoreArgs(argv) {
  const skills = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--skill") skills.push(argv[index + 1]);
  }
  return { skills, noSkills: argv.includes("--no-skills") };
}

test("normalizeDevSkills: resolves, expands ~, dedupes, and rejects bad paths", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "dev-review-normalize-")));
  const home = realpathSync(await mkdtemp(join(tmpdir(), "dev-review-home-")));
  try {
    const skill = await writeSkill(join(root, "skills"), "swiftui-specialist");
    assert.deepEqual(normalizeDevSkills(["skills/swiftui-specialist"], root), [skill]);
    assert.deepEqual(normalizeDevSkills(["./skills/swiftui-specialist", skill], root), [skill], "duplicates collapse");
    assert.equal(normalizeDevSkills(undefined, root), undefined);
    assert.equal(normalizeDevSkills([], root), undefined);

    const homeSkill = await writeSkill(home, "global-skill");
    assert.deepEqual(normalizeDevSkills(["~/global-skill"], root, { home }), [homeSkill]);

    const fileSkill = join(root, "single.md");
    await writeFile(fileSkill, "# single-file skill\n", "utf8");
    assert.deepEqual(normalizeDevSkills([fileSkill], root), [fileSkill], "pi --skill also accepts a skill file");

    assert.throws(() => normalizeDevSkills(["skills/missing"], root), /does not exist/);
    await mkdir(join(root, "not-a-skill"), { recursive: true });
    assert.throws(() => normalizeDevSkills(["not-a-skill"], root), /has no SKILL\.md/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("run: --dev-skill reaches the developer process only and is frozen in state", async () => {
  const { root, stateDir, script } = await skillsFixture();
  try {
    const skill = await writeSkill(join(root, "skills"), "swiftui-specialist");
    const result = await runWithEnv({
      DEV_REVIEW_DEVELOPER_MODEL: "fake/dev",
      DEV_REVIEW_REVIEWER_MODEL: "fake/rev",
      FAKE_PI_STATE_DIR: stateDir,
    }, () => runCommand({
      args: `start PLAN.md --allow-dirty --dev-skill ${JSON.stringify(skill)}`,
      cwd: root,
      piInvocation: { command: process.execPath, args: [script] },
      notify: () => {},
      onReport: async () => {},
    }));

    assert.equal(result.state.status, "passed");
    assert.deepEqual(result.state.config.devSkills, [skill]);

    const developer = scoreArgs(JSON.parse(await readFile(join(stateDir, "argv-developer-g1.json"), "utf8")));
    const reviewer = scoreArgs(JSON.parse(await readFile(join(stateDir, "argv-reviewer-r01.json"), "utf8")));
    assert.deepEqual(developer.skills, [skill]);
    assert.ok(developer.noSkills, "developer still runs with --no-skills (no local discovery)");
    assert.deepEqual(reviewer.skills, [], "reviewer never receives skills");
    assert.ok(reviewer.noSkills);

    const status = await runCommand({ args: "status", cwd: root });
    assert.match(status.message, /Dev skills: .*swiftui-specialist/);

    const timeline = await readFile(join(result.paths.reports, "timeline.md"), "utf8");
    assert.match(timeline, /Developer skills \(--skill\): .*swiftui-specialist/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("run: skill paths containing spaces survive the CLI tokenizer", async () => {
  const { root, stateDir, script } = await skillsFixture();
  try {
    const skill = await writeSkill(join(root, "skills dir"), "my skill");
    const result = await runWithEnv({
      DEV_REVIEW_DEVELOPER_MODEL: "fake/dev",
      DEV_REVIEW_REVIEWER_MODEL: "fake/rev",
      FAKE_PI_STATE_DIR: stateDir,
    }, () => runCommand({
      args: `start PLAN.md --allow-dirty --dev-skill ${JSON.stringify(skill)}`,
      cwd: root,
      piInvocation: { command: process.execPath, args: [script] },
      notify: () => {},
      onReport: async () => {},
    }));

    assert.deepEqual(result.state.config.devSkills, [skill]);
    const developer = scoreArgs(JSON.parse(await readFile(join(stateDir, "argv-developer-g1.json"), "utf8")));
    assert.deepEqual(developer.skills, [skill]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("run: a missing --dev-skill path fails fast before any agent runs", async () => {
  const { root, stateDir, script } = await skillsFixture();
  try {
    const result = await runWithEnv({
      DEV_REVIEW_DEVELOPER_MODEL: "fake/dev",
      DEV_REVIEW_REVIEWER_MODEL: "fake/rev",
      FAKE_PI_STATE_DIR: stateDir,
    }, () => runCommand({
      args: "start PLAN.md --allow-dirty --dev-skill skills/typo",
      cwd: root,
      piInvocation: { command: process.execPath, args: [script] },
      notify: () => {},
      onReport: async () => {},
    }));

    assert.equal(result.ok, false);
    assert.match(result.message, /--dev-skill path does not exist: skills\/typo/);
    assert.equal(existsSync(join(stateDir, "argv-developer-g1.json")), false, "no agent was spawned");
    assert.equal(existsSync(join(root, ".ai-dev-review")), false, "nothing was initialized");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("run: --dev-skill on resume replaces the frozen list before the next round", async () => {
  const { root, stateDir, script } = await skillsFixture();
  try {
    const first = await writeSkill(join(root, "skills"), "first");
    const second = await writeSkill(join(root, "skills"), "second");
    const env = {
      DEV_REVIEW_DEVELOPER_MODEL: "fake/dev",
      DEV_REVIEW_REVIEWER_MODEL: "fake/rev",
      FAKE_PI_STATE_DIR: stateDir,
    };
    const inited = await runWithEnv(env, () => runCommand({
      args: `init PLAN.md --allow-dirty --dev-skill ${JSON.stringify(first)}`,
      cwd: root,
      piInvocation: { command: process.execPath, args: [script] },
      notify: () => {},
      onReport: async () => {},
    }));
    assert.deepEqual(inited.state.config.devSkills, [first]);

    const resumed = await runWithEnv(env, () => runCommand({
      args: `run --dev-skill ${JSON.stringify(second)}`,
      cwd: root,
      piInvocation: { command: process.execPath, args: [script] },
      notify: () => {},
      onReport: async () => {},
    }));
    assert.equal(resumed.state.status, "passed");
    assert.deepEqual(resumed.state.config.devSkills, [second]);
    const developer = scoreArgs(JSON.parse(await readFile(join(stateDir, "argv-developer-g1.json"), "utf8")));
    assert.deepEqual(developer.skills, [second], "the replacement applied to the round that ran after resume");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("configure: --dev-skill replaces the frozen list and validates it", async () => {
  const { root, stateDir, script } = await skillsFixture();
  try {
    const first = await writeSkill(join(root, "skills"), "first");
    const second = await writeSkill(join(root, "skills"), "second");
    const env = {
      DEV_REVIEW_DEVELOPER_MODEL: "fake/dev",
      DEV_REVIEW_REVIEWER_MODEL: "fake/rev",
      FAKE_PI_STATE_DIR: stateDir,
    };
    const started = await runWithEnv(env, () => runCommand({
      args: `start PLAN.md --allow-dirty --dev-skill ${JSON.stringify(first)}`,
      cwd: root,
      piInvocation: { command: process.execPath, args: [script] },
      notify: () => {},
      onReport: async () => {},
    }));
    assert.deepEqual(started.state.config.devSkills, [first]);

    const reconfigured = await runWithEnv(env, () => runCommand({
      args: `configure --dev-skill ${JSON.stringify(second)}`,
      cwd: root,
      piInvocation: { command: process.execPath, args: [script] },
      notify: () => {},
      onReport: async () => {},
    }));
    assert.deepEqual(reconfigured.state.config.devSkills, [second]);

    const failed = await runWithEnv(env, () => runCommand({
      args: "configure --dev-skill skills/nope",
      cwd: root,
      piInvocation: { command: process.execPath, args: [script] },
      notify: () => {},
      onReport: async () => {},
    }));
    assert.equal(failed.ok, false);
    assert.match(failed.message, /does not exist/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});
