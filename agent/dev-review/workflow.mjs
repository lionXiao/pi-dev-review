#!/usr/bin/env node

/**
 * Deterministic coordinator for a two-role Pi workflow.
 *
 * The coordinator, not either model, owns state transitions and writes the
 * handoff artifacts. Agent processes exchange only their final structured
 * reports; raw Pi transcripts stay in the developer's private session dir.
 */

import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCHEMA_VERSION = 1;
const DEFAULT_ARTIFACT_DIR = ".ai-dev-review";
const DEFAULT_MAX_ROUNDS = 10;
const DEFAULT_DEVELOPER_RESET_AFTER_ROUNDS = 4;
const DEV_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const REVIEW_TOOLS = ["read", "grep", "find", "ls", "bash"];
const ROLE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts");
const DEV_ROLE_PROMPT = path.join(ROLE_DIR, "developer.md");
const REVIEW_ROLE_PROMPT = path.join(ROLE_DIR, "reviewer.md");
const PROJECT_DEFAULTS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "defaults.json");
const LOCAL_DEFAULTS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "local.json");

const HELP = `
/dev-review init <plan.md> --developer-model <provider/model> --reviewer-model <provider/model> [options]
/dev-review start <plan.md> --developer-model <provider/model> --reviewer-model <provider/model> [options]
/dev-review run [--workflow <workflow-id>]
/dev-review status [--workflow <workflow-id>]
/dev-review list
/dev-review use <workflow-id>
/dev-review adopt [--workflow <workflow-id>]
/dev-review resolve [<human-decision.md>] [--choose <choice>] [--note <notes>] [--max-rounds <n>] [--workflow <workflow-id>]
/dev-review unlock [--note <why>] [--workflow <workflow-id>]
/dev-review configure [--developer-model <provider/model>] [--reviewer-model <provider/model>] [--max-rounds <n>]

Options for init/configure:
  --workflow <label>                Human-readable workflow label; default derives from the PRD filename
  --artifact-dir <dir>              Explicit artifact directory; otherwise uses ${DEFAULT_ARTIFACT_DIR}/<prd-name>--<plan-hash>
  --max-rounds <n>                  Developer+review cycles before human escalation (default: ${DEFAULT_MAX_ROUNDS})
  --developer-reset-after <n>       Rotate the developer's private Pi session after n rounds (default: ${DEFAULT_DEVELOPER_RESET_AFTER_ROUNDS})
  --test <command>                  Required test command; repeatable
  --developer-thinking <level>      Pi thinking level for the developer
  --reviewer-thinking <level>       Pi thinking level for the reviewer
  --allow-dirty                     Permit initializing from an already dirty worktree

The developer and reviewer model values must be different. Models are never
stored with credentials; Pi continues to use its normal provider auth.
`;

function now() {
  return new Date().toISOString();
}

/**
 * Human-facing timestamps for markdown artifacts (timeline, handoffs,
 * escalation, final report) use the machine's local timezone; JSON state files
 * keep ISO/UTC so comparisons and resume logic stay timezone-independent.
 */
function localNow(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function localTimezoneLabel(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const pad = (value) => String(value).padStart(2, "0");
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  return `${zone} (UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)})`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashBuffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

function relativeTo(root, target) {
  const result = path.relative(root, target);
  return result || ".";
}

function markdownCode(value) {
  return `\`${String(value).replaceAll("`", "\\`")}\``;
}

function markdownList(items, empty = "None.") {
  if (!items || items.length === 0) return `- ${empty}`;
  return items.map((item) => `- ${String(item)}`).join("\n");
}

function asString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function asOptionalString(value, field) {
  if (value === undefined || value === null || value === "") return "";
  return asString(value, field);
}

function asObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function asStringArray(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function enumValue(value, field, allowed) {
  if (!allowed.includes(value)) {
    throw new Error(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function numberOption(value, name, minimum = 1) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function splitArguments(input) {
  if (Array.isArray(input)) return [...input];
  const source = String(input || "").trim();
  if (!source) return [];

  const tokens = [];
  let current = "";
  let quote = null;
  let escaped = false;

  for (const character of source) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Unclosed quote in command arguments");
  if (current) tokens.push(current);
  return tokens;
}

function parseOptions(tokens) {
  const positionals = [];
  const options = { tests: [] };
  const takesValue = new Set([
    "--developer-model",
    "--reviewer-model",
    "--artifact-dir",
    "--workflow",
    "--max-rounds",
    "--developer-reset-after",
    "--test",
    "--choose",
    "--note",
    "--developer-thinking",
    "--reviewer-thinking",
  ]);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--allow-dirty") {
      options.allowDirty = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (takesValue.has(token)) {
      const value = tokens[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
      index += 1;
      if (token === "--test") options.tests.push(value);
      else if (token === "--developer-model") options.developerModel = value;
      else if (token === "--reviewer-model") options.reviewerModel = value;
      else if (token === "--artifact-dir") options.artifactDir = value;
      else if (token === "--workflow") options.workflow = value;
      else if (token === "--max-rounds") options.maxRounds = numberOption(value, token);
      else if (token === "--developer-reset-after") options.developerResetAfterRounds = numberOption(value, token);
      else if (token === "--developer-thinking") options.developerThinking = value;
      else if (token === "--reviewer-thinking") options.reviewerThinking = value;
      else if (token === "--choose") options.choose = value;
      else if (token === "--note") options.note = value;
      continue;
    }
    if (token.startsWith("--")) throw new Error(`Unknown option: ${token}`);
    positionals.push(token);
  }

  return { positionals, options };
}

function runGit(cwd, args, { allowFailure = false } = {}) {
  // Large diffs (e.g. re-recorded binary snapshot baselines) can exceed the
  // default 1MB spawnSync maxBuffer and abort with ENOBUFS mid-round.
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (result.error) throw new Error(`Could not run git ${args.join(" ")}: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    const details = String(result.stderr || result.stdout || "unknown git error").trim();
    throw new Error(`git ${args.join(" ")} failed: ${details}`);
  }
  return String(result.stdout || "").trim();
}

function gitRoot(cwd) {
  return runGit(cwd, ["rev-parse", "--show-toplevel"]);
}

function gitHead(cwd) {
  return runGit(cwd, ["rev-parse", "HEAD"]);
}

function gitRemoteOrigin(cwd) {
  const result = spawnSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" });
  return result.status === 0 ? String(result.stdout || "").trim() || null : null;
}

function gitCommitExists(cwd, commit) {
  const result = spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd, encoding: "utf8" });
  return result.status === 0;
}

function gitStatus(cwd) {
  return runGit(cwd, ["status", "--porcelain=v1", "-uall"]);
}

async function ensureLocalArtifactExclude(projectRoot, artifactRoot) {
  const relative = relativeTo(projectRoot, artifactRoot).replaceAll("\\", "/").replace(/\/+$/, "");
  if (!relative || relative === "." || relative === ".." || relative.startsWith("../")) return;
  const pattern = `${relative}/`;
  const gitPath = runGit(projectRoot, ["rev-parse", "--git-path", "info/exclude"]);
  const excludePath = path.isAbsolute(gitPath) ? gitPath : path.resolve(projectRoot, gitPath);
  let content = "";
  try {
    content = await readFile(excludePath, "utf8");
  } catch {
    // A new worktree can legitimately have no info/exclude file yet.
  }
  if (content.split(/\r?\n/).includes(pattern)) return;
  const marker = "# Personal Pi dev-review artifacts (not versioned)";
  const prefix = content && !content.endsWith("\n") ? "\n" : "";
  const markerPrefix = content.includes(marker) ? "" : `${marker}\n`;
  await mkdir(path.dirname(excludePath), { recursive: true });
  await writeFile(excludePath, `${content}${prefix}${markerPrefix}${pattern}\n`, "utf8");
}

async function repositoryFingerprint(cwd) {
  const head = gitHead(cwd);
  const diff = runGit(cwd, ["diff", "--binary", "HEAD"]);
  const untracked = runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const digest = createHash("sha256");
  digest.update(`${head}\0${diff}\0`);
  for (const rawPath of untracked.split("\0").filter(Boolean).sort()) {
    const absolute = path.resolve(cwd, rawPath);
    let contents = "";
    try {
      contents = await readFile(absolute);
    } catch {
      contents = "<non-regular-or-unreadable>";
    }
    digest.update(rawPath);
    digest.update("\0");
    digest.update(contents);
    digest.update("\0");
  }
  return digest.digest("hex");
}

function workflowPaths(projectRoot, artifactDir) {
  const root = path.isAbsolute(artifactDir)
    ? artifactDir
    : path.resolve(projectRoot, artifactDir || DEFAULT_ARTIFACT_DIR);
  return {
    root,
    state: path.join(root, "state.json"),
    inputs: path.join(root, "inputs"),
    handoffs: path.join(root, "handoffs"),
    escalation: path.join(root, "escalation"),
    reports: path.join(root, "reports"),
    private: path.join(root, "private"),
    developerSessions: path.join(root, "private", "developer-sessions"),
    reviewerSessions: path.join(root, "private", "reviewer-sessions"),
  };
}

function workflowRegistryPath(projectRoot) {
  return path.join(projectRoot, DEFAULT_ARTIFACT_DIR, "active-workflow.json");
}

function workflowLabel(value) {
  const normalized = String(value || "")
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return normalized || "workflow";
}

function workflowKeyForPlan(planSource, planHash, requestedLabel) {
  const sourceStem = path.basename(planSource, path.extname(planSource));
  const label = workflowLabel(requestedLabel || sourceStem);
  return `${label}--${planHash.slice(0, 8)}`;
}

function safeWorkflowKey(value) {
  const key = asString(value, "workflow id");
  if (key.includes("/") || key.includes("\\") || key === "." || key === "..") {
    throw new Error("workflow id must be a directory name, not a path");
  }
  return key;
}

async function writeActiveWorkflow(projectRoot, paths, state) {
  const pointerPath = workflowRegistryPath(projectRoot);
  await writeJson(pointerPath, {
    schemaVersion: SCHEMA_VERSION,
    workflowKey: state.workflow?.key || path.basename(paths.root),
    artifactDir: relativeTo(projectRoot, paths.root),
    updatedAt: now(),
  });
}

async function readActiveWorkflowPointer(projectRoot) {
  const pointerPath = workflowRegistryPath(projectRoot);
  let pointer;
  try {
    pointer = JSON.parse(await readFile(pointerPath, "utf8"));
  } catch (error) {
    throw new Error(`No active dev-review workflow. Start one with /dev-review start <plan.md>, or select one with /dev-review use <workflow-id>. (${error.message})`);
  }
  if (!pointer || typeof pointer.artifactDir !== "string" || !pointer.artifactDir.trim()) {
    throw new Error(`Active workflow pointer is invalid: ${pointerPath}`);
  }
  return pointer;
}

async function readActiveWorkflowPaths(projectRoot) {
  const pointer = await readActiveWorkflowPointer(projectRoot);
  return workflowPaths(projectRoot, pointer.artifactDir);
}

async function existingWorkflowPaths(projectRoot, options) {
  if (options.artifactDir) return workflowPaths(projectRoot, options.artifactDir);
  if (options.workflow) {
    const key = safeWorkflowKey(options.workflow);
    return workflowPaths(projectRoot, path.join(DEFAULT_ARTIFACT_DIR, key));
  }
  return readActiveWorkflowPaths(projectRoot);
}

async function listWorkflowStates(projectRoot) {
  const base = path.join(projectRoot, DEFAULT_ARTIFACT_DIR);
  if (!existsSync(base)) return [];
  const entries = await readdir(base, { withFileTypes: true });
  const states = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const paths = workflowPaths(projectRoot, path.join(DEFAULT_ARTIFACT_DIR, entry.name));
    if (!existsSync(paths.state)) continue;
    try {
      const state = await readJson(paths.state);
      states.push({ state, paths });
    } catch {
      // Skip unrelated or malformed directories rather than making list unusable.
    }
  }
  return states.sort((left, right) => String(right.state.updatedAt).localeCompare(String(left.state.updatedAt)));
}

async function listWorkflows(projectRoot) {
  const states = await listWorkflowStates(projectRoot);
  let activeKey = null;
  try {
    activeKey = (await readActiveWorkflowPointer(projectRoot)).workflowKey || null;
  } catch {
    // A missing active pointer is fine when listing completed/older workflows.
  }
  if (states.length === 0) {
    return "No named dev-review workflows exist yet. Start one with /dev-review start <plan.md>.";
  }
  return [
    "Dev-review workflows:",
    ...states.map(({ state, paths }) => {
      const key = state.workflow?.key || path.basename(paths.root);
      const active = key === activeKey ? " *active*" : "";
      return `- ${key}${active} — ${state.status}, round ${state.currentRound}/${state.config.maxReviewRounds}, PRD ${state.plan.sourcePath}`;
    }),
    "Use /dev-review use <workflow-id> to switch the active workflow.",
  ].join("\n");
}

async function selectWorkflow(projectRoot, key) {
  const paths = workflowPaths(projectRoot, path.join(DEFAULT_ARTIFACT_DIR, safeWorkflowKey(key)));
  const state = await readJson(paths.state);
  await writeActiveWorkflow(projectRoot, paths, state);
  return { state, paths };
}

async function ensureArtifactDirectories(paths) {
  await Promise.all([
    mkdir(paths.root, { recursive: true }),
    mkdir(paths.inputs, { recursive: true }),
    mkdir(paths.handoffs, { recursive: true }),
    mkdir(paths.escalation, { recursive: true }),
    mkdir(paths.reports, { recursive: true }),
    mkdir(paths.private, { recursive: true }),
    mkdir(paths.developerSessions, { recursive: true }),
    mkdir(paths.reviewerSessions, { recursive: true }),
  ]);
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

async function writeText(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, value, "utf8");
  await rename(temporary, filePath);
}

async function readJson(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read workflow state at ${filePath}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Workflow state must be a JSON object");
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported workflow state schema: ${parsed.schemaVersion}`);
  }
  return parsed;
}

async function readOptionalDefaults(filePath) {
  if (!existsSync(filePath)) return {};
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read dev-review defaults at ${filePath}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Dev-review defaults at ${filePath} must be a JSON object`);
  }
  if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported dev-review defaults schema at ${filePath}: ${parsed.schemaVersion}`);
  }
  return parsed;
}

async function loadWorkflowDefaults() {
  const project = await readOptionalDefaults(PROJECT_DEFAULTS_FILE);
  const local = await readOptionalDefaults(LOCAL_DEFAULTS_FILE);
  return {
    ...project,
    ...local,
    testCommands: local.testCommands ?? project.testCommands ?? [],
  };
}

function normalizeModels(developerModel, reviewerModel) {
  const developer = asString(developerModel, "developer model");
  const reviewer = asString(reviewerModel, "reviewer model");
  if (developer === reviewer) {
    throw new Error("Developer and reviewer must use different model values");
  }
  return { developer, reviewer };
}

function makeState({ projectRoot, artifactDir, workflow, repository, sourcePlan, snapshotPlan, planHash, baseHead, config, wasDirty }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    workflowId: randomUUID(),
    projectRoot,
    artifactDir,
    workflow,
    repository,
    migrations: [],
    createdAt: now(),
    updatedAt: now(),
    status: "ready",
    phase: "idle",
    currentRound: 0,
    base: {
      head: baseHead,
      initializedDirty: wasDirty,
    },
    plan: {
      sourcePath: sourcePlan,
      snapshotPath: snapshotPlan,
      sha256: planHash,
      version: 1,
    },
    config,
    developerSession: {
      generation: 1,
      sessionId: "developer-g1",
    },
    openIssues: [],
    history: [],
    pendingHumanDecisionPath: null,
    blocked: null,
  };
}

function issueSummary(issue) {
  return {
    id: issue.id,
    severity: issue.severity,
    location: issue.location,
    requirement: issue.requirement,
    evidence: issue.evidence,
    required_fix: issue.required_fix,
    first_round: issue.first_round,
    last_review_round: issue.last_review_round,
  };
}

function normalizeDeveloperReport(value) {
  const report = asObject(value, "developer report");
  const status = enumValue(report.status, "developer.status", ["done", "blocked"]);
  const blockers = (report.blockers ?? []).map((item, index) => {
    const blocker = asObject(item, `developer.blockers[${index}]`);
    return {
      question: asString(blocker.question, `developer.blockers[${index}].question`),
      why: asString(blocker.why, `developer.blockers[${index}].why`),
      options: asStringArray(blocker.options, `developer.blockers[${index}].options`),
    };
  });
  if (status === "blocked" && blockers.length === 0) {
    throw new Error("A blocked developer report must include at least one blocker");
  }

  return {
    status,
    summary: asString(report.summary, "developer.summary"),
    changed_files: asStringArray(report.changed_files, "developer.changed_files"),
    requirements_covered: asStringArray(report.requirements_covered, "developer.requirements_covered"),
    resolved_issues: (report.resolved_issues ?? []).map((item, index) => {
      const resolution = asObject(item, `developer.resolved_issues[${index}]`);
      return {
        id: asString(resolution.id, `developer.resolved_issues[${index}].id`),
        status: enumValue(resolution.status, `developer.resolved_issues[${index}].status`, [
          "fixed",
          "partially_fixed",
          "not_fixed",
          "blocked",
          "not_applicable",
        ]),
        summary: asString(resolution.summary, `developer.resolved_issues[${index}].summary`),
        files: asStringArray(resolution.files, `developer.resolved_issues[${index}].files`),
        verification: asStringArray(resolution.verification, `developer.resolved_issues[${index}].verification`),
      };
    }),
    tests: (report.tests ?? []).map((item, index) => {
      const test = asObject(item, `developer.tests[${index}]`);
      return {
        command: asString(test.command, `developer.tests[${index}].command`),
        status: enumValue(test.status, `developer.tests[${index}].status`, ["passed", "failed", "not_run"]),
        summary: asString(test.summary, `developer.tests[${index}].summary`),
      };
    }),
    assumptions: asStringArray(report.assumptions, "developer.assumptions"),
    risks: asStringArray(report.risks, "developer.risks"),
    handoff_to_reviewer: asString(report.handoff_to_reviewer, "developer.handoff_to_reviewer"),
    blockers,
  };
}

function normalizeReviewerReport(value, round, existingIssues) {
  const report = asObject(value, "reviewer report");
  const decision = enumValue(report.decision, "reviewer.decision", ["pass", "fix_required", "spec_blocked"]);
  const existingIds = new Set(existingIssues.map((issue) => issue.id));
  const receivedIds = new Set();
  const previousIssueVerdicts = (report.previous_issue_verdicts ?? []).map((item, index) => {
    const verdict = asObject(item, `reviewer.previous_issue_verdicts[${index}]`);
    const id = asString(verdict.id, `reviewer.previous_issue_verdicts[${index}].id`);
    if (!existingIds.has(id)) throw new Error(`Reviewer returned a verdict for unknown open issue ${id}`);
    if (receivedIds.has(id)) throw new Error(`Reviewer returned duplicate verdict for ${id}`);
    receivedIds.add(id);
    return {
      id,
      verdict: enumValue(verdict.verdict, `reviewer.previous_issue_verdicts[${index}].verdict`, [
        "verified_closed",
        "still_open",
        "partially_fixed",
        "not_verifiable",
      ]),
      evidence: asString(verdict.evidence, `reviewer.previous_issue_verdicts[${index}].evidence`),
      required_fix: asOptionalString(verdict.required_fix, `reviewer.previous_issue_verdicts[${index}].required_fix`),
    };
  });
  if (receivedIds.size !== existingIds.size) {
    const missing = [...existingIds].filter((id) => !receivedIds.has(id));
    throw new Error(`Reviewer must explicitly verify every prior open issue; missing: ${missing.join(", ")}`);
  }

  const newIds = new Set();
  const prefix = new RegExp(`^R${round}-\\d{3}$`);
  const newFindings = (report.new_findings ?? []).map((item, index) => {
    const finding = asObject(item, `reviewer.new_findings[${index}]`);
    const id = asString(finding.id, `reviewer.new_findings[${index}].id`);
    if (!prefix.test(id)) {
      throw new Error(`New finding ${id} must use the current-round form R${round}-NNN`);
    }
    if (newIds.has(id) || existingIds.has(id)) throw new Error(`Duplicate finding id ${id}`);
    newIds.add(id);
    return {
      id,
      severity: enumValue(finding.severity, `reviewer.new_findings[${index}].severity`, ["critical", "major", "minor"]),
      location: asString(finding.location, `reviewer.new_findings[${index}].location`),
      requirement: asString(finding.requirement, `reviewer.new_findings[${index}].requirement`),
      evidence: asString(finding.evidence, `reviewer.new_findings[${index}].evidence`),
      required_fix: asString(finding.required_fix, `reviewer.new_findings[${index}].required_fix`),
    };
  });

  const specQuestions = (report.spec_questions ?? []).map((item, index) => {
    const question = asObject(item, `reviewer.spec_questions[${index}]`);
    return {
      question: asString(question.question, `reviewer.spec_questions[${index}].question`),
      why: asString(question.why, `reviewer.spec_questions[${index}].why`),
      options: asStringArray(question.options, `reviewer.spec_questions[${index}].options`),
    };
  });
  if (decision === "spec_blocked" && specQuestions.length === 0) {
    throw new Error("A spec_blocked reviewer report must include at least one spec question");
  }

  return {
    decision,
    summary: asString(report.summary, "reviewer.summary"),
    previous_issue_verdicts: previousIssueVerdicts,
    new_findings: newFindings,
    tests: (report.tests ?? []).map((item, index) => {
      const test = asObject(item, `reviewer.tests[${index}]`);
      return {
        command: asString(test.command, `reviewer.tests[${index}].command`),
        status: enumValue(test.status, `reviewer.tests[${index}].status`, ["passed", "failed", "not_run"]),
        summary: asString(test.summary, `reviewer.tests[${index}].summary`),
      };
    }),
    spec_questions: specQuestions,
    handoff_to_developer: asString(report.handoff_to_developer, "reviewer.handoff_to_developer"),
  };
}

function applyReviewReport(state, review, round) {
  const next = new Map(state.openIssues.map((issue) => [issue.id, { ...issue }]));
  for (const verdict of review.previous_issue_verdicts) {
    const issue = next.get(verdict.id);
    if (!issue) continue;
    if (verdict.verdict === "verified_closed") {
      next.delete(verdict.id);
      continue;
    }
    issue.last_review_round = round;
    issue.last_verdict = verdict.verdict;
    issue.last_evidence = verdict.evidence;
    if (verdict.required_fix) issue.required_fix = verdict.required_fix;
  }
  for (const finding of review.new_findings) {
    next.set(finding.id, {
      ...finding,
      first_round: round,
      last_review_round: round,
      last_verdict: "new",
      last_evidence: finding.evidence,
    });
  }
  return [...next.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function developerMarkdown({ round, report, state, planPath, previousReviewPath, humanDecisionPath }) {
  const resolutions = report.resolved_issues.length
    ? report.resolved_issues.map((item) => [
        `### ${item.id} — ${item.status}`,
        item.summary,
        "**Files:**",
        markdownList(item.files),
        "**Verification:**",
        markdownList(item.verification),
      ].join("\n")).join("\n\n")
    : "None.";
  const tests = report.tests.length
    ? report.tests.map((test) => `- **${test.status}** ${markdownCode(test.command)} — ${test.summary}`).join("\n")
    : "- No test command was reported.";
  const blockers = report.blockers.length
    ? report.blockers.map((item) => [
        `### ${item.question}`,
        `**Why:** ${item.why}`,
        "**Options:**",
        markdownList(item.options),
      ].join("\n")).join("\n\n")
    : "None.";

  return `# Development handoff — Round ${round}

- **Generated:** ${localNow()}
- **Status:** ${report.status}
- **Frozen plan:** ${markdownCode(planPath)}
${previousReviewPath ? `- **Input review handoff:** ${markdownCode(previousReviewPath)}\n` : ""}${humanDecisionPath ? `- **Human decision input:** ${markdownCode(humanDecisionPath)}\n` : ""}
## Summary

${report.summary}

## Changed files

${markdownList(report.changed_files)}

## Requirements covered

${markdownList(report.requirements_covered)}

## Prior issue handling

${resolutions}

## Tests

${tests}

## Assumptions

${markdownList(report.assumptions)}

## Risks

${markdownList(report.risks)}

## Handoff to reviewer

${report.handoff_to_reviewer}

## Blockers

${blockers}
`;
}

function reviewerMarkdown({ round, report, planPath, developerPath, openIssues }) {
  const verdicts = report.previous_issue_verdicts.length
    ? report.previous_issue_verdicts.map((item) => [
        `### ${item.id} — ${item.verdict}`,
        `**Evidence:** ${item.evidence}`,
        item.required_fix ? `**Required fix:** ${item.required_fix}` : "",
      ].filter(Boolean).join("\n")).join("\n\n")
    : "No prior open issues existed.";
  const findings = report.new_findings.length
    ? report.new_findings.map((item) => [
        `### ${item.id} — ${item.severity}`,
        `- **Location:** ${markdownCode(item.location)}`,
        `- **Plan requirement:** ${item.requirement}`,
        `- **Evidence:** ${item.evidence}`,
        `- **Required fix:** ${item.required_fix}`,
      ].join("\n")).join("\n\n")
    : "No new findings.";
  const tests = report.tests.length
    ? report.tests.map((test) => `- **${test.status}** ${markdownCode(test.command)} — ${test.summary}`).join("\n")
    : "- No test command was reported.";
  const questions = report.spec_questions.length
    ? report.spec_questions.map((item) => [
        `### ${item.question}`,
        `**Why this blocks review:** ${item.why}`,
        "**Options:**",
        markdownList(item.options),
      ].join("\n")).join("\n\n")
    : "None.";

  return `# Review handoff — Round ${round}

- **Generated:** ${localNow()}
- **Decision:** ${report.decision}
- **Frozen plan:** ${markdownCode(planPath)}
- **Development handoff reviewed:** ${markdownCode(developerPath)}
- **Open issues after this review:** ${openIssues.length}

## Summary

${report.summary}

## Prior issue verification

${verdicts}

## New findings

${findings}

## Review tests

${tests}

## Specification questions / human decision needed

${questions}

## Handoff to developer

${report.handoff_to_developer}
`;
}

function rawReportMarkdown(raw) {
  if (!raw) return "";
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    return `\`\`\`json\n${raw}\n\`\`\``;
  }
  const sections = [];
  if (typeof report.summary === "string" && report.summary) {
    sections.push(`### What the agent reported\n\n${report.summary}`);
  }
  if (Array.isArray(report.blockers) && report.blockers.length) {
    const rendered = report.blockers.map((blocker, index) => {
      if (blocker && typeof blocker === "object") {
        return [
          `### ${blocker.question || `Question ${index + 1}`}`,
          blocker.why ? `**Why:** ${blocker.why}` : "",
          Array.isArray(blocker.options) && blocker.options.length
            ? "**Options:**\n" + markdownList(blocker.options)
            : "",
        ].filter(Boolean).join("\n");
      }
      return `### ${String(blocker)}`;
    }).join("\n\n");
    sections.push(`## Questions for you\n\n${rendered}`);
  }
  const seen = new Set(["summary", "blockers"]);
  const extra = Object.entries(report)
    .filter(([key, value]) => !seen.has(key) && value != null)
    .map(([key, value]) => {
      const label = String(key).replace(/_/g, " ");
      if (typeof value === "string") {
        return `- **${label}:** ${value.replace(/\s+/g, " ").slice(0, 400)}`;
      }
      return `- **${label}:** \`${JSON.stringify(value).slice(0, 300)}\``;
    });
  if (extra.length) sections.push(`### Other report fields\n\n${extra.join("\n")}`);
  return sections.join("\n\n");
}

function escalationMarkdown({ state, reason, details, paths }) {
  const current = state.currentRound;
  const recent = state.history.at(-1) || {};
  const questions = details.questions || [];
  const questionMarkdown = questions.length
    ? questions.map((item) => [
        `### ${item.question}`,
        `**Why:** ${item.why}`,
        "**Options:**",
        markdownList(item.options),
      ].join("\n")).join("\n\n")
    : "No structured question was supplied; inspect the latest report and workflow state.";

  return `# Human decision required

- **Generated:** ${localNow()}
- **Reason:** ${reason}
- **Round:** ${current}
- **Frozen plan:** ${markdownCode(state.plan.snapshotPath)}
- **Workflow state:** ${markdownCode(relativeTo(state.projectRoot, paths.state))}
${recent.developerPath ? `- **Latest development handoff:** ${markdownCode(recent.developerPath)}\n` : ""}${recent.reviewerPath ? `- **Latest review handoff:** ${markdownCode(recent.reviewerPath)}\n` : ""}
## Why the automated loop stopped

${details.summary || "The coordinator stopped the workflow for a human decision."}
${details.rawReport ? `\n## Developer report (recovered)\n\n${rawReportMarkdown(details.rawReport)}\n` : ""}

## Open issues

${state.openIssues.length ? state.openIssues.map((issue) => [
  `### ${issue.id} — ${issue.severity}`,
  `- **Location:** ${markdownCode(issue.location)}`,
  `- **Requirement:** ${issue.requirement}`,
  `- **Evidence:** ${issue.evidence}`,
  `- **Required fix:** ${issue.required_fix}`,
].join("\n")).join("\n\n") : "No open implementation issue is recorded."}

## Decision questions

${questionMarkdown}

## Resume

Write a short decision document with the chosen behavior, trade-offs, and any amended acceptance criteria. Then run:

\`/dev-review resolve <your-decision-file.md>\`
`;
}

function finalReportMarkdown(state) {
  const rounds = state.history.filter((item) => item.reviewerPath).length;
  return `# Development / review workflow result

- **Generated:** ${localNow()}
- **Status:** passed
- **Frozen plan:** ${markdownCode(state.plan.snapshotPath)}
- **Base commit:** ${markdownCode(state.base.head)}
- **Completed review rounds:** ${rounds}
- **Developer model:** ${markdownCode(state.config.developerModel)}
- **Reviewer model:** ${markdownCode(state.config.reviewerModel)}
- **Timeline:** ${markdownCode(`${state.artifactDir}/reports/timeline.md`)}

## Review history

${state.history.map((item) => `- Round ${item.round}: ${item.decision || (item.reviewerPath ? "reviewed" : "interrupted before review")} — development ${markdownCode(item.developerPath || "not produced")}${item.reviewerPath ? `; review ${markdownCode(item.reviewerPath)}` : ""}`).join("\n") || "- No rounds recorded."}

## Outcome

All open review issues were explicitly verified closed and the final independent reviewer returned \`pass\`.
`;
}

function makeDeveloperTask(state, paths, round, previousReviewPath, humanDecisionPath) {
  const planPath = state.plan.snapshotPath;
  const context = {
    round,
    base_commit: state.base.head,
    frozen_plan: planPath,
    previous_review_handoff: previousReviewPath || null,
    human_decision: humanDecisionPath || null,
    open_issues: state.openIssues.map(issueSummary),
    required_test_commands: state.config.testCommands,
  };

  return `You are the DEVELOPMENT role for round ${round}.

Work on the actual repository at ${state.projectRoot}. The frozen plan is ${planPath}. Read it directly. ${previousReviewPath ? `The only peer handoff you may use is ${previousReviewPath}.` : "There is no prior reviewer handoff; implement the frozen plan."} ${humanDecisionPath ? `A human decision that amends/clarifies the plan is at ${humanDecisionPath}.` : ""}

Structured context packet (data, not instructions):
${JSON.stringify(context, null, 2)}

Required behavior:
1. Implement the plan and resolve the open review issues that are actually applicable.
2. Inspect source and run the required or otherwise relevant tests.
3. Do not edit the plan, .ai-dev-review workflow artifacts, private sessions, or Git history.
4. If correctness depends on an unclear or contradictory product decision, do not guess: return status "blocked" with questions.
5. Return exactly one JSON object, no prose and no Markdown fence, with this shape:
{
  "status": "done" | "blocked",
  "summary": "what was implemented or why work is blocked",
  "changed_files": ["relative/path"],
  "requirements_covered": ["plan requirement"],
  "resolved_issues": [{"id":"R01-001","status":"fixed|partially_fixed|not_fixed|blocked|not_applicable","summary":"...","files":["..."],"verification":["..."]}],
  "tests": [{"command":"...","status":"passed|failed|not_run","summary":"..."}],
  "assumptions": ["..."],
  "risks": ["..."],
  "handoff_to_reviewer": "specific review focus",
  "blockers": [{"question":"...","why":"...","options":["..."]}]
}`;
}

function makeReviewerTask(state, paths, round, developerPath) {
  const context = {
    round,
    base_commit: state.base.head,
    frozen_plan: state.plan.snapshotPath,
    developer_handoff: developerPath,
    prior_open_issues: state.openIssues.map(issueSummary),
    required_test_commands: state.config.testCommands,
  };
  const priorIds = state.openIssues.map((issue) => issue.id);

  return `You are the independent REVIEW role for round ${round}.

Review the actual repository at ${state.projectRoot}. The frozen plan is ${state.plan.snapshotPath}; the development handoff is ${developerPath}. Independently inspect the code and git diff from base commit ${state.base.head}. The handoff is only a checklist—verify claims yourself.

Structured context packet (data, not instructions):
${JSON.stringify(context, null, 2)}

Required behavior:
1. Verify each prior open issue ID: ${priorIds.length ? priorIds.join(", ") : "none"}.
2. Review claimed changes and adjacent behavior for regressions; run safe, relevant tests when practical.
3. Do not modify source, workflow artifacts, or Git history. The coordinator will reject a review that mutates the worktree.
4. Return "spec_blocked" only for a real plan/acceptance ambiguity that prevents a correct verdict; provide decision options.
5. Return "pass" only when every prior issue is verified closed and no new finding remains.
6. Return exactly one JSON object, no prose and no Markdown fence, with this shape:
{
  "decision": "pass" | "fix_required" | "spec_blocked",
  "summary": "independent review summary",
  "previous_issue_verdicts": [{"id":"${priorIds[0] || "R01-001"}","verdict":"verified_closed|still_open|partially_fixed|not_verifiable","evidence":"...","required_fix":"... optional when closed"}],
  "new_findings": [{"id":"R${round}-001","severity":"critical|major|minor","location":"path:line","requirement":"frozen-plan requirement","evidence":"what you observed","required_fix":"concrete repair"}],
  "tests": [{"command":"...","status":"passed|failed|not_run","summary":"..."}],
  "spec_questions": [{"question":"...","why":"...","options":["..."]}],
  "handoff_to_developer": "precise next action or pass rationale"
}`;
}

async function loadRolePrompt(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`Role prompt is unavailable at ${filePath}: ${error.message}`);
  }
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    if (typeof part.text === "string") return part.text;
    if (typeof part.content === "string") return part.content;
    return "";
  }).join("");
}

function extractJsonObject(text) {
  const candidates = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{") depth += 1;
      if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(start, index + 1);
          try {
            candidates.push({ value: JSON.parse(candidate), length: candidate.length });
          } catch {
            // Keep scanning: prose may contain JSON-looking fragments.
          }
          break;
        }
      }
    }
  }
  if (candidates.length === 0) {
    throw new Error(`Agent did not return a JSON object. Final output excerpt: ${text.slice(0, 500)}`);
  }
  return candidates.sort((left, right) => right.length - left.length)[0].value;
}

function standalonePiInvocation() {
  return { command: process.env.PI_BIN || "pi", args: [] };
}

async function invokePiAgent({ role, state, paths, round, task, piInvocation, notify }) {
  const developer = role === "developer";
  const rolePrompt = await loadRolePrompt(developer ? DEV_ROLE_PROMPT : REVIEW_ROLE_PROMPT);
  const config = developer
    ? { model: state.config.developerModel, thinking: state.config.developerThinking, tools: DEV_TOOLS }
    : { model: state.config.reviewerModel, thinking: state.config.reviewerThinking, tools: REVIEW_TOOLS };

  const args = [
    ...piInvocation.args,
    "--mode", "json",
    "--print",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--model", config.model,
    "--tools", config.tools.join(","),
    "--append-system-prompt", rolePrompt,
  ];
  if (config.thinking) args.push("--thinking", config.thinking);
  if (developer) {
    const generation = Math.floor((round - 1) / state.config.developerResetAfterRounds) + 1;
    state.developerSession = { generation, sessionId: `developer-g${generation}` };
    args.push("--session-dir", paths.developerSessions, "--session-id", state.developerSession.sessionId);
  } else {
    // Record the reviewer transcript too so the full process is inspectable;
    // reviewer still gets a fresh one-off session per round (no cross-round memory).
    args.push("--session-dir", paths.reviewerSessions, "--session-id", `reviewer-r${String(round).padStart(2, "0")}`);
  }
  args.push(task);

  notify?.(`${developer ? "Development" : "Review"} agent: round ${round} started.`);
  const output = await new Promise((resolve, reject) => {
    const child = spawn(piInvocation.command, args, {
      cwd: state.projectRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdoutBuffer = "";
    let stderr = "";
    let finalText = "";

    const label = `${developer ? "dev" : "review"} r${round}`;
    const streamEnabled = process.env.DEV_REVIEW_STREAM !== "0";
    const truncate = (value, max = 160) => {
      const text = String(value ?? "").replace(/\s+/g, " ").trim();
      return text.length > max ? `${text.slice(0, max)}…` : text;
    };

    const processLine = (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "message_end" && event.message?.role === "assistant") {
        finalText = messageText(event.message);
        if (streamEnabled) notify?.(`[${label}] 💬 ${truncate(finalText, 220)}`);
      } else if (streamEnabled && event.type === "tool_execution_start") {
        notify?.(`[${label}] 🔧 ${event.toolName} ${truncate(JSON.stringify(event.args ?? {}), 140)}`);
      } else if (streamEnabled && event.type === "tool_execution_end" && event.isError) {
        notify?.(`[${label}] ⚠️ ${event.toolName} failed: ${truncate(event.result, 160)}`);
      }
    };

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += String(chunk);
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => reject(new Error(`Could not start Pi ${role} agent: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (stdoutBuffer.trim()) processLine(stdoutBuffer);
      if (code !== 0) {
        const hint = classifyAgentFailure(stderr);
        reject(new Error(`Pi ${role} agent failed (exit ${code ?? "unknown"}${signal ? `, ${signal}` : ""})${hint ? ` [likely ${hint}]` : ""}: ${stderr.slice(-1200).trim()}`));
        return;
      }
      if (!finalText) {
        const hint = classifyAgentFailure(stderr);
        reject(new Error(`Pi ${role} agent ended without a final assistant message${hint ? ` [likely ${hint}]` : ""}: ${stderr.slice(-1200).trim()}`));
        return;
      }
      resolve({ finalText, stderr });
    });
  });

  notify?.(`${developer ? "Development" : "Review"} agent: round ${round} finished.`);
  return output;
}

/**
 * Peek at a failed child agent's stderr and name the most likely cause, so a
 * quota/auth/network failure is distinguishable at a glance from a protocol
 * violation. Pure heuristic — the raw stderr tail is always kept below it.
 */
function classifyAgentFailure(text) {
  const value = String(text || "");
  if (/(\b429\b|too many requests|rate.?limit|insufficient_?quota|quota|billing|balance|欠费|额度|限流)/i.test(value)) {
    return "model quota/rate limit（额度或限流）";
  }
  if (/(\b401\b|\b403\b|unauthor|invalid api key|authentication|not authorized|permission denied|forbidden)/i.test(value)) {
    return "model auth/permission（鉴权或权限）";
  }
  if (/(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network error)/i.test(value)) {
    return "network error（网络）";
  }
  if (/(timed out|timeout)/i.test(value)) {
    return "timeout（超时）";
  }
  return null;
}

async function writeEscalation(state, paths, reason, details) {
  state.status = "blocked";
  state.phase = "human_decision";
  state.blocked = { reason, details, at: now() };
  const name = `${String(state.currentRound).padStart(2, "0")}-${reason}.md`;
  const filePath = path.join(paths.escalation, name);
  await writeText(filePath, escalationMarkdown({ state, reason, details, paths }));
  state.blocked.escalationPath = relativeTo(state.projectRoot, filePath);
  state.updatedAt = now();
  await writeJson(paths.state, state);
  await appendTimeline(paths, timelineLine({
    round: state.currentRound,
    event: "blocked",
    status: reason,
    summary: details?.summary,
    artifact: state.blocked.escalationPath,
  }));
  return filePath;
}

function truncateText(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Compact human-readable reason for a blocked workflow: reason code, summary,
 * decision questions with options, and the escalation file. Every place that
 * reports a stop (CLI result, background-run wake-up message, status) uses this
 * so callers surface *why* a run stopped instead of a bare "blocked".
 */
function blockedNotice(state, { summaryLimit = 700, questionLimit = 3, questionTextLimit = 300, optionLimit = 6, optionTextLimit = 260 } = {}) {
  const blocked = state?.blocked;
  if (!blocked) return `Workflow is ${state?.status || "stopped"} with no recorded blocking reason.`;
  const lines = [`Blocked (${blocked.reason || "human-decision"})`];
  const summary = truncateText(blocked.details?.summary, summaryLimit);
  if (summary) lines.push(`Why: ${summary}`);
  const questions = Array.isArray(blocked.details?.questions) ? blocked.details.questions : [];
  questions.slice(0, questionLimit).forEach((item, index) => {
    const question = typeof item === "string" ? item : item?.question;
    if (!question) return;
    lines.push(`Q${index + 1}: ${truncateText(question, questionTextLimit)}`);
    const options = typeof item === "object" && Array.isArray(item?.options) ? item.options : [];
    options.slice(0, optionLimit).forEach((option, optionIndex) => {
      lines.push(`  ${optionIndex + 1}) ${truncateText(option, optionTextLimit)}`);
    });
  });
  if (questions.length > questionLimit) lines.push(`…还有 ${questions.length - questionLimit} 个决策问题，见决策文件。`);
  if (blocked.escalationPath) lines.push(`Decision file: ${blocked.escalationPath}`);
  return lines.join("\n");
}

function timelineFilePath(paths) {
  return path.join(paths.reports, "timeline.md");
}

/**
 * Append-only, human-readable log of the whole workflow: plan freeze →
 * development rN → review rN → human decision / escalation → pass. Never
 * rewritten, so interrupted and resumed runs stay in one chronological file
 * (`reports/timeline.md`), while the per-role details live in handoffs/.
 */
async function appendTimeline(paths, lines) {
  const entries = (Array.isArray(lines) ? lines : [lines]).filter(
    (line) => typeof line === "string" && line.length > 0,
  );
  if (!entries.length) return;
  try {
    await mkdir(paths.reports, { recursive: true });
    await appendFile(timelineFilePath(paths), `${entries.join("\n")}\n`, "utf8");
  } catch {
    // The timeline is a convenience artifact; never fail a run because of it.
  }
}

function timelineLine({ round, event, status, summary, artifact }) {
  const head = [
    localNow(),
    round ? `r${round}` : "workflow",
    event,
    status ? `**${status}**` : null,
  ].filter(Boolean).join(" · ");
  const tail = [
    typeof summary === "string" && summary.trim() ? truncateText(summary, 400) : null,
    artifact ? `\`${artifact}\`` : null,
  ].filter(Boolean).join(" — ");
  return `- ${head}${tail ? ` — ${tail}` : ""}`;
}

function stateStatus(state, paths) {
  const lines = [
    `Workflow: ${state.workflow?.key || state.workflowId}`,
    `PRD: ${state.plan.sourcePath}`,
    `Status: ${state.status}${state.phase ? ` (${state.phase})` : ""}`,
    `Plan snapshot: ${relativeTo(state.projectRoot, path.resolve(state.projectRoot, state.plan.snapshotPath))}`,
    `Base commit: ${state.base.head}`,
    `Round: ${state.currentRound}/${state.config.maxReviewRounds}`,
    `Developer model: ${state.config.developerModel}`,
    `Reviewer model: ${state.config.reviewerModel}`,
    `Open issues: ${state.openIssues.length ? state.openIssues.map((issue) => issue.id).join(", ") : "none"}`,
    `Artifacts: ${relativeTo(state.projectRoot, paths.root)}`,
    `Timeline: ${relativeTo(state.projectRoot, timelineFilePath(paths))}`,
  ];
  if (state.status === "blocked" && state.blocked) {
    lines.push(blockedNotice(state));
  } else if (state.blocked?.escalationPath) {
    lines.push(`Human decision file: ${state.blocked.escalationPath}`);
  }
  return lines.join("\n");
}

function mergeConfig(state, options, { requireModels = false, defaults = {} } = {}) {
  const current = state?.config ?? {};
  let developerModel = options.developerModel
    ?? current.developerModel
    ?? process.env.DEV_REVIEW_DEVELOPER_MODEL
    ?? defaults.developerModel;
  let reviewerModel = options.reviewerModel
    ?? current.reviewerModel
    ?? process.env.DEV_REVIEW_REVIEWER_MODEL
    ?? defaults.reviewerModel;
  if (requireModels || options.developerModel || options.reviewerModel) {
    const models = normalizeModels(developerModel, reviewerModel);
    developerModel = models.developer;
    reviewerModel = models.reviewer;
  }
  return {
    developerModel,
    reviewerModel,
    maxReviewRounds: options.maxRounds ?? current.maxReviewRounds ?? defaults.maxReviewRounds ?? DEFAULT_MAX_ROUNDS,
    developerResetAfterRounds: options.developerResetAfterRounds
      ?? current.developerResetAfterRounds
      ?? defaults.developerResetAfterRounds
      ?? DEFAULT_DEVELOPER_RESET_AFTER_ROUNDS,
    testCommands: options.tests.length ? options.tests : (current.testCommands ?? defaults.testCommands ?? []),
    developerThinking: options.developerThinking ?? current.developerThinking ?? defaults.developerThinking ?? null,
    reviewerThinking: options.reviewerThinking ?? current.reviewerThinking ?? defaults.reviewerThinking ?? null,
  };
}

/**
 * Resolve the plan path for init/start. Paths are normally relative to the
 * current directory, but launching from a deep subdirectory with a repo-root
 * relative path is a common slip (`<repo>/docs/prd` + `docs/prd/plan.md` →
 * `<repo>/docs/prd/docs/prd/plan.md`). If the cwd resolution is missing but the
 * repo-root resolution exists, fall back and say so.
 */
function resolvePlanSource(cwd, planArg, projectRoot) {
  const fromCwd = path.resolve(cwd, planArg);
  if (existsSync(fromCwd)) return { planSource: fromCwd, note: null };
  const fromRoot = projectRoot ? path.resolve(projectRoot, planArg) : null;
  if (fromRoot && fromRoot !== fromCwd && existsSync(fromRoot)) {
    return {
      planSource: fromRoot,
      note: `Plan path '${planArg}' was not found from cwd ${cwd}; resolved it against the repository root instead: ${fromRoot}`,
    };
  }
  const tried = fromRoot && fromRoot !== fromCwd ? `; also tried ${fromRoot}` : "";
  throw new Error(`Plan file does not exist: ${fromCwd} (resolved from cwd ${cwd}${tried})`);
}

async function initializeWorkflow(cwd, positionals, options) {
  if (positionals.length !== 1) throw new Error("init requires exactly one plan path");
  const projectRoot = gitRoot(cwd);
  const { planSource, note: planPathNote } = resolvePlanSource(cwd, positionals[0], projectRoot);
  const planContents = await readFile(planSource);
  const dirty = gitStatus(projectRoot);
  if (dirty && !options.allowDirty) {
    throw new Error("Worktree is dirty. Commit/stash first, or intentionally use --allow-dirty to review the existing diff.");
  }

  const defaults = await loadWorkflowDefaults();
  const config = mergeConfig(null, options, { requireModels: true, defaults });
  const planHash = hashBuffer(planContents);
  const key = workflowKeyForPlan(planSource, planHash, options.workflow);
  const paths = workflowPaths(
    projectRoot,
    options.artifactDir || path.join(DEFAULT_ARTIFACT_DIR, key),
  );
  if (existsSync(paths.state)) {
    throw new Error(`A workflow already exists at ${relativeTo(projectRoot, paths.state)}; use configure, run, status, list, or use it intentionally.`);
  }
  await ensureArtifactDirectories(paths);
  await ensureLocalArtifactExclude(
    projectRoot,
    options.artifactDir ? paths.root : path.join(projectRoot, DEFAULT_ARTIFACT_DIR),
  );
  const snapshotPath = path.join(paths.inputs, "plan-v1.md");
  await copyFile(planSource, snapshotPath);

  const baseHead = gitHead(projectRoot);
  const state = makeState({
    projectRoot,
    artifactDir: relativeTo(projectRoot, paths.root),
    workflow: {
      key,
      label: options.workflow ? workflowLabel(options.workflow) : workflowLabel(path.basename(planSource, path.extname(planSource))),
    },
    repository: {
      origin: gitRemoteOrigin(projectRoot),
      baseHead,
    },
    sourcePlan: relativeTo(projectRoot, planSource),
    snapshotPlan: relativeTo(projectRoot, snapshotPath),
    planHash,
    baseHead,
    config,
    wasDirty: Boolean(dirty),
  });
  await writeJson(paths.state, state);
  await writeActiveWorkflow(projectRoot, paths, state);
  await appendTimeline(paths, [
    `# dev-review timeline · ${key}`,
    "",
    `- Plan: \`${relativeTo(projectRoot, planSource)}\` · sha256 \`${planHash.slice(0, 8)}…\``,
    `- Base commit: \`${baseHead}\``,
    `- Developer: \`${config.developerModel}\` · Reviewer: \`${config.reviewerModel}\` · Max rounds: ${config.maxReviewRounds}`,
    `- Created: ${localNow()} (${localTimezoneLabel()})`,
    "",
  ]);
  return {
    state,
    paths,
    message: `Initialized workflow ${key}. Run /dev-review run. Artifacts: ${relativeTo(projectRoot, paths.root)} (timeline: ${relativeTo(projectRoot, timelineFilePath(paths))})${planPathNote ? `\nNote: ${planPathNote}` : ""}`,
  };
}

async function configureWorkflow(cwd, options) {
  const projectRoot = gitRoot(cwd);
  const initialPaths = await existingWorkflowPaths(projectRoot, options);
  const state = await readJson(initialPaths.state);
  if (state.status === "running") throw new Error("Cannot configure a workflow marked running");
  const defaults = await loadWorkflowDefaults();
  state.config = mergeConfig(state, options, { requireModels: true, defaults });
  state.updatedAt = now();
  await writeJson(initialPaths.state, state);
  await writeActiveWorkflow(projectRoot, initialPaths, state);
  return { state, paths: initialPaths, message: `Updated workflow configuration.\n${stateStatus(state, initialPaths)}` };
}

async function adoptWorkflow(cwd, options) {
  const projectRoot = gitRoot(cwd);
  const paths = await existingWorkflowPaths(projectRoot, options);
  const state = await readJson(paths.state);
  if (state.projectRoot === projectRoot) {
    await writeActiveWorkflow(projectRoot, paths, state);
    return { state, paths, message: `Workflow ${state.workflow?.key || state.workflowId} already belongs to this checkout.` };
  }
  if (!gitCommitExists(projectRoot, state.base.head)) {
    throw new Error(`This checkout does not contain the workflow base commit ${state.base.head}. Check out the same repository history before adopting.`);
  }
  const currentOrigin = gitRemoteOrigin(projectRoot);
  const originalOrigin = state.repository?.origin;
  if (originalOrigin && currentOrigin && originalOrigin !== currentOrigin) {
    throw new Error(`Origin mismatch. Workflow was created from ${originalOrigin}; this checkout uses ${currentOrigin}.`);
  }

  const previousRoot = state.projectRoot;
  const previousStatus = state.status;
  const previousGeneration = Number(state.developerSession?.generation || 0);
  state.projectRoot = projectRoot;
  state.artifactDir = relativeTo(projectRoot, paths.root);
  state.repository = {
    origin: originalOrigin || currentOrigin || null,
    baseHead: state.base.head,
  };
  if (state.status === "running") {
    state.status = "ready";
    state.phase = "idle";
  }
  // A persisted Pi transcript can contain absolute paths and local credentials.
  // Rotate it after moving machines; the new developer gets code + final handoffs.
  state.developerSession = {
    generation: previousGeneration + 1,
    sessionId: `developer-m${previousGeneration + 1}`,
  };
  state.migrations = [
    ...(state.migrations || []),
    {
      at: now(),
      fromProjectRoot: previousRoot,
      toProjectRoot: projectRoot,
      previousStatus,
      developerSessionRotated: true,
    },
  ];
  state.updatedAt = now();
  await writeJson(paths.state, state);
  await writeActiveWorkflow(projectRoot, paths, state);
  return {
    state,
    paths,
    message: `Adopted workflow ${state.workflow?.key || state.workflowId} in this checkout. The developer private session was rotated; final handoffs and open issues were preserved.`,
  };
}

async function resolveWorkflow(cwd, positionals, options) {
  const projectRoot = gitRoot(cwd);
  const paths = await existingWorkflowPaths(projectRoot, options);
  const state = await readJson(paths.state);
  if (!["blocked", "ready"].includes(state.status)) {
    throw new Error(`resolve is only available when the workflow is blocked or ready; current status is ${state.status}`);
  }
  const decisionName = `human-decision-r${String(Math.max(1, state.currentRound)).padStart(2, "0")}-${Date.now()}.md`;
  const destination = path.join(paths.handoffs, decisionName);
  const inlineChoice = typeof options.choose === "string" ? options.choose.trim() : "";
  const inlineNote = typeof options.note === "string" ? options.note : "";
  if (positionals.length === 0) {
    // Inline decision: generate the decision document from the current blocker
    // context plus the user's choice/notes, so no assistant is needed to draft it.
    if (!inlineChoice && !inlineNote) {
      throw new Error("resolve requires a decision file path, or an inline decision via --choose/--note");
    }
    const blocked = state.blocked || {};
    const details = blocked.details || {};
    const lines = [
      "# Human decision (inline)",
      "",
      `- **Generated:** ${localNow()}`,
      `- **Round:** ${state.currentRound}`,
      `- **Stop reason:** ${blocked.reason || "human-decision"}`,
      blocked.details?.summary ? `- **Coordinator summary:** ${details.summary}` : "",
      "",
      "## User decision",
      "",
      inlineChoice ? `- **Choice:** ${inlineChoice}` : "",
      inlineNote ? `- **Notes:** ${inlineNote}` : "",
      "",
      "## Instruction to developer",
      "",
      "Apply the user's decision above to the open blocker(s). If it contradicts or amends the frozen plan, treat this document as an authorized plan amendment from the human and state the amendment explicitly in your report.",
      "",
    ].filter(Boolean);
    await writeText(destination, lines.join("\n"));
  } else if (positionals.length === 1) {
    const decisionSource = path.resolve(cwd, positionals[0]);
    if (!existsSync(decisionSource)) throw new Error(`Decision file does not exist: ${decisionSource}`);
    await copyFile(decisionSource, destination);
  } else {
    throw new Error("resolve accepts at most one decision file path");
  }
  if (options.maxRounds) state.config.maxReviewRounds = options.maxRounds;
  state.pendingHumanDecisionPath = relativeTo(projectRoot, destination);
  state.status = "ready";
  state.phase = "idle";
  state.blocked = null;
  state.updatedAt = now();
  await writeJson(paths.state, state);
  await writeActiveWorkflow(projectRoot, paths, state);
  await appendTimeline(paths, timelineLine({
    round: state.currentRound,
    event: "human-decision",
    status: inlineChoice ? truncateText(inlineChoice, 80) : "recorded",
    summary: inlineNote || (positionals.length ? `Decision file: ${relativeTo(projectRoot, path.resolve(cwd, positionals[0]))}` : "Decision recorded."),
    artifact: relativeTo(projectRoot, destination),
  }));
  return {
    state,
    paths,
    message: `Recorded human decision at ${relativeTo(projectRoot, destination)}. Run /dev-review run to continue.`,
  };
}

// Deliberate release of an interrupted invocation. Keeps an audit trail in
// state.unlockLog so manual interventions are reviewable later.
async function unlockWorkflow(cwd, positionals, options) {
  if (positionals.length) throw new Error("unlock accepts options only");
  const projectRoot = gitRoot(cwd);
  const paths = await existingWorkflowPaths(projectRoot, options);
  const state = await readJson(paths.state);
  if (state.status !== "running") {
    throw new Error(`unlock is only needed when the workflow is marked running from an interrupted invocation; current status is ${state.status}`);
  }
  const reason = typeof options.note === "string" && options.note.trim() ? options.note.trim() : "(no reason recorded)";
  state.unlockLog = Array.isArray(state.unlockLog) ? state.unlockLog : [];
  state.unlockLog.push({ at: now(), round: state.currentRound, phase: state.phase, reason });
  state.status = "ready";
  state.updatedAt = now();
  await writeJson(paths.state, state);
  await appendTimeline(paths, timelineLine({
    round: state.currentRound,
    event: "unlock",
    status: "ready",
    summary: `Interrupted ${state.phase || "?"} phase released for retry: ${reason}`,
  }));
  return {
    state,
    paths,
    message: `Unlocked interrupted workflow (round ${state.currentRound}, was phase ${state.phase}). Run /dev-review run to continue: if the round-${state.currentRound} developer report is already on disk, the pending review resumes directly; otherwise a new developer round starts.`,
  };
}

async function emitReport(onReport, notify, report) {
  if (!onReport) return;
  try {
    await onReport(report);
  } catch (error) {
    notify?.(`Could not render ${report.role} report for round ${report.round}: ${error.message}`);
  }
}

/**
 * Detect that the plan file on disk no longer matches the version frozen with
 * this workflow instance. Used to fail loudly instead of silently no-op'ing
 * when `run` is aimed at an instance that already passed but its plan changed
 * (which means the user wants a NEW instance for a new plan version).
 */
async function planChangedSinceFrozen(state, projectRoot) {
  const plan = state?.plan;
  if (!plan || typeof plan.sourcePath !== "string" || typeof plan.sha256 !== "string") return null;
  const sourcePath = path.resolve(projectRoot, plan.sourcePath);
  if (!existsSync(sourcePath)) return null;
  try {
    const current = hashBuffer(await readFile(sourcePath));
    if (current === plan.sha256) return null;
    return { frozen: plan.sha256.slice(0, 8), current: current.slice(0, 8), sourcePath: plan.sourcePath };
  } catch {
    return null;
  }
}

async function runWorkflow({ cwd, options, piInvocation = standalonePiInvocation(), notify, onReport, invokeAgent = invokePiAgent }) {
  const projectRoot = gitRoot(cwd);
  const paths = await existingWorkflowPaths(projectRoot, options);
  const state = await readJson(paths.state);
  if (state.projectRoot !== projectRoot) throw new Error(`Workflow was created at ${state.projectRoot}. After copying its .ai-dev-review directory into this checkout, run /dev-review adopt before resuming.`);
  await writeActiveWorkflow(projectRoot, paths, state);
  if (state.status === "passed") {
    const changed = await planChangedSinceFrozen(state, projectRoot);
    if (changed) {
      throw new Error(
        `Workflow ${state.workflow?.key || paths.root} already passed, and the plan file changed since it was frozen ` +
        `(${changed.frozen} -> ${changed.current}): run start to create a new instance for the new plan version ` +
        `(optionally with --workflow <label>); run only resumes existing instances.`,
      );
    }
    return { state, paths, message: "Workflow already passed. Use status to inspect its final report." };
  }
  if (state.status === "blocked") {
    // Resume surface: re-render the stored escalation in the main TUI so an
    // interrupted session can pick up exactly where the human decision left off.
    const escalationPath = state.blocked?.escalationPath
      ? path.resolve(state.projectRoot, state.blocked.escalationPath)
      : null;
    let markdown = "";
    if (escalationPath) {
      try {
        markdown = await readFile(escalationPath, "utf8");
      } catch {}
    }
    await emitReport(onReport, notify, {
      role: "escalation",
      round: state.currentRound,
      status: state.blocked?.reason || "human-decision",
      summary: state.blocked?.details?.summary || "",
      artifactPath: state.blocked?.escalationPath || "",
      markdown,
    });
    return {
      state,
      paths,
      message: `Workflow is blocked pending a human decision.\n${blockedNotice(state)}\nWrite a decision document (see the decision file) and run /dev-review resolve <file>, then /dev-review run.`,
    };
  }
  if (state.status === "running") {
    throw new Error("Workflow is marked running from an interrupted invocation. Inspect state.json and resolve deliberately before continuing (see /dev-review unlock).");
  }
  // Wrapper: write the escalation file and surface its full markdown in the main TUI
  // (as a collapsible session entry), not just a one-line toast.
  const escalate = async (reason, details) => {
    const escalationPath = await writeEscalation(state, paths, reason, details);
    let markdown = "";
    try {
      markdown = await readFile(escalationPath, "utf8");
    } catch {}
    await emitReport(onReport, notify, {
      role: "escalation",
      round: state.currentRound,
      status: reason,
      summary: details.summary || "",
      artifactPath: relativeTo(state.projectRoot, escalationPath),
      markdown,
    });
    return escalationPath;
  };
  // Review phase for a round whose developer report is already complete.
  // Extracted so an interrupted invocation can resume the pending review
  // without burning another developer round.
  const runReviewPhase = async (round, developerMarkdownPath, history) => {
    state.phase = "review";
    state.updatedAt = now();
    await writeJson(paths.state, state);
    let review;
    let reviewerBefore;
    try {
      reviewerBefore = await repositoryFingerprint(projectRoot);
      const output = await invokeAgent({
        role: "reviewer",
        state,
        paths,
        round,
        task: makeReviewerTask(state, paths, round, relativeTo(projectRoot, developerMarkdownPath)),
        piInvocation,
        notify,
      });
      const reviewerAfter = await repositoryFingerprint(projectRoot);
      if (reviewerBefore !== reviewerAfter) {
        throw new Error("Reviewer changed the repository. Reviewers are read-only; inspect and revert/unblock this manually.");
      }
      review = normalizeReviewerReport(extractJsonObject(output.finalText), round, state.openIssues);
    } catch (error) {
      await escalate("reviewer-protocol-or-execution-error", {
        summary: error.message,
      });
      return { state, paths, message: `Review requires human attention.\n${blockedNotice(state)}` };
    }

    const nextOpenIssues = applyReviewReport(state, review, round);
    if (review.decision === "pass" && nextOpenIssues.length > 0) {
      await escalate("invalid-review-pass", {
        summary: "Reviewer returned pass while unresolved issues remained. This is a protocol violation and needs human inspection.",
      });
      return { state, paths, message: `Invalid reviewer pass stopped.\n${blockedNotice(state)}` };
    }
    if (review.decision === "fix_required" && nextOpenIssues.length === 0) {
      await escalate("invalid-review-fix-required", {
        summary: "Reviewer returned fix_required but did not leave any open issue. This is a protocol violation and needs human inspection.",
      });
      return { state, paths, message: `Invalid reviewer result stopped.\n${blockedNotice(state)}` };
    }

    state.openIssues = nextOpenIssues;
    const reviewerJsonPath = path.join(paths.handoffs, `reviewer-r${String(round).padStart(2, "0")}.json`);
    const reviewerMarkdownPath = path.join(paths.handoffs, `reviewer-r${String(round).padStart(2, "0")}.md`);
    const reviewerMarkdownContent = reviewerMarkdown({
      round,
      report: review,
      planPath: state.plan.snapshotPath,
      developerPath: relativeTo(projectRoot, developerMarkdownPath),
      openIssues: state.openIssues,
    });
    await writeJson(reviewerJsonPath, review);
    await writeText(reviewerMarkdownPath, reviewerMarkdownContent);
    await emitReport(onReport, notify, {
      role: "reviewer",
      round,
      status: review.decision,
      summary: review.summary,
      artifactPath: relativeTo(projectRoot, reviewerMarkdownPath),
      markdown: reviewerMarkdownContent,
    });
    await appendTimeline(paths, timelineLine({
      round,
      event: "review",
      status: review.decision,
      summary: review.summary,
      artifact: relativeTo(projectRoot, reviewerMarkdownPath),
    }));
    history.reviewerPath = relativeTo(projectRoot, reviewerMarkdownPath);
    history.decision = review.decision;

    if (review.decision === "spec_blocked") {
      await escalate("reviewer-spec-blocked", {
        summary: review.summary,
        questions: review.spec_questions,
      });
      return {
        state,
        paths,
        message: `Review requires a product decision.\n${blockedNotice(state)}\nWrite a decision document and run /dev-review resolve <file>, then /dev-review run.`,
      };
    }

    if (review.decision === "pass") {
      state.status = "passed";
      state.phase = "complete";
      state.blocked = null;
      state.updatedAt = now();
      const finalPath = path.join(paths.reports, "final-report.md");
      await writeText(finalPath, finalReportMarkdown(state));
      await writeJson(paths.state, state);
      await appendTimeline(paths, timelineLine({
        round,
        event: "workflow",
        status: "passed",
        summary: "All open issues verified closed; independent review passed.",
        artifact: relativeTo(projectRoot, finalPath),
      }));
      return { state, paths, message: `Workflow passed after ${round} review round(s). Final report: ${relativeTo(projectRoot, finalPath)}` };
    }

    state.status = "ready";
    state.phase = "idle";
    state.updatedAt = now();
    await writeJson(paths.state, state);
    if (round >= state.config.maxReviewRounds) {
      await escalate("max-rounds", {
        summary: `The reviewer still requested fixes after round ${round}, which is the configured maximum of ${state.config.maxReviewRounds}.`,
      });
      return { state, paths, message: `Stopped after max rounds.\n${blockedNotice(state)}` };
    }
    return null;
  };
  // Phase-aware resume: if the previous invocation died after the developer
  // finished round N but before its review completed, continue straight into
  // the review instead of burning another developer round.
  if (state.status === "ready" && state.currentRound > 0) {
    const lastHistory = state.history.at(-1);
    const roundKey = String(state.currentRound).padStart(2, "0");
    const developerJsonPath = path.join(paths.handoffs, `developer-r${roundKey}.json`);
    if (
      lastHistory
      && lastHistory.round === state.currentRound
      && !lastHistory.reviewerPath
      && existsSync(developerJsonPath)
    ) {
      try {
        // 开发者交接 JSON 是报告文件，不是工作流状态——不能用带 schemaVersion 校验的
        // readJson（会抛 Unsupported schema 并被下方 catch 吞掉，静默烧掉一个 dev 轮次）。
        const priorDeveloper = JSON.parse(await readFile(developerJsonPath, "utf8"));
        if (priorDeveloper && priorDeveloper.status === "done") {
          const developerMarkdownPath = path.resolve(projectRoot, lastHistory.developerPath || path.join(paths.handoffs, `developer-r${roundKey}.md`));
          notify?.(`Resuming pending review for round ${state.currentRound} (developer report already on disk; skipping a redundant developer round).`);
          const reviewResult = await runReviewPhase(state.currentRound, developerMarkdownPath, lastHistory);
          if (reviewResult) return reviewResult;
        }
      } catch (error) {
        notify?.(`Resume check skipped for round ${state.currentRound}: ${error && error.message ? error.message : error}`);
      }
    }
  }
  if (options.maxRounds) state.config.maxReviewRounds = options.maxRounds;
  if (state.currentRound >= state.config.maxReviewRounds) {
    await escalate("max-rounds", {
      summary: `The configured limit of ${state.config.maxReviewRounds} review rounds was reached before a pass.`,
    });
    return { state, paths, message: `Stopped for human decision.\n${blockedNotice(state)}` };
  }

  await ensureArtifactDirectories(paths);
  while (state.currentRound < state.config.maxReviewRounds) {
    const round = state.currentRound + 1;
    state.status = "running";
    state.phase = "development";
    state.updatedAt = now();
    await writeJson(paths.state, state);

    const previousReviewPath = state.history.at(-1)?.reviewerPath || null;
    const humanDecisionPath = state.pendingHumanDecisionPath;
    let developer;
    try {
      const output = await invokeAgent({
        role: "developer",
        state,
        paths,
        round,
        task: makeDeveloperTask(state, paths, round, previousReviewPath, humanDecisionPath),
        piInvocation,
        notify,
      });
      developer = normalizeDeveloperReport(extractJsonObject(output.finalText));
    } catch (error) {
      state.currentRound = round;
      // Surface the developer's actual report/questions in the escalation when the
      // failure is a protocol-validation error (the agent did answer, just malformed).
      let rawReport = null;
      try {
        rawReport = extractJsonObject(output.finalText);
      } catch {}
      const devSummary = rawReport && typeof rawReport.summary === "string" ? rawReport.summary : "";
      const firstBlocker = Array.isArray(rawReport?.blockers) && rawReport.blockers.length
        ? String(rawReport.blockers[0])
        : "";
      const summary = [
        error.message,
        devSummary && `Developer: ${devSummary}`,
        firstBlocker && `Question: ${firstBlocker}`,
      ].filter(Boolean).join(" — ");
      await escalate("developer-protocol-or-execution-error", {
        summary,
        ...(rawReport ? { rawReport: JSON.stringify(rawReport, null, 2) } : {}),
      });
      return { state, paths, message: `Developer run stopped for human attention.\n${blockedNotice(state)}` };
    }

    const developerJsonPath = path.join(paths.handoffs, `developer-r${String(round).padStart(2, "0")}.json`);
    const developerMarkdownPath = path.join(paths.handoffs, `developer-r${String(round).padStart(2, "0")}.md`);
    const developerMarkdownContent = developerMarkdown({
      round,
      report: developer,
      state,
      planPath: state.plan.snapshotPath,
      previousReviewPath,
      humanDecisionPath,
    });
    await writeJson(developerJsonPath, developer);
    await writeText(developerMarkdownPath, developerMarkdownContent);
    await emitReport(onReport, notify, {
      role: "developer",
      round,
      status: developer.status,
      summary: developer.summary,
      artifactPath: relativeTo(projectRoot, developerMarkdownPath),
      markdown: developerMarkdownContent,
    });
    await appendTimeline(paths, timelineLine({
      round,
      event: "development",
      status: developer.status,
      summary: developer.summary,
      artifact: relativeTo(projectRoot, developerMarkdownPath),
    }));

    state.currentRound = round;
    state.pendingHumanDecisionPath = null;
    const history = {
      round,
      startedAt: now(),
      developerPath: relativeTo(projectRoot, developerMarkdownPath),
      reviewerPath: null,
      decision: null,
    };
    state.history.push(history);

    if (developer.status === "blocked") {
      await escalate("developer-blocked", {
        summary: developer.summary,
        questions: developer.blockers,
      });
      return { state, paths, message: `Development requires a human decision.\n${blockedNotice(state)}` };
    }

    const reviewResult = await runReviewPhase(round, developerMarkdownPath, history);
    if (reviewResult) return reviewResult;
  }

  throw new Error("Workflow loop exited unexpectedly");
}

export async function runCommand({ args, cwd = process.cwd(), piInvocation, notify = console.log, onReport, invokeAgent } = {}) {
  try {
    const tokens = splitArguments(args);
    const command = tokens.shift() || "help";
    const { positionals, options } = parseOptions(tokens);
    if (command === "help" || options.help) return { ok: true, message: HELP.trim() };
    if (command === "init") {
      const result = await initializeWorkflow(cwd, positionals, options);
      return { ok: true, message: result.message, ...result };
    }
    if (command === "start") {
      const initialized = await initializeWorkflow(cwd, positionals, options);
      const result = await runWorkflow({
        cwd,
        options: { ...options, workflow: initialized.state.workflow?.key },
        piInvocation,
        notify,
        onReport,
        invokeAgent,
      });
      return {
        ok: true,
        message: `${initialized.message}
${result.message}`,
        ...result,
      };
    }
    if (command === "status") {
      if (positionals.length) throw new Error("status does not accept positional arguments");
      const root = gitRoot(cwd);
      const paths = await existingWorkflowPaths(root, options);
      const state = await readJson(paths.state);
      return { ok: true, message: stateStatus(state, paths), state, paths };
    }
    if (command === "list") {
      if (positionals.length) throw new Error("list does not accept positional arguments");
      const root = gitRoot(cwd);
      return { ok: true, message: await listWorkflows(root) };
    }
    if (command === "use") {
      if (positionals.length !== 1) throw new Error("use requires exactly one workflow id");
      const root = gitRoot(cwd);
      const result = await selectWorkflow(root, positionals[0]);
      return { ok: true, message: `Active workflow set to ${result.state.workflow?.key || positionals[0]}.\n${stateStatus(result.state, result.paths)}`, ...result };
    }
    if (command === "configure") {
      if (positionals.length) throw new Error("configure accepts options only");
      const result = await configureWorkflow(cwd, options);
      return { ok: true, message: result.message, ...result };
    }
    if (command === "adopt") {
      if (positionals.length) throw new Error("adopt accepts options only");
      const result = await adoptWorkflow(cwd, options);
      return { ok: true, message: result.message, ...result };
    }
    if (command === "resolve") {
      const result = await resolveWorkflow(cwd, positionals, options);
      return { ok: true, message: result.message, ...result };
    }
    if (command === "unlock") {
      const result = await unlockWorkflow(cwd, positionals, options);
      return { ok: true, message: result.message, ...result };
    }
    if (command === "run") {
      if (positionals.length) throw new Error("run accepts options only");
      const result = await runWorkflow({ cwd, options, piInvocation, notify, onReport, invokeAgent });
      return { ok: true, message: result.message, ...result };
    }
    throw new Error(`Unknown /dev-review command: ${command}`);
  } catch (error) {
    return { ok: false, message: `dev-review: ${error.message}` };
  }
}

export {
  DEFAULT_ARTIFACT_DIR,
  blockedNotice,
  classifyAgentFailure,
  extractJsonObject,
  initializeWorkflow,
  adoptWorkflow,
  localNow,
  localTimezoneLabel,
  normalizeDeveloperReport,
  normalizeReviewerReport,
  planChangedSinceFrozen,
  resolvePlanSource,
  runWorkflow,
  splitArguments,
  timelineFilePath,
  timelineLine,
  workflowPaths,
};

// Robust direct-execution check: argv[1] may differ from import.meta.url by
// symlinks (e.g. /tmp -> /private/tmp on macOS), so compare both raw and
// realpath forms.
const executedDirectly = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();
if (executedDirectly) {
  const result = await runCommand({ args: process.argv.slice(2), cwd: process.cwd() });
  console.log(result.message);
  process.exitCode = result.ok ? 0 : 1;
}
