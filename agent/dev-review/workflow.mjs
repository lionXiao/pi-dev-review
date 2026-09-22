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
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCHEMA_VERSION = 1;
const DEFAULT_ARTIFACT_DIR = ".ai-dev-review";
const DEFAULT_MAX_ROUNDS = 10;
const DEFAULT_DEVELOPER_RESET_AFTER_ROUNDS = 4;
const DEFAULT_AGENT_RETRIES = 2;
// Developer-only skills injected with pi's repeatable `--skill <path>` flag.
// Roles run with `--no-skills`, so this is an explicit channel (caller decides),
// never local skill discovery.
const DEFAULT_DEV_SKILLS = [];
const AGENT_RETRY_BASE_DELAY_MS = 5000;
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
  --workflow <label>                Human-readable workflow label; REPLACES the plan-derived name (not a prefix), so include the version — e.g. v1.2-b2c-rerun
  --artifact-dir <dir>              Explicit artifact directory; otherwise uses ${DEFAULT_ARTIFACT_DIR}/<prd-name>--<plan-hash>
  --max-rounds <n>                  Developer+review cycles before human escalation (default: ${DEFAULT_MAX_ROUNDS})
  --developer-reset-after <n>       Rotate the developer's private Pi session after n rounds (default: ${DEFAULT_DEVELOPER_RESET_AFTER_ROUNDS})
  --agent-retries <n>               Automatic retries per agent run on transient execution failures (default: ${DEFAULT_AGENT_RETRIES})
  --dev-skill <path>                Extra Pi skill for the developer only; repeatable, file or directory
  --test <command>                  Required test command; repeatable
  --developer-thinking <level>      Pi thinking level for the developer
  --reviewer-thinking <level>       Pi thinking level for the reviewer
  --allow-dirty                     Permit initializing from an already dirty worktree

Roles run with skill discovery disabled, so the developer only sees the skills
explicitly passed via --dev-skill. The reviewer never receives skills, and the
frozen list is recorded in the workflow state for audit.

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
    "--agent-retries",
    "--dev-skill",
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
      else if (token === "--dev-skill") (options.devSkills ??= []).push(value);
      else if (token === "--developer-model") options.developerModel = value;
      else if (token === "--reviewer-model") options.reviewerModel = value;
      else if (token === "--artifact-dir") options.artifactDir = value;
      else if (token === "--workflow") options.workflow = value;
      else if (token === "--max-rounds") options.maxRounds = numberOption(value, token);
      else if (token === "--developer-reset-after") options.developerResetAfterRounds = numberOption(value, token);
      else if (token === "--agent-retries") options.agentRetries = numberOption(value, token, 0);
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

// Preserve the child agent's final message verbatim when a protocol error stops the
// loop, so the human can see what it actually said even when the JSON cannot parse.
async function writeProtocolRawText(paths, role, round, finalText) {
  if (typeof finalText !== "string" || !finalText) return null;
  const filePath = path.join(paths.handoffs, `${role}-r${String(round).padStart(2, "0")}.raw.txt`);
  await writeText(filePath, finalText);
  return filePath;
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
    // Attempt counters: both roles see "which attempt is this", and the stall
    // gate reads them without re-deriving per-round history.
    partial_streak: Number.isInteger(issue.partial_streak) ? issue.partial_streak : 0,
    rounds_open: Number.isInteger(issue.rounds_open) ? issue.rounds_open : 0,
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
    // Optional lineage declaration: the reviewer confirms that this finding
    // repeats a previously reported family. Optional on purpose — the engine's
    // mechanical signal is the fallback, so older reviewers keep working.
    const repeatOf = asOptionalString(finding.repeat_of, `reviewer.new_findings[${index}].repeat_of`);
    return {
      id,
      severity: enumValue(finding.severity, `reviewer.new_findings[${index}].severity`, ["critical", "major", "minor"]),
      location: asString(finding.location, `reviewer.new_findings[${index}].location`),
      requirement: asString(finding.requirement, `reviewer.new_findings[${index}].requirement`),
      evidence: asString(finding.evidence, `reviewer.new_findings[${index}].evidence`),
      required_fix: asString(finding.required_fix, `reviewer.new_findings[${index}].required_fix`),
      ...(repeatOf ? { repeat_of: repeatOf } : {}),
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
    // Consecutive non-closed verdicts: the stall gate's earliest signal
    // (softStreak 2 = "this issue survived two reviews without closing").
    issue.partial_streak = (Number.isInteger(issue.partial_streak) ? issue.partial_streak : 0) + 1;
    issue.rounds_open = round - issue.first_round;
    if (verdict.required_fix) issue.required_fix = verdict.required_fix;
  }
  for (const finding of review.new_findings) {
    next.set(finding.id, {
      ...finding,
      first_round: round,
      last_review_round: round,
      last_verdict: "new",
      last_evidence: finding.evidence,
      partial_streak: 0,
      rounds_open: 0,
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
${details.rawReport ? `\n## Developer report (recovered)\n\n${rawReportMarkdown(details.rawReport)}\n` : ""}${details.rawTextPath ? `\n## Raw agent output (verbatim)\n\nThe agent's final message was saved unchanged at ${markdownCode(details.rawTextPath)}.\n` : ""}${details.familyReport ? `\n## 停滞家族报告（引擎生成）\n\n${details.familyReport}\n` : ""}

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

  const task = `You are the DEVELOPMENT role for round ${round}.

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
  // Conditional compensation, never standing doctrine: the frozen role prompt
  // files are untouched, and a non-firing round yields byte-identical output.
  const stall = stallSignalForRound(state, round);
  const directive = stall?.soft?.fired ? renderStallDirective(stall.families) : "";
  return directive ? `${task}\n\n${directive}` : task;
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

  const task = `You are the independent REVIEW role for round ${round}.

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
  // Reviewer-side soft signal: unconnected findings that need a confirm/separate
  // decision (repeat_of) before the engine may count them as one family.
  const stall = stallSignalForRound(state, round);
  const candidates = stall?.candidates?.length ? renderStallCandidateSection(stall.candidates) : "";
  return candidates ? `${task}\n\n${candidates}` : task;
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

function excerptAround(text, position, radius = 90) {
  const from = Math.max(0, Math.min(text.length, position - radius));
  const to = Math.max(0, Math.min(text.length, position + radius));
  return `…${text.slice(from, to).replace(/\s+/g, " ").trim()}…`;
}

function malformedJsonMessage(span, text) {
  if (span.unterminated) {
    return `Agent output contains an unterminated JSON object starting at offset ${span.start} (a '{' is never closed, so the response may be truncated). Near: ${excerptAround(text, span.start)}`;
  }
  const detail = span.error?.message || "invalid JSON syntax";
  const match = /at position (\d+)/.exec(detail);
  const focus = match ? span.start + Number(match[1]) : span.start;
  return `Agent returned malformed JSON: ${detail}. Re-emit exactly one well-formed JSON object (no prose, no '+' string concatenation, no trailing commas). Near: ${excerptAround(text, focus)}`;
}

function extractJsonObject(text) {
  const parsed = [];
  const broken = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let closedAt = -1;
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
          closedAt = index;
          break;
        }
      }
    }
    if (closedAt < 0) {
      broken.push({ start, end: text.length, source: text.slice(start), unterminated: true });
      continue;
    }
    const source = text.slice(start, closedAt + 1);
    try {
      parsed.push({ start, end: closedAt + 1, source, value: JSON.parse(source) });
    } catch (error) {
      broken.push({ start, end: closedAt + 1, source, error });
    }
  }
  const broadest = (spans) => spans.slice().sort((left, right) => right.source.length - left.source.length)[0];
  if (parsed.length === 0) {
    if (broken.length) throw new Error(malformedJsonMessage(broadest(broken), text));
    throw new Error(`Agent did not return a JSON object. Final output excerpt: ${text.slice(0, 500)}`);
  }
  const best = broadest(parsed);
  // A parseable fragment nested inside a larger span that failed to parse means the
  // agent tried to send one big JSON object and broke its syntax. Returning that
  // fragment would surface a misleading schema error ("status must be one of ...")
  // instead of the real syntax problem, so fail with the enclosing span's error.
  const enclosing = broken
    .filter((span) => span.start < best.start && span.end >= best.end)
    .sort((left, right) => left.source.length - right.source.length)[0];
  if (enclosing) throw new Error(malformedJsonMessage(enclosing, text));
  return best.value;
}

function standalonePiInvocation() {
  return { command: process.env.PI_BIN || "pi", args: [] };
}

/**
 * Execution failures worth retrying automatically: provider stream breaks,
 * network/timeout faults, and unclassified child crashes. Auth/permission and
 * quota/billing exhaustion cannot be changed by retrying, and an aborted run
 * or a failed spawn needs a human (or a fixed environment) instead.
 */
const NON_RETRYABLE_AGENT_FAILURE_PATTERN = /(insufficient_?quota|quota exceeded|out of budget|available balance|billing|欠费|余额|invalid api key|unauthor|authentication|not authorized|permission denied|forbidden)/i;

function agentFailureRetryable({ kind = "", errorMessage = "", stderr = "" } = {}) {
  if (kind === "aborted" || kind === "spawn") return false;
  return !NON_RETRYABLE_AGENT_FAILURE_PATTERN.test(`${errorMessage}\n${stderr}`);
}

function agentFailureError(message, details) {
  const error = new Error(message);
  error.agentFailure = { ...details, retryable: agentFailureRetryable(details) };
  return error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Overridable for tests / debugging via DEV_REVIEW_RETRY_BASE_MS. */
function agentRetryBaseDelayMs() {
  const configured = Number(process.env.DEV_REVIEW_RETRY_BASE_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : AGENT_RETRY_BASE_DELAY_MS;
}

async function invokePiAgent({ role, state, paths, round, task, piInvocation, notify, onStats }) {
  const developer = role === "developer";
  const rolePrompt = await loadRolePrompt(developer ? DEV_ROLE_PROMPT : REVIEW_ROLE_PROMPT);
  const config = developer
    ? { model: state.config.developerModel, thinking: state.config.developerThinking, tools: DEV_TOOLS, devSkills: state.config.devSkills ?? DEFAULT_DEV_SKILLS }
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
    // Skills are developer-only by design: the reviewer's value is independence,
    // and injected how-to guidance would bias its verdict. `--skill` is additive
    // even though `--no-skills` is set, so this does not reopen discovery.
    for (const skill of config.devSkills ?? []) args.push("--skill", skill);
    const generation = Math.floor((round - 1) / state.config.developerResetAfterRounds) + 1;
    state.developerSession = { generation, sessionId: `developer-g${generation}` };
    args.push("--session-dir", paths.developerSessions, "--session-id", state.developerSession.sessionId);
  } else {
    // Record the reviewer transcript too so the full process is inspectable;
    // reviewer still gets a fresh one-off session per round (no cross-round memory).
    args.push("--session-dir", paths.reviewerSessions, "--session-id", `reviewer-r${String(round).padStart(2, "0")}`);
  }
  args.push(task);

  const configuredRetries = Number(state.config.agentRetries);
  const retries = Number.isFinite(configuredRetries) && configuredRetries >= 0
    ? Math.floor(configuredRetries)
    : DEFAULT_AGENT_RETRIES;
  const maxAttempts = retries + 1;
  // One stats object across attempts: a retried round reports the total tokens
  // it actually burned, not just the last attempt's numbers.
  const stats = createUsageStats();
  const label = `${developer ? "dev" : "review"} r${round}`;

  // `reports/timeline.md` is the full process log: open a section per phase so
  // the transcript below reads chronologically as dev r1 → review r1 → dev r2 …
  await appendTimeline(paths, transcriptPhaseHeader({ role, round, model: config.model }));
  notify?.(`${developer ? "Development" : "Review"} agent: round ${round} started (${config.model}${config.thinking ? ` · thinking ${config.thinking}` : ""}).`);
  for (let attempt = 1; ; attempt += 1) {
    try {
      const output = await spawnPiAgentOnce({ role, state, paths, round, args, piInvocation, notify, onStats, stats });
      notify?.(`${developer ? "Development" : "Review"} agent: round ${round} finished.`);
      return output;
    } catch (error) {
      const failure = error?.agentFailure
        || { kind: "unknown", retryable: false, errorMessage: error?.message || String(error) };
      if (!failure.retryable || attempt >= maxAttempts) {
        // Retried runs are part of the record: callers (and escalation
        // summaries) should see how many attempts the round burned.
        if (attempt > 1 && error instanceof Error) error.message = `${error.message} (after ${attempt}/${maxAttempts} attempts)`;
        throw error;
      }
      const delayMs = agentRetryBaseDelayMs() * 2 ** (attempt - 1);
      const reason = truncateText(failure.errorMessage || error.message, 200);
      notify?.(`[${label}] ⚠️ attempt ${attempt}/${maxAttempts} failed: ${reason} — retrying in ${Math.round(delayMs / 1000)}s.`);
      await appendTimeline(paths, timelineLine({
        round,
        event: "agent-retry",
        status: `${attempt}/${maxAttempts}`,
        summary: `${developer ? "developer" : "reviewer"} attempt ${attempt} failed: ${reason} · retrying in ${Math.round(delayMs / 1000)}s`,
      }));
      await sleep(delayMs);
    }
  }
}

/**
 * One Pi child process for one role+round. The caller owns `stats` so retried
 * attempts aggregate into a single usage entry for the round. Retries reuse
 * the same session id: pi drops errored/aborted assistant turns from provider
 * input, so the retry resumes the transcript without the broken turn.
 */
async function spawnPiAgentOnce({ role, state, paths, round, args, piInvocation, notify, onStats, stats }) {
  const developer = role === "developer";
  return new Promise((resolve, reject) => {
    const child = spawn(piInvocation.command, args, {
      cwd: state.projectRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdoutBuffer = "";
    let stderr = "";
    let finalText = "";
    // Final assistant message stop state: pi's `--mode json` exits 0 even after
    // a provider stream error, so the stop reason is the only reliable signal.
    let lastAssistant = null;
    // Current provider request timing (one per assistant message).
    let request = null;

    const finalizeRequest = () => {
      if (!request) return;
      addUsageRequest(stats, request);
      request = null;
      const entry = usageEntry({ role, round, stats });
      onStats?.({ role, round, line: entry.line, stats: entry });
      queueUsageEntry(paths, entry);
    };

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
      if (event.type === "message_start" && event.message?.role === "assistant") {
        // message.timestamp is stamped by pi just before it sends the provider
        // request; use it as the TTFT origin. Missing on some providers → fall back.
        const requestAt = Number(event.message?.timestamp);
        request = {
          startAt: Date.now(),
          requestAt: Number.isFinite(requestAt) ? requestAt : null,
          firstDeltaAt: null,
          endAt: null,
          usage: null,
        };
        return;
      }
      if (event.type === "message_update" && request && !request.firstDeltaAt) {
        // First streamed token (text or thinking): TTFT reference point.
        request.firstDeltaAt = Date.now();
        return;
      }
      if (event.type === "message_end" && event.message?.role === "assistant") {
        if (!request) request = { startAt: null, firstDeltaAt: null, endAt: null, usage: null };
        request.endAt = Date.now();
        request.usage = event.message.usage || null;
        if (request.usage) finalizeRequest();
        else request = null; // Provider reported no usage; drop the partial timing.
        finalText = messageText(event.message);
        lastAssistant = {
          stopReason: typeof event.message.stopReason === "string" ? event.message.stopReason : null,
          errorMessage: typeof event.message.errorMessage === "string" ? event.message.errorMessage : "",
        };
        if (streamEnabled) notify?.(`[${label}] 💬 ${truncate(finalText, 220)}`);
        queueTimelineLines(paths, transcriptAssistantBlock(event.message));
      } else if (event.type === "tool_execution_end") {
        queueTimelineLines(paths, transcriptToolResultBlock(event));
        if (streamEnabled && event.isError) {
          notify?.(`[${label}] ⚠️ ${event.toolName} failed: ${truncate(event.result, 160)}`);
        }
      } else if (streamEnabled && event.type === "tool_execution_start") {
        notify?.(`[${label}] 🔧 ${event.toolName} ${truncate(JSON.stringify(event.args ?? {}), 140)}`);
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
    child.on("error", (error) => reject(agentFailureError(
      `Could not start Pi ${role} agent: ${error.message}`,
      { kind: "spawn", errorMessage: error.message, stderr: "" },
    )));
    child.on("close", (code, signal) => {
      if (stdoutBuffer.trim()) processLine(stdoutBuffer);
      const stderrTail = stderr.slice(-1200).trim();
      const failure = {
        exitCode: code,
        signal: signal || null,
        errorMessage: lastAssistant?.errorMessage || "",
        stderr: stderr.slice(-1200),
        partialText: finalText || "",
      };
      if (code !== 0) {
        const hint = classifyAgentFailure(stderr);
        reject(agentFailureError(
          `Pi ${role} agent failed (exit ${code ?? "unknown"}${signal ? `, ${signal}` : ""})${hint ? ` [likely ${hint}]` : ""}: ${stderrTail}`,
          { ...failure, kind: "exit" },
        ));
        return;
      }
      // `--mode json` exits 0 even when the final assistant message errored
      // (only text mode maps stopReason "error"/"aborted" to exit 1), so the
      // stop reason must be inspected explicitly. Partial text on an errored
      // turn is a truncated report, never a valid one.
      if (lastAssistant?.stopReason === "error") {
        reject(agentFailureError(
          `Pi ${role} agent stream ended with error: ${lastAssistant.errorMessage || "unknown provider error"}`,
          { ...failure, kind: "stream-error" },
        ));
        return;
      }
      if (lastAssistant?.stopReason === "aborted") {
        reject(agentFailureError(
          `Pi ${role} agent run was aborted${lastAssistant.errorMessage ? `: ${lastAssistant.errorMessage}` : ""}`,
          { ...failure, kind: "aborted" },
        ));
        return;
      }
      if (!finalText) {
        const hint = classifyAgentFailure(stderr);
        reject(agentFailureError(
          `Pi ${role} agent ended without a final assistant message${hint ? ` [likely ${hint}]` : ""}: ${stderrTail}`,
          { ...failure, kind: "no-final-message" },
        ));
        return;
      }
      resolve({ finalText, stderr, usage: usageEntry({ role, round, stats }) });
    });
  });
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

// ---- Stall detection (mechanical routing only) ---------------------------
// Motivating incidents (frozen fixtures under tests/fixtures/stall): b2a (19
// rounds, 7 manual max-rounds extensions), b2c (8 rounds, the human stopped the
// run with a "whack-a-mole" note) and a3e2 (11 rounds). All three share one
// failure mode: the reviewer names the next reachable path, the developer fixes
// exactly that path, and the engine has no idea the same root-cause family
// survived another round.
//
// This layer is deliberately mechanical — counting plus string comparison, no
// LLM, no network, no filesystem access. It only claims "these findings are
// tightly linked to something that is still open"; it never declares "same
// root cause". Semantic confirmation stays with the reviewer (`repeat_of`) and
// scope decisions stay with the human. The compensation texts (STALL_DIRECTIVE /
// STALL_CANDIDATES) are data: deleting them changes nothing about routing,
// escalation or observation.
//
// Threshold calibration (tests/fixtures/stall/labels.json is the contract; this
// table is the result of replaying all 17 labelled runs):
//   linkThreshold 1.75 · reqSim 0.35 · identSim 0.08
//   softStreak 2 · softSpan 3 · hardStreak 3 · hardSpan 4
// A new finding only links to a parent that was still open when the round
// started, and a parent that survived the round's verdicts contributes half a
// point (parentOpen); a parent verified_closed in this same round keeps zero
// half-weight and can only link through its own text/file signals.
//
// identSim consumes evidence+required_fix only (plan §4.2) and linkThreshold
// holds at 1.75 after that corrected, narrower identifier set: the label-set
// required configuration space is identSim ≤ 0.10 with linkThreshold in
// [1.6, 2.0]. Below/above that space either the b2a family stops clustering
// (R17-001's tie is sameFile + its 0.125 evidence-identifier overlap with
// R15-001) or a known L2 miss joins the primary family instead of surfacing in
// L3. Values 0.08/1.75 leave margin on both edges: the critical pair sits at
// exactly 0.10, and 1.75 is above every "one weak signal + parentOpen" pair
// (1.5) while still linking two weak signals or one strong signal (≥2.0).
// One strong signal therefore links (cross reference, or same file plus a
// requirement/identifier overlap), while a parent closed in an earlier round is
// never resurrected into the family.

const STALL_HAN_RUN = /[\u3400-\u4dbf\u4e00-\u9fff]+/g;
const STALL_IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]{4,}/g;
const STALL_LOCATION_LINE = /:\d+(?:[-–—]\d+)?(?:,\d+(?:[-–—]\d+)?)*/;

export const DEFAULT_STALL_GATE = Object.freeze({
  enabled: true,
  linkThreshold: 1.75,
  reqSim: 0.35,
  identSim: 0.08,
  softStreak: 2,
  softSpan: 3,
  hardStreak: 3,
  hardSpan: 4,
});

/**
 * Accept either the frozen per-instance `state.config.stallGate` object or a
 * bare gate object, and fill missing/invalid values from the defaults. Old
 * instances without the field keep working (the gate defaults to enabled);
 * malformed numbers are ignored rather than crashing a review round.
 */
function normalizeStallGate(value) {
  const nested = value && typeof value === "object" && !Array.isArray(value)
    ? value.stallGate
    : undefined;
  const source = nested && typeof nested === "object" && !Array.isArray(nested) ? nested : value;
  const gate = { ...DEFAULT_STALL_GATE };
  if (!source || typeof source !== "object" || Array.isArray(source)) return gate;
  if (source.enabled === false) gate.enabled = false;
  for (const key of ["linkThreshold", "reqSim", "identSim"]) {
    const parsed = Number(source[key]);
    if (Number.isFinite(parsed) && parsed >= 0) gate[key] = parsed;
  }
  for (const key of ["softStreak", "softSpan", "hardStreak", "hardSpan"]) {
    const parsed = Number(source[key]);
    if (Number.isInteger(parsed) && parsed >= 1) gate[key] = parsed;
  }
  return gate;
}

/** File part(s) of a `path:line` location; multi-location findings keep them all. */
function stallLocationFiles(location) {
  const files = new Set();
  for (const part of String(location ?? "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const file = trimmed.replace(STALL_LOCATION_LINE, "").trim();
    if (file) files.add(file);
  }
  return files;
}

/** Remove plan-reference boilerplate (F8 / Q3 / R1-003 / §1.1 / human-decision-r15…). */
function stripStallPlanNoise(text) {
  return String(text ?? "")
    .replace(/human-decision-r\d+/gi, " ")
    .replace(/§\s*[\d.]+[A-Za-z]?/g, " ")
    .replace(/\b[A-Za-z]{1,4}-?\d+(?:[-.]\d+)*\b/g, " ")
    .replace(/[「」“”"']/g, " ");
}

/** Chinese character bigrams over Han runs, so punctuation/Latin gaps never create bigrams. */
function stallRequirementBigrams(requirement) {
  const grams = new Set();
  for (const run of stripStallPlanNoise(requirement).match(STALL_HAN_RUN) || []) {
    for (let index = 0; index + 1 < run.length; index += 1) grams.add(run.slice(index, index + 2));
  }
  return grams;
}

/** ASCII identifiers of length >= 5 (function names, types, fields). */
function stallIdentifiers(text) {
  return new Set(String(text ?? "").match(STALL_IDENTIFIER) || []);
}

function stallJaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function stallFindingText(finding) {
  return [finding?.requirement, finding?.evidence, finding?.required_fix].filter(Boolean).join("\n");
}

/** Plan §4.2: the identifier signal reads evidence+required_fix only. */
function stallEvidenceText(finding) {
  return [finding?.evidence, finding?.required_fix].filter(Boolean).join("\n");
}

/**
 * Link signals for one ordered pair (child = newer finding, parent = older one):
 * sameFile, ref (child text names the parent issue id), reqSim (requirement
 * bigram Jaccard) and identSim (identifier Jaccard over evidence+required_fix,
 * plan §4.2). parentOpen is applied by the caller because it depends on the
 * round being replayed.
 */
export function stallLinkSignals(child, parent) {
  const parentFiles = stallLocationFiles(parent?.location);
  const sameFile = [...stallLocationFiles(child?.location)].some((file) => parentFiles.has(file)) ? 1 : 0;
  const parentId = String(parent?.id || "");
  const ref = parentId && stallFindingText(child).includes(parentId) ? 1 : 0;
  const reqSim = stallJaccard(stallRequirementBigrams(child?.requirement), stallRequirementBigrams(parent?.requirement));
  // Requirement identifiers are represented by reqSim, never by identSim.
  const identSim = stallJaccard(stallIdentifiers(stallEvidenceText(child)), stallIdentifiers(stallEvidenceText(parent)));
  return { sameFile, ref, reqSim, identSim };
}

/** score = sameFile + 2·ref + [reqSim] + [identSim] + 0.5·parentOpen. */
export function stallLinkScore(signals, parentOpen, gate = DEFAULT_STALL_GATE) {
  const config = normalizeStallGate(gate);
  return (signals?.sameFile ? 1 : 0)
    + (signals?.ref ? 2 : 0)
    + (Number(signals?.reqSim) >= config.reqSim ? 1 : 0)
    + (Number(signals?.identSim) >= config.identSim ? 1 : 0)
    + (parentOpen ? 0.5 : 0);
}

/** Natural ordering: R9-001 before R10-001, so cluster keys stay stable and readable. */
function compareStallIssueIds(left, right) {
  const parse = (id) => {
    const match = /^R(\d+)-(\d+)$/.exec(String(id));
    return match ? [Number(match[1]), Number(match[2])] : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (a && b) return a[0] - b[0] || a[1] - b[1];
  return String(left).localeCompare(String(right));
}

function createStallUnionFind() {
  const parents = new Map();
  const find = (id) => {
    if (!parents.has(id)) return undefined;
    let root = id;
    while (parents.get(root) !== root) root = parents.get(root);
    let cursor = id;
    while (parents.get(cursor) !== root) {
      const next = parents.get(cursor);
      parents.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  return {
    add(id) {
      if (!parents.has(id)) parents.set(id, id);
    },
    find,
    union(left, right) {
      if (find(left) === undefined) this.add(left);
      if (find(right) === undefined) this.add(right);
      const rootLeft = find(left);
      const rootRight = find(right);
      if (rootLeft !== rootRight) parents.set(rootLeft, rootRight);
    },
  };
}

/**
 * Union-find members grouped into families. `span` is the family age at the
 * evaluated round (first member round → current round), which is what "this
 * family survived N rounds" means; member rounds stay available separately.
 */
function collectStallClusters(unionFind, issues, evaluatedRound = null) {
  const groups = new Map();
  for (const issue of issues.values()) {
    if (issue.specBlocked) continue;
    const root = unionFind.find(issue.id);
    if (root === undefined) continue;
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(issue);
  }
  const clusters = [];
  for (const members of groups.values()) {
    const sorted = members.slice().sort((left, right) => compareStallIssueIds(left.id, right.id));
    const rounds = [...new Set(sorted.map((member) => member.first_round))].sort((left, right) => left - right);
    const openMembers = sorted.filter((member) => member.open).map((member) => member.id);
    const files = [...new Set(sorted.flatMap((member) => [...stallLocationFiles(member.finding.location)]))].sort();
    clusters.push({
      key: sorted[0].id,
      members: sorted.map((member) => member.id),
      memberDetails: sorted.map((member) => ({
        id: member.id,
        severity: member.finding.severity,
        first_round: member.first_round,
        last_round: member.last_review_round,
        last_verdict: member.last_verdict,
        open: member.open,
        chain: member.verdictHistory.map((entry) => `r${entry.round}:${entry.verdict}`).join(" → "),
      })),
      rounds,
      span: (evaluatedRound ?? rounds[rounds.length - 1]) - rounds[0],
      openMembers,
      files,
      hot: sorted.length >= 2 && openMembers.length > 0,
    });
  }
  return clusters.sort((left, right) => compareStallIssueIds(left.key, right.key));
}

function normalizeStallLog(log) {
  const source = Array.isArray(log) ? log : Array.isArray(log?.rounds) ? log.rounds : [];
  // Append-only logs can contain the same round twice when an interrupted
  // review invocation resumes; the last record wins so verdicts are never
  // double-counted during replay.
  const byRound = new Map();
  for (const record of source) {
    if (!record || typeof record !== "object" || !Number.isInteger(Number(record.round))) continue;
    const round = Number(record.round);
    byRound.set(round, { ...record, round });
  }
  return [...byRound.values()].sort((left, right) => left.round - right.round);
}

/**
 * Live `state.openIssues` is authoritative for the final round when supplied:
 * it marks which replayed issues are still open and copies the engine's own
 * `partial_streak`/`rounds_open` bookkeeping. Fixture replay (no live state)
 * derives the same values from the log alone.
 */
function applyStallLiveOpenIssues(issues, openIssues) {
  if (!Array.isArray(openIssues) || openIssues.length === 0) return;
  const live = new Map(openIssues.filter((issue) => issue && typeof issue.id === "string").map((issue) => [issue.id, issue]));
  for (const issue of issues.values()) {
    const state = live.get(issue.id);
    if (!state) {
      issue.open = false;
      continue;
    }
    issue.open = true;
    const streak = Number(state.partial_streak);
    if (Number.isInteger(streak) && streak >= 0) issue.partial_streak = streak;
    const roundsOpen = Number(state.rounds_open);
    if (Number.isInteger(roundsOpen) && roundsOpen >= 0) issue.rounds_open = roundsOpen;
  }
}

function stallTriggers(clusters, issues, gate, round) {
  const softReasons = [];
  const hardReasons = [];
  const softKeys = new Set();
  const hardKeys = new Set();
  const clusterKeyByMember = new Map();
  for (const cluster of clusters) for (const id of cluster.members) clusterKeyByMember.set(id, cluster.key);

  for (const issue of issues.values()) {
    if (!issue.open) continue;
    // Findings born in a spec_blocked round carry no code signal (plan §4.2):
    // they are excluded from linking and must not drive streak triggers either,
    // otherwise a hard fire can surface a family report with no cluster at all.
    if (issue.specBlocked) continue;
    const key = clusterKeyByMember.get(issue.id);
    if (issue.partial_streak >= gate.softStreak) {
      softReasons.push(`issue-streak:${issue.id}:${issue.partial_streak}`);
      if (key) softKeys.add(key);
    }
    if (issue.partial_streak >= gate.hardStreak) {
      hardReasons.push(`issue-streak:${issue.id}:${issue.partial_streak}`);
      if (key) hardKeys.add(key);
    }
  }
  for (const cluster of clusters) {
    if (cluster.members.length < 2 || cluster.openMembers.length === 0) continue;
    if (cluster.span >= gate.softSpan) {
      softReasons.push(`family-span:${cluster.key}:${cluster.span}`);
      softKeys.add(cluster.key);
    }
    // "new members in the most recent two rounds" is a window, not a
    // conjunction: a member born in r-1 or r keeps the family churning, even
    // when the current round itself added no new finding.
    if (
      cluster.span >= gate.hardSpan
      && cluster.openMembers.length >= 2
      && cluster.rounds.some((memberRound) => memberRound === round || memberRound === round - 1)
    ) {
      hardReasons.push(`family-span:${cluster.key}:${cluster.span}`);
      hardKeys.add(cluster.key);
    }
  }
  return {
    soft: { fired: softReasons.length > 0, reasons: softReasons, clusters: [...softKeys] },
    hard: { fired: hardReasons.length > 0, reasons: hardReasons, clusters: [...hardKeys] },
  };
}

/**
 * L3 candidates: findings of the evaluated round that are not connected to the
 * hot family (plus open unconnected findings in the family's files). This is
 * how paraphrased siblings the text linker legitimately misses reach the
 * reviewer for a confirm/separate decision instead of being silently claimed
 * as a link.
 *
 * Hot families are read from the FINAL clusters of the evaluated round: a
 * family that just formed this round (new link to a previous finding) must
 * surface the round's other unconnected findings, not only families that were
 * already hot before the round. "Alive during the review" is therefore
 * `open at the end` OR `open when the round started` — the latter keeps an
 * established family visible on the round where its members receive their
 * closing verdicts. Only the primary (largest) hot family is targeted.
 */
function stallCandidates(round, issues, unionFind, clusters, openAtStart) {
  const hotFamilies = clusters.filter(
    (cluster) => cluster.members.length >= 2
      && (cluster.openMembers.length > 0 || cluster.members.some((id) => openAtStart.has(id))),
  );
  if (!hotFamilies.length) return [];
  const primary = hotFamilies
    .slice()
    .sort((left, right) => right.members.length - left.members.length || compareStallIssueIds(left.key, right.key))[0];
  const primaryRoot = unionFind.find(primary.key);
  const hotFiles = new Set(primary.files);
  const candidates = [];
  for (const issue of issues.values()) {
    if (issue.specBlocked || !issue.open) continue;
    if (unionFind.find(issue.id) === primaryRoot) continue;
    const sameRound = issue.first_round === round;
    const sameArea = [...stallLocationFiles(issue.finding.location)].some((file) => hotFiles.has(file));
    if (!sameRound && !sameArea) continue;
    candidates.push({
      id: issue.id,
      family: primary.key,
      severity: issue.finding.severity,
      location: issue.finding.location,
      requirement: issue.finding.requirement,
      first_round: issue.first_round,
      last_round: issue.last_review_round,
      last_verdict: issue.last_verdict,
    });
  }
  return candidates.sort((left, right) => compareStallIssueIds(left.id, right.id));
}

/**
 * Replay the review log once, round by round, and evaluate the stall gate after
 * every `fix_required` round. Findings from `spec_blocked` rounds carry no code
 * signal and are excluded from linking/candidacy; verdicts are still applied so
 * streak bookkeeping stays faithful.
 */
function stallReplay(rounds, gate, openIssues) {
  const issues = new Map();
  const unionFind = createStallUnionFind();
  const lastIndex = rounds.length - 1;
  let evaluation = null;

  for (let index = 0; index <= lastIndex; index += 1) {
    const record = rounds[index];
    const round = record.round;
    const decision = typeof record.decision === "string" ? record.decision : null;
    const verdicts = Array.isArray(record.verdicts) ? record.verdicts : [];
    const findings = Array.isArray(record.findings) ? record.findings : [];
    const openAtStart = new Set([...issues.values()].filter((issue) => issue.open).map((issue) => issue.id));

    for (const verdict of verdicts) {
      const issue = issues.get(verdict?.id);
      if (!issue) continue;
      issue.last_review_round = round;
      issue.rounds_open = round - issue.first_round;
      if (verdict.verdict === "verified_closed") {
        issue.open = false;
        issue.partial_streak = 0;
        issue.last_verdict = "verified_closed";
      } else {
        issue.open = true;
        issue.partial_streak += 1;
        issue.last_verdict = typeof verdict.verdict === "string" ? verdict.verdict : "still_open";
      }
      issue.verdictHistory.push({ round, verdict: issue.last_verdict });
    }

    const specBlocked = decision === "spec_blocked";
    for (const finding of findings) {
      if (!finding || typeof finding.id !== "string" || !finding.id) continue;
      issues.set(finding.id, {
        id: finding.id,
        finding,
        first_round: round,
        open: true,
        partial_streak: 0,
        rounds_open: 0,
        last_verdict: "new",
        last_review_round: round,
        verdictHistory: [],
        specBlocked,
      });
      if (!specBlocked) unionFind.add(finding.id);
    }

    if (index === lastIndex) applyStallLiveOpenIssues(issues, openIssues);

    if (!specBlocked) {
      // Reviewer-declared lineage first: `repeat_of` puts the new finding into
      // the named family even when no text/identifier signal fires.
      for (const finding of findings) {
        const repeatOf = typeof finding?.repeat_of === "string" ? finding.repeat_of.trim() : "";
        if (repeatOf && unionFind.find(repeatOf) !== undefined) unionFind.union(finding.id, repeatOf);
      }
      for (const finding of findings) {
        const child = issues.get(finding.id);
        if (!child) continue;
        for (const parent of issues.values()) {
          if (parent.id === child.id || parent.first_round >= round || parent.specBlocked) continue;
          if (!openAtStart.has(parent.id)) continue;
          const signals = stallLinkSignals(child.finding, parent.finding);
          // parentOpen is half weight only while the parent survived this
          // round's verdicts; a parent verified_closed in this same round keeps
          // zero and can only link through its own text/file signals.
          const parentOpen = parent.open ? 1 : 0;
          if (stallLinkScore(signals, parentOpen, gate) >= gate.linkThreshold) unionFind.union(child.id, parent.id);
        }
      }
    }

    if (decision === "fix_required") {
      const clusters = collectStallClusters(unionFind, issues, round);
      const triggers = stallTriggers(clusters, issues, gate, round);
      evaluation = {
        round,
        clusters,
        soft: triggers.soft,
        hard: triggers.hard,
        candidates: stallCandidates(round, issues, unionFind, clusters, openAtStart),
      };
    }
  }
  return evaluation;
}

/**
 * Pure stall detector. `log` is either the findings.jsonl array (one record per
 * review round: {round, decision, verdicts, findings}) or a whole fixture object
 * with a `rounds` array, so frozen fixtures replay without transformation.
 * `openIssues` is optional live state (see applyStallLiveOpenIssues); `config`
 * is `state.config` or a bare stallGate object.
 *
 * Returns { round, clusters, soft, hard, candidates } — `clusters` is empty and
 * nothing fires when the gate is disabled, the log is empty (old instances) or
 * the latest round was not `fix_required`.
 */
export function detectStallClusters(log, openIssues, config) {
  const gate = normalizeStallGate(config);
  const empty = {
    round: null,
    clusters: [],
    soft: { fired: false, reasons: [], clusters: [] },
    hard: { fired: false, reasons: [], clusters: [] },
    candidates: [],
  };
  if (!gate.enabled) return empty;
  const rounds = normalizeStallLog(log);
  if (!rounds.length) return empty;
  // Only a fix_required review can trigger evaluation. Anything else (pass,
  // spec_blocked) leaves the previously persisted signal untouched instead of
  // re-reporting a stale round as if it just fired.
  if (rounds[rounds.length - 1].decision !== "fix_required") return empty;
  return stallReplay(rounds, gate, openIssues) ?? empty;
}

/** Compact, serializable projection persisted as `state.stall` for task injection. */
function stallStateFromDetection(detection) {
  if (!detection || detection.round === null) return null;
  const keys = new Set([...detection.soft.clusters, ...detection.hard.clusters]);
  return {
    round: detection.round,
    at: now(),
    soft: detection.soft,
    hard: detection.hard,
    candidates: detection.candidates,
    families: detection.clusters.filter((cluster) => keys.has(cluster.key)),
  };
}

/** The stall signal only applies to rounds that come after the review that produced it. */
function stallSignalForRound(state, round) {
  if (!normalizeStallGate(state?.config?.stallGate).enabled) return null;
  const stall = state?.stall;
  if (!stall || !Number.isInteger(stall.round) || stall.round >= round) return null;
  return stall;
}

function stallFamilyMemberLine(member) {
  const status = member.open ? "open" : "closed";
  return `- ${member.id} · ${member.severity} · first r${member.first_round} · last r${member.last_round}: ${member.last_verdict} · ${status}`;
}

/**
 * Family-level acceptance criteria for the next developer round. The text is a
 * separate constant so removing it can never affect routing/observation.
 *
 * English-only on purpose: the role prompts draw the line at "instructions in
 * English, human-readable content in the frozen plan's language"
 * (prompts/developer.md), and the task packet around this text is English. A
 * second, parallel Chinese copy would be a second source of truth for the same
 * criteria — if the two ever drift, nobody can say which half the model read.
 */
export const STALL_DIRECTIVE = `## Stall-family acceptance criteria (engine-injected)

{families}

Accept this family as a whole: state the root-cause invariant, enumerate every boundary that would violate it, and give a verdict with evidence for each one — "fixed" / "unreachable" / "out of scope for this batch". How you implement it is your call, but fixing only the named path and staying silent on the rest counts as incomplete.`;

/** Fill STALL_DIRECTIVE for the soft-fired families (primary cluster listed first). */
export function renderStallDirective(families) {
  if (typeof STALL_DIRECTIVE !== "string" || !STALL_DIRECTIVE) return "";
  const blocks = (families || [])
    .slice()
    .sort((left, right) => right.members.length - left.members.length || compareStallIssueIds(left.key, right.key))
    .map((family) => [
      `family ${family.key}: ${family.members.length} linked findings over the last ${family.span} review rounds, ${family.openMembers.length} still open`,
      ...family.memberDetails.map(stallFamilyMemberLine),
    ].join("\n"))
    .join("\n\n");
  // Function replacer: injected text may contain `$&`-style sequences, which a
  // string replacement would interpret as capture references.
  return STALL_DIRECTIVE.replaceAll("{families}", () => blocks);
}

/**
 * Reviewer-side candidate confirmation. Uses review-round data only: the
 * reviewer formally declares `repeat_of` when confirming a candidate.
 */
export const STALL_CANDIDATES = `## Unlinked-candidate confirmation (engine-injected)

The findings below are not linked to this family. Confirm or separate each of them: when you confirm common origin, declare the optional field repeat_of: "{family}" on your new finding; otherwise justify the separation in handoff_to_developer.

{candidates}`;

export function renderStallCandidateSection(candidates) {
  if (typeof STALL_CANDIDATES !== "string" || !STALL_CANDIDATES) return "";
  const family = candidates[0]?.family || "";
  const lines = candidates.map((candidate) => {
    const verdict = candidate.last_verdict === "new"
      ? "new this round"
      : `last verdict r${candidate.last_round}: ${candidate.last_verdict}`;
    return `- ${candidate.id} · ${candidate.severity} · ${candidate.location} · first r${candidate.first_round} · ${verdict} — ${candidate.requirement}`;
  });
  return STALL_CANDIDATES.replaceAll("{family}", () => family).replaceAll("{candidates}", () => lines.join("\n"));
}

/** Machine-generated family table attached to the human escalation. */
function stallFamilyReport(cluster) {
  const members = cluster.memberDetails.map((member) => {
    const chain = member.chain ? ` 判定链 ${member.chain}` : "（仅本轮新增）";
    return `- ${member.id}（${member.severity}，首现 r${member.first_round}，最近 r${member.last_round}: ${member.last_verdict}）${chain}`;
  });
  return [
    `### 家族 ${cluster.key}`,
    `- 成员：${cluster.members.length} 条；跨度：${cluster.span} 轮（成员首现轮次 ${cluster.rounds.map((round) => `r${round}`).join(", ")}）；未闭合：${cluster.openMembers.length} 条${cluster.openMembers.length ? `（${cluster.openMembers.join(", ")}）` : ""}`,
    `- 热态文件：${cluster.files.length ? cluster.files.join(", ") : "(无)"}`,
    "",
    ...members,
  ].join("\n");
}

function stallHardQuestions(clusters) {
  return clusters.map((cluster) => ({
    question: `停滞家族 ${cluster.key}（${cluster.members.length} 条 finding，${cluster.openMembers.length} 条未闭合，跨度 ${cluster.span} 轮）如何处理？`,
    why: "同一根因家族的 finding 已跨多轮存活，机械信号判定需要人类决定继续收敛、登记为已知限制还是修订口径。",
    options: [
      "授权一轮钉死范围的系统性修复（请写出范围）",
      "该家族登记为已知限制并顺延到后续批次",
      "修订计划/口径（附当前家族报告）",
    ],
  }));
}

function stallHardSummary(detection, clusters) {
  const parts = clusters.map((cluster) => `${cluster.key}（${cluster.members.length} 条，未闭合 ${cluster.openMembers.length}，跨度 ${cluster.span} 轮）`);
  return `停滞家族触发硬升级：${parts.join("；")}。触发原因：${detection.hard.reasons.join("；")}`;
}

function findingsLogPath(paths) {
  return path.join(paths.reports, "findings.jsonl");
}

/** Append-only review log; one JSON object per review round (fixture-isomorphic). */
async function appendFindingsLog(paths, record) {
  await mkdir(paths.reports, { recursive: true });
  await appendFile(findingsLogPath(paths), `${JSON.stringify(record)}\n`, "utf8");
}

/**
 * Read the review log, keeping the last record per round: an interrupted
 * invocation can resume the same review round, and a duplicate line must not
 * double-count verdicts during replay. A missing file is an empty history.
 */
async function readFindingsLog(paths) {
  let text = "";
  try {
    text = await readFile(findingsLogPath(paths), "utf8");
  } catch {
    return [];
  }
  const byRound = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const round = Number(record?.round);
    if (!record || !Number.isInteger(round)) continue;
    byRound.set(round, { ...record, round });
  }
  return [...byRound.values()].sort((left, right) => left.round - right.round);
}

/**
 * Evaluate the gate after one review round and persist the result as state.stall.
 * A non-`fix_required` round never overwrites a previous signal, so an injected
 * family directive survives a spec_blocked interruption until the next
 * fix_required evaluation.
 */
async function evaluateStallGate(state, paths, notify) {
  try {
    const gate = normalizeStallGate(state.config?.stallGate);
    if (!gate.enabled) {
      state.stall = null;
      return null;
    }
    const log = await readFindingsLog(paths);
    const detection = detectStallClusters(log, state.openIssues, gate);
    if (detection.round === null) return null;
    state.stall = stallStateFromDetection(detection);
    return detection;
  } catch (error) {
    notify?.(`Stall detection skipped this round: ${error && error.message ? error.message : error}`);
    return null;
  }
}

/** Timeline + state.stallEvents entry for every soft/hard trigger (observation only). */
async function recordStallEvents(state, paths, detection) {
  const clusterByKey = new Map((detection.clusters || []).map((cluster) => [cluster.key, cluster]));
  const clusterMembers = (keys) => [...new Set(keys.flatMap((key) => clusterByKey.get(key)?.members ?? []))].sort(compareStallIssueIds);
  const clusterLabel = (key) => {
    const members = clusterByKey.get(key)?.members ?? [];
    return members.length ? `${key}[${members.join(", ")}]` : key;
  };
  const events = [];
  if (detection.soft.fired) {
    events.push({
      kind: "soft",
      injected: true,
      reasons: detection.soft.reasons,
      clusters: detection.soft.clusters,
      members: clusterMembers(detection.soft.clusters),
    });
  }
  if (detection.hard.fired) {
    events.push({
      kind: "hard",
      injected: false,
      reasons: detection.hard.reasons,
      clusters: detection.hard.clusters,
      members: clusterMembers(detection.hard.clusters),
    });
  }
  if (!events.length) return;
  state.stallEvents = Array.isArray(state.stallEvents) ? state.stallEvents : [];
  for (const event of events) {
    // A resumed invocation can re-evaluate the same review round; observation
    // must not double-count it.
    if (state.stallEvents.some((entry) => entry.round === detection.round && entry.kind === event.kind)) continue;
    const record = {
      at: now(),
      round: detection.round,
      ...event,
    };
    state.stallEvents.push(record);
    await appendTimeline(paths, timelineLine({
      round: detection.round,
      event: `stall-${event.kind}`,
      status: "fired",
      summary: `${event.injected ? "注入下一轮开发者任务包" : "升级为 stalled-issue-family"} — 家族 ${event.clusters.map(clusterLabel).join(", ") || "(none)"} — 成员 ${event.members.join(", ") || "(none)"} — 原因 ${event.reasons.join("; ")}`,
    }));
  }
}

// ---- Token usage tracking (dev/review child agents) ----------------------
// The child pi runs with --mode json, so every provider request produces
// message_start (request begins) → message_update (deltas) → message_end
// (authoritative usage: input/output/cacheRead/cacheWrite/reasoning).
// Cache hit rate uses the same formula as pi's own status bar:
//   cacheRead / (input + cacheRead + cacheWrite).
// Timing:
//   - The assistant message_start carries `message.timestamp`, stamped by the
//     child just before it issues the provider request. TTFT is measured from
//     that point to the first streamed token — the standard client-side
//     definition (connection, request upload, gateway queue and prefill included).
//   - The parent stamps `startAt` when it receives message_start (SSE response
//     headers). The requestAt → startAt gap is reported separately as `setup`.
//   - `outputPerSec` follows the documented throughput convention (OpenRouter
//     `generation_time`: "from dispatching the upstream request until its
//     response body ended. Divide the completion token count by this for
//     throughput."): requestAt → message_end, so TTFT is included. Artificial
//     Analysis' "Output Speed" (and Ollama's eval rate) is decode-only and can
//     be derived from the separately reported TTFT.

function formatTokenCount(value) {
  const n = Number(value) || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function createUsageStats() {
  return {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    ttftMs: 0,
    ttftSamples: 0,
    setupMs: 0,
    setupSamples: 0,
    requestMs: 0,
    timedOutput: 0,
    latest: null,
    updatedAt: null,
  };
}

/** Fold one completed provider request (usage + timing) into the running round stats. */
function addUsageRequest(stats, request) {
  const usage = request?.usage;
  if (!usage) return stats;
  stats.requests += 1;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"]) {
    stats[key] += Number(usage[key]) || 0;
  }
  if (request.requestAt && request.firstDeltaAt) {
    // Standard client-side TTFT: provider request sent → first token streamed.
    stats.ttftMs += Math.max(0, request.firstDeltaAt - request.requestAt);
    stats.ttftSamples += 1;
    if (request.startAt) {
      // requestAt → SSE headers: connect, upload, gateway queue (pre-stream setup).
      stats.setupMs += Math.max(0, request.startAt - request.requestAt);
      stats.setupSamples += 1;
    }
  } else if (request.startAt && request.firstDeltaAt) {
    // Providers that do not stamp the request (or older child pi builds): fall
    // back to stream-open → first token so a number is still reported.
    stats.ttftMs += Math.max(0, request.firstDeltaAt - request.startAt);
    stats.ttftSamples += 1;
  }
  if (request.endAt) {
    // Throughput window: the provider request itself (stamped by the child just
    // before it dispatches) → message_end. Falls back to stream-open → end when
    // the child does not stamp `message.timestamp`. Only tokens that have a
    // window count toward the rate, so a request without timing can never
    // inflate it.
    const startedAt = request.requestAt ?? request.startAt ?? request.firstDeltaAt;
    if (startedAt) {
      stats.requestMs += Math.max(0, request.endAt - startedAt);
      stats.timedOutput += Number(usage.output) || 0;
    }
  }
  stats.latest = {
    input: Number(usage.input) || 0,
    output: Number(usage.output) || 0,
    cacheRead: Number(usage.cacheRead) || 0,
    cacheWrite: Number(usage.cacheWrite) || 0,
    reasoning: Number(usage.reasoning) || 0,
    totalTokens: Number(usage.totalTokens) || 0,
  };
  stats.updatedAt = now();
  return stats;
}

/** One-line human-readable summary: `tokens ↑… ↓… · R… (CH …) · … tok/s · TTFT …s`. */
function usageLine(stats) {
  if (!stats || !stats.requests) return null;
  const prompt = stats.input + stats.cacheRead + stats.cacheWrite;
  const cache = stats.cacheRead || stats.cacheWrite
    ? `R${formatTokenCount(stats.cacheRead)}${stats.cacheWrite ? ` W${formatTokenCount(stats.cacheWrite)}` : ""}${prompt > 0 ? ` (CH ${((stats.cacheRead / prompt) * 100).toFixed(1)}%)` : ""}`
    : null;
  const speed = stats.requestMs > 0 && stats.timedOutput > 0
    ? `${(stats.timedOutput / (stats.requestMs / 1000)).toFixed(1)} tok/s`
    : null;
  const ttft = stats.ttftSamples > 0
    ? `TTFT ${(stats.ttftMs / stats.ttftSamples / 1000).toFixed(2)}s${stats.setupSamples > 0 ? ` (setup ${(stats.setupMs / stats.setupSamples / 1000).toFixed(2)}s)` : ""}`
    : null;
  return [
    `tokens ↑${formatTokenCount(stats.input)} ↓${formatTokenCount(stats.output)}`,
    cache,
    speed,
    ttft,
    stats.reasoning ? `think ${formatTokenCount(stats.reasoning)}` : null,
    stats.requests > 1 ? `${stats.requests} req` : null,
  ].filter(Boolean).join(" · ");
}

/** Serializable per role+round entry persisted to reports/usage.json. */
function usageEntry({ role, round, stats }) {
  const prompt = stats.input + stats.cacheRead + stats.cacheWrite;
  return {
    role,
    round,
    requests: stats.requests,
    input: stats.input,
    output: stats.output,
    cacheRead: stats.cacheRead,
    cacheWrite: stats.cacheWrite,
    reasoning: stats.reasoning,
    totalTokens: stats.totalTokens,
    ttftAvgMs: stats.ttftSamples ? Math.round(stats.ttftMs / stats.ttftSamples) : null,
    setupAvgMs: stats.setupSamples ? Math.round(stats.setupMs / stats.setupSamples) : null,
    outputPerSec: stats.requestMs > 0 && stats.timedOutput > 0
      ? Number((stats.timedOutput / (stats.requestMs / 1000)).toFixed(1))
      : null,
    cacheHitRate: prompt > 0 && (stats.cacheRead > 0 || stats.cacheWrite > 0)
      ? Number((stats.cacheRead / prompt).toFixed(4))
      : null,
    line: usageLine(stats),
    updatedAt: now(),
  };
}

async function readUsageFile(paths) {
  try {
    return JSON.parse(await readFile(path.join(paths.reports, "usage.json"), "utf8"));
  } catch {
    return { entries: [] };
  }
}

// Serialize usage.json writes; processLine is sync and each request completes
// sequentially, but the writes themselves are async.
let usageWriteChain = Promise.resolve();
function queueUsageEntry(paths, entry) {
  usageWriteChain = usageWriteChain
    .then(async () => {
      const file = await readUsageFile(paths);
      const entries = Array.isArray(file.entries)
        ? file.entries.filter((item) => !(item.role === entry.role && item.round === entry.round))
        : [];
      entries.push(entry);
      entries.sort((left, right) => left.round - right.round || String(left.role).localeCompare(String(right.role)));
      await writeJson(path.join(paths.reports, "usage.json"), { updatedAt: now(), entries });
    })
    .catch(() => {});
  return usageWriteChain;
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

// ---- Full-process transcript, written into the same timeline file ---------
// `reports/timeline.md` is the whole log, not just milestones: milestone lines
// (plan freeze → dev rN → review rN → decision → pass/blocked) and the readable
// dev/review process share one append-only file, so `tail -f` works during a run
// and the finished file is both roles' transcripts concatenated in order. Raw
// transcripts (including anything capped here) stay in private/ (pi session
// JSONL). `DEV_REVIEW_TRANSCRIPT=0` restores the milestones-only timeline;
// `DEV_REVIEW_TRANSCRIPT=full` also inlines the thinking text (default: a
// one-line thinking marker with the provider's reasoning-token count, which
// keeps the log readable — the full text stays in private/).
const TRANSCRIPT_ARGS_LIMIT = 1200;
const TRANSCRIPT_RESULT_LIMIT = 8000;
const TRANSCRIPT_RESULT_HEAD = 5000;

function transcriptEnabled() {
  return process.env.DEV_REVIEW_TRANSCRIPT !== "0";
}

function transcriptFullThinking() {
  return process.env.DEV_REVIEW_TRANSCRIPT === "full";
}

/**
 * Fence arbitrary text safely: the fence is one backtick longer than the
 * longest backtick run inside, so tool output that itself contains code fences
 * never breaks out of the block.
 */
function fencedBlock(text, info = "text") {
  const runs = String(text).match(/`+/g) || [];
  const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return `${fence}${info}\n${text}\n${fence}`;
}

/** Quote every line so thinking renders as one visually distinct block. */
function quotedBlock(text) {
  return String(text).split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
}

/** Tool arguments as one compact line; `write`/`edit` payloads get truncated. */
function transcriptArgs(value) {
  let json;
  try {
    json = JSON.stringify(value ?? {});
  } catch {
    json = String(value);
  }
  const compact = String(json).replace(/\s+/g, " ").trim();
  return compact.length > TRANSCRIPT_ARGS_LIMIT
    ? `${compact.slice(0, TRANSCRIPT_ARGS_LIMIT - 1)}…`
    : compact;
}

function transcriptResultText(result) {
  const content = result?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function cappedResultText(text) {
  if (text.length <= TRANSCRIPT_RESULT_LIMIT) return text;
  const tailLength = TRANSCRIPT_RESULT_LIMIT - TRANSCRIPT_RESULT_HEAD;
  const omitted = text.length - TRANSCRIPT_RESULT_LIMIT;
  return `${text.slice(0, TRANSCRIPT_RESULT_HEAD)}\n… [${omitted} chars omitted · full output in private/ session transcript] …\n${text.slice(-tailLength)}`;
}

/** Phase opener: `## dev r1 · <model> · <local time>`. */
function transcriptPhaseHeader({ role, round, model }) {
  if (!transcriptEnabled()) return null;
  const name = role === "developer" ? "dev" : "review";
  return `\n## ${name} r${round} · ${model || "unknown model"} · ${localNow()}`;
}

/** One assistant message → heading + text + thinking + tool calls, in order. */
function transcriptAssistantBlock(message) {
  if (!transcriptEnabled()) return null;
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const text = blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
  const thinking = blocks
    .filter((block) => block?.type === "thinking" && typeof block.thinking === "string")
    .map((block) => block.thinking)
    .join("\n\n")
    .trim();
  const calls = blocks.filter((block) => block?.type === "toolCall");
  if (!text && !thinking && !calls.length) return null;
  const stamp = Number(message?.timestamp);
  const stopReason = typeof message?.stopReason === "string" ? message.stopReason : null;
  const warning = stopReason === "error" || stopReason === "aborted" || stopReason === "length"
    ? ` · ⚠️ ${stopReason}${message?.errorMessage ? `: ${truncateText(message.errorMessage, 200)}` : ""}`
    : "";
  const parts = [`### ${localNow(Number.isFinite(stamp) ? new Date(stamp) : new Date())} · assistant${warning}`];
  if (text) parts.push(text);
  if (thinking) {
    if (transcriptFullThinking()) {
      parts.push("**🧠 thinking**", quotedBlock(thinking));
    } else {
      const reasoning = Number(message?.usage?.reasoning) || 0;
      const size = reasoning ? `${formatTokenCount(reasoning)} tok` : `${thinking.length} chars`;
      parts.push(`**🧠 thinking** · ${size} · full text in private/ session transcript`);
    }
  }
  if (calls.length) {
    parts.push(
      "**🔧 tools**",
      calls.map((call) => `- \`${call.name}\` · ${transcriptArgs(call.arguments)}`).join("\n"),
    );
  }
  return `${parts.join("\n\n")}\n`;
}

/** One tool execution → `↳ ✅/❌ <tool> · <size>` plus capped output. */
function transcriptToolResultBlock({ toolName, result, isError }) {
  if (!transcriptEnabled()) return null;
  const text = transcriptResultText(result).trim();
  const lines = text ? text.split("\n").length : 0;
  const size = text.length > TRANSCRIPT_RESULT_LIMIT ? ` · ${text.length} chars` : "";
  const head = `↳ ${isError ? "❌" : "✅"} \`${toolName || "tool"}\` · ${lines} ${lines === 1 ? "line" : "lines"}${size}`;
  if (!text) return `${head}\n`;
  return `${head}\n\n${fencedBlock(cappedResultText(text))}\n`;
}

/**
 * Serialize every timeline write — milestones and transcript blocks — so file
 * order matches event order no matter which async caller enqueues first.
 */
let timelineWriteChain = Promise.resolve();
function queueTimelineLines(paths, lines) {
  const entries = (Array.isArray(lines) ? lines : [lines]).filter(
    (line) => typeof line === "string" && line.length > 0,
  );
  if (!entries.length) return timelineWriteChain;
  timelineWriteChain = timelineWriteChain
    .then(async () => {
      await mkdir(paths.reports, { recursive: true });
      await appendFile(timelineFilePath(paths), `${entries.join("\n")}\n`, "utf8");
    })
    .catch(() => {
      // The timeline is a convenience artifact; never fail a run because of it.
    });
  return timelineWriteChain;
}

/**
 * Append-only, human-readable log of the whole workflow: plan freeze →
 * development rN → review rN → human decision / escalation → pass, with the
 * full dev/review process (assistant text, thinking, tool calls and results)
 * interleaved in chronological order. Never rewritten, so interrupted and
 * resumed runs stay in one file.
 */
async function appendTimeline(paths, lines) {
  await queueTimelineLines(paths, lines);
}

function timelineLine({ round, event, status, summary, artifact, usage }) {
  const head = [
    localNow(),
    round ? `r${round}` : "workflow",
    event,
    status ? `**${status}**` : null,
  ].filter(Boolean).join(" · ");
  const tail = [
    typeof summary === "string" && summary.trim() ? truncateText(summary, 400) : null,
    artifact ? `\`${artifact}\`` : null,
    typeof usage === "string" && usage.trim() ? usage.trim() : null,
  ].filter(Boolean).join(" — ");
  return `- ${head}${tail ? ` — ${tail}` : ""}`;
}

function stateStatus(state, paths, usageLines = []) {
  const lines = [
    `Workflow: ${state.workflow?.key || state.workflowId}`,
    `PRD: ${state.plan.sourcePath}`,
    `Status: ${state.status}${state.phase ? ` (${state.phase})` : ""}`,
    `Plan snapshot: ${relativeTo(state.projectRoot, path.resolve(state.projectRoot, state.plan.snapshotPath))}`,
    `Base commit: ${state.base.head}`,
    `Round: ${state.currentRound}/${state.config.maxReviewRounds}`,
    `Developer model: ${state.config.developerModel}${state.config.developerThinking ? ` · thinking ${state.config.developerThinking}` : ""}`,
    `Reviewer model: ${state.config.reviewerModel}${state.config.reviewerThinking ? ` · thinking ${state.config.reviewerThinking}` : ""}`,
    ...(state.config.devSkills?.length
      ? [`Dev skills: ${state.config.devSkills.join(", ")}`]
      : []),
    `Active role: ${state.phase === "review" ? `review r${state.currentRound}` : state.phase === "development" ? `dev r${state.currentRound + 1}` : state.phase || "-"}`,
    `Open issues: ${state.openIssues.length ? state.openIssues.map((issue) => issue.id).join(", ") : "none"}`,
    `Artifacts: ${relativeTo(state.projectRoot, paths.root)}`,
    `Timeline: ${relativeTo(state.projectRoot, timelineFilePath(paths))}`,
  ];
  for (const usageLine of usageLines) lines.push(usageLine);
  if (state.status === "blocked" && state.blocked) {
    lines.push(blockedNotice(state));
  } else if (state.blocked?.escalationPath) {
    lines.push(`Human decision file: ${state.blocked.escalationPath}`);
  }
  return lines.join("\n");
}

/** Latest usage entry per role, preformatted by the engine (reports/usage.json). */
async function usageStatusLines(paths) {
  const file = await readUsageFile(paths);
  const entries = Array.isArray(file.entries) ? file.entries.filter((entry) => entry && entry.line) : [];
  if (!entries.length) return [];
  const latest = new Map();
  for (const entry of entries) latest.set(entry.role, entry);
  return ["developer", "reviewer"]
    .filter((role) => latest.has(role))
    .map((role) => `Usage ${role === "developer" ? "dev" : "review"} r${latest.get(role).round}: ${latest.get(role).line}`);
}

/**
 * Read the `description` from a skill file the way pi does, returning null when
 * pi would silently ignore the skill. pi's loadSkillFromFile drops any skill
 * whose frontmatter YAML has no non-empty string `description` (explicit
 * `--skill` paths get no visible warning at all). Mirrors pi's
 * parseFrontmatter/loadSkillFromFile rules but stays permissive: it only
 * rejects descriptions that are definitely unusable, so an exotic-but-valid
 * YAML form is never blocked here.
 */
function readSkillDescription(filePath) {
  let raw = "";
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`--dev-skill could not read ${filePath}: ${error.message}`);
  }
  // pi normalizes line endings before looking for the frontmatter block.
  const text = raw.replace(/\r\n?/g, "\n");
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const lines = text.slice(4, end).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^description[ \t]*:[ \t]*(.*)$/.exec(lines[index]);
    if (!match) continue;
    const inline = match[1].trim();
    if (!inline || inline === "null" || inline === "~") return null;
    // YAML block scalar: `|`, `>`, `|-`, `>-`, `|2`, `>+2`, ...
    if (/^[|>][+-]?[0-9]*$/.test(inline)) {
      const block = [];
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const line = lines[cursor];
        if (line.trim() === "") {
          block.push("");
          continue;
        }
        if (!/^[ \t]/.test(line)) break; // dedent ends the block
        block.push(line);
      }
      return block.join("\n").trim() || null;
    }
    // Quoted scalar: trust it when the closing quote is on the same line.
    const quote = inline[0];
    if (quote === "\"" || quote === "'") {
      const close = inline.indexOf(quote, 1);
      return close > 0 && inline.slice(1, close).trim() ? inline.slice(1, close) : null;
    }
    // Plain scalar: a trailing comment is not part of the value; YAML
    // collections are objects/arrays, which pi rejects as non-strings.
    const value = inline.replace(/[ \t]+#.*$/, "").trim();
    if (!value || value.startsWith("[") || value.startsWith("{")) return null;
    return value;
  }
  return null;
}

/**
 * Resolve `--dev-skill` values to concrete absolute paths and fail fast on typos.
 *
 * Roles run with `--no-skills`, so each entry is an explicit path handed to pi's
 * repeatable `--skill` flag (a skill file or a directory holding SKILL.md).
 * Validation belongs at init/configure time: a missing path discovered in round 3
 * has already burned the rounds that were supposed to use the skill. Relative
 * paths resolve against the invocation cwd and are frozen absolute in the state,
 * so a later run from another directory still injects the same skills.
 */
function normalizeDevSkills(values, cwd, { home = os.homedir() } = {}) {
  if (values === undefined || values === null) return undefined;
  const list = Array.isArray(values) ? values : [values];
  if (!list.length) return undefined;
  const resolved = [];
  for (const raw of list) {
    const value = String(raw).trim();
    if (!value) throw new Error("--dev-skill requires a skill file or directory path");
    const expanded = value === "~"
      ? home
      : value.startsWith("~/")
        ? path.join(home, value.slice(2))
        : value;
    const target = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
    if (!existsSync(target)) {
      throw new Error(`--dev-skill path does not exist: ${value} (resolved to ${target})`);
    }
    let canonical = target;
    try {
      canonical = realpathSync(target);
    } catch {
      // Keep the resolved path if the filesystem refuses to canonicalize it.
    }
    const isDirectory = existsSync(canonical) && statSync(canonical).isDirectory();
    const skillFile = isDirectory ? path.join(canonical, "SKILL.md") : canonical;
    if (isDirectory && !existsSync(skillFile)) {
      throw new Error(`--dev-skill directory has no SKILL.md: ${value} (resolved to ${canonical})`);
    }
    if (!readSkillDescription(skillFile)) {
      throw new Error(
        `--dev-skill skill has no usable frontmatter description, so pi would silently ignore it: ${value} (${skillFile}). ` +
          "Add a YAML frontmatter block with a non-empty `description` (and optionally `name`) at the top of the file.",
      );
    }
    if (!resolved.includes(canonical)) resolved.push(canonical);
  }
  return resolved;
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
    agentRetries: options.agentRetries
      ?? current.agentRetries
      ?? defaults.agentRetries
      ?? DEFAULT_AGENT_RETRIES,
    devSkills: options.devSkills ?? current.devSkills ?? defaults.devSkills ?? DEFAULT_DEV_SKILLS,
    testCommands: options.tests.length ? options.tests : (current.testCommands ?? defaults.testCommands ?? []),
    developerThinking: options.developerThinking ?? current.developerThinking ?? defaults.developerThinking ?? null,
    reviewerThinking: options.reviewerThinking ?? current.reviewerThinking ?? defaults.reviewerThinking ?? null,
    // Frozen per instance like the rest of the config; local.json can override
    // via `stallGate`, and old instances without the field fall back to defaults.
    stallGate: normalizeStallGate(options.stallGate ?? current.stallGate ?? defaults.stallGate),
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

/**
 * Detect a multi-batch "master plan" (one file holding several batches, some
 * already completed). The engine never splits a plan: it freezes the file and
 * the roles work from the current-batch marker. Starting one is legitimate, but
 * worth a soft advisory so the user can decide between "start this batch as-is"
 * and "settle the batch scope in conversation first".
 */
function detectMasterPlan(planText) {
  const text = String(planText || "");
  const marker = text.match(/(?:当前执行批次|current batch)\**\s*[:：]\s*`([^`\n]+)`/i);
  if (marker) return { currentBatch: marker[1].trim(), explicitMarker: true };
  const batchMentions = (text.match(/(?:^|\s)批\s*\d/g) || []).length;
  if (batchMentions >= 3 && /(总纲|批次)/.test(text)) return { currentBatch: null, explicitMarker: false };
  return null;
}

async function initializeWorkflow(cwd, positionals, options) {
  if (positionals.length !== 1) throw new Error("init requires exactly one plan path");
  const projectRoot = gitRoot(cwd);
  const { planSource, note: planPathNote } = resolvePlanSource(cwd, positionals[0], projectRoot);
  const planContents = await readFile(planSource);
  const masterPlan = detectMasterPlan(planContents.toString("utf8"));
  const masterPlanNote = masterPlan
    ? [
        "",
        `Note: this looks like a multi-batch master plan${masterPlan.currentBatch ? ` (current batch: ${masterPlan.currentBatch})` : ""}.`,
        "The engine does not split the file; the developer/reviewer work from this frozen copy as written.",
        "If this batch's scope/approach is not settled with the user yet, confirm it first (start as-is, or agree on the batch plan in conversation and amend the plan) — or proceed if the user already chose.",
      ].join("\n")
    : "";
  const dirty = gitStatus(projectRoot);
  if (dirty && !options.allowDirty) {
    throw new Error("Worktree is dirty. Commit/stash first, or intentionally use --allow-dirty to review the existing diff.");
  }

  const defaults = await loadWorkflowDefaults();
  const config = mergeConfig(null, options, { requireModels: true, defaults });
  // Validated and frozen absolute before anything is written on disk.
  config.devSkills = normalizeDevSkills(config.devSkills, cwd) ?? [];
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
    config.devSkills.length ? `- Developer skills (--skill): ${config.devSkills.map((skill) => `\`${skill}\``).join(", ")}` : "",
    `- Created: ${localNow()} (${localTimezoneLabel()})`,
    "",
  ]);
  return {
    state,
    paths,
    message: `Initialized workflow ${key}. Run /dev-review run. Artifacts: ${relativeTo(projectRoot, paths.root)} (timeline: ${relativeTo(projectRoot, timelineFilePath(paths))})${planPathNote ? `\nNote: ${planPathNote}` : ""}${masterPlanNote}`,
  };
}

async function configureWorkflow(cwd, options) {
  const projectRoot = gitRoot(cwd);
  const initialPaths = await existingWorkflowPaths(projectRoot, options);
  const state = await readJson(initialPaths.state);
  if (state.status === "running") throw new Error("Cannot configure a workflow marked running");
  const defaults = await loadWorkflowDefaults();
  state.config = mergeConfig(state, options, { requireModels: true, defaults });
  state.config.devSkills = normalizeDevSkills(state.config.devSkills, cwd) ?? [];
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
  if (options.agentRetries !== undefined) state.config.agentRetries = options.agentRetries;
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

async function runWorkflow({ cwd, options, piInvocation = standalonePiInvocation(), notify, onReport, invokeAgent = invokePiAgent, onStats }) {
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
    let reviewerUsage = null;
    let reviewerOutput = null;
    try {
      reviewerBefore = await repositoryFingerprint(projectRoot);
      reviewerOutput = await invokeAgent({
        role: "reviewer",
        state,
        paths,
        round,
        task: makeReviewerTask(state, paths, round, relativeTo(projectRoot, developerMarkdownPath)),
        piInvocation,
        notify,
        onStats,
      });
      reviewerUsage = reviewerOutput.usage?.line || null;
      const reviewerAfter = await repositoryFingerprint(projectRoot);
      if (reviewerBefore !== reviewerAfter) {
        throw new Error("Reviewer changed the repository. Reviewers are read-only; inspect and revert/unblock this manually.");
      }
      review = normalizeReviewerReport(extractJsonObject(reviewerOutput.finalText), round, state.openIssues);
    } catch (error) {
      const rawTextPath = await writeProtocolRawText(paths, "reviewer", round, reviewerOutput?.finalText || error?.agentFailure?.partialText);
      await escalate("reviewer-protocol-or-execution-error", {
        summary: error.message,
        ...(rawTextPath ? { rawTextPath: relativeTo(projectRoot, rawTextPath) } : {}),
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
      usage: reviewerUsage,
    }));
    history.reviewerPath = relativeTo(projectRoot, reviewerMarkdownPath);
    history.decision = review.decision;

    // Review log (findings.jsonl): appended for every decision so replay stays
    // complete; the stall gate only evaluates fix_required rounds.
    await appendFindingsLog(paths, {
      round,
      decision: review.decision,
      verdicts: review.previous_issue_verdicts.map((verdict) => ({ id: verdict.id, verdict: verdict.verdict })),
      findings: review.new_findings.map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        location: finding.location,
        requirement: finding.requirement,
        evidence: finding.evidence,
        required_fix: finding.required_fix,
        ...(finding.repeat_of ? { repeat_of: finding.repeat_of } : {}),
      })),
    });
    const stallDetection = await evaluateStallGate(state, paths, notify);
    if (stallDetection) {
      await recordStallEvents(state, paths, stallDetection);
      // Hard signal: stop the loop for a human decision before the next round.
      // The three structured options live in the escalation file and in the
      // blockedNotice surfaced by the CLI/extension.
      if (stallDetection.hard.fired) {
        const hardClusters = stallDetection.clusters.filter((cluster) => stallDetection.hard.clusters.includes(cluster.key));
        await escalate("stalled-issue-family", {
          summary: stallHardSummary(stallDetection, hardClusters),
          familyReport: hardClusters.map(stallFamilyReport).join("\n\n"),
          questions: stallHardQuestions(hardClusters),
        });
        return { state, paths, message: `Stall family requires a human decision.\n${blockedNotice(state)}` };
      }
    }

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
  if (options.agentRetries !== undefined) state.config.agentRetries = options.agentRetries;
  // Explicit on resume means "replace the frozen list"; omitting it keeps the state value.
  if (options.devSkills !== undefined) state.config.devSkills = normalizeDevSkills(options.devSkills, cwd) ?? [];
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
    let developerUsage = null;
    let developerOutput = null;
    try {
      developerOutput = await invokeAgent({
        role: "developer",
        state,
        paths,
        round,
        task: makeDeveloperTask(state, paths, round, previousReviewPath, humanDecisionPath),
        piInvocation,
        notify,
        onStats,
      });
      developerUsage = developerOutput.usage?.line || null;
      developer = normalizeDeveloperReport(extractJsonObject(developerOutput.finalText));
    } catch (error) {
      state.currentRound = round;
      // Surface the developer's actual report/questions in the escalation when the
      // failure is a protocol-validation error (the agent did answer, just malformed).
      const finalText = typeof developerOutput?.finalText === "string" && developerOutput.finalText
        ? developerOutput.finalText
        : (typeof error?.agentFailure?.partialText === "string" ? error.agentFailure.partialText : "");
      let rawReport = null;
      try {
        rawReport = extractJsonObject(finalText);
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
      const rawTextPath = await writeProtocolRawText(paths, "developer", round, finalText);
      await escalate("developer-protocol-or-execution-error", {
        summary,
        ...(rawReport ? { rawReport: JSON.stringify(rawReport, null, 2) } : {}),
        ...(rawTextPath ? { rawTextPath: relativeTo(projectRoot, rawTextPath) } : {}),
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
      usage: developerUsage,
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

export async function runCommand({ args, cwd = process.cwd(), piInvocation, notify = console.log, onReport, invokeAgent, onStats } = {}) {
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
        onStats,
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
      return { ok: true, message: stateStatus(state, paths, await usageStatusLines(paths)), state, paths };
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
      const result = await runWorkflow({ cwd, options, piInvocation, notify, onReport, invokeAgent, onStats });
      return { ok: true, message: result.message, ...result };
    }
    throw new Error(`Unknown /dev-review command: ${command}`);
  } catch (error) {
    return { ok: false, message: `dev-review: ${error.message}` };
  }
}

export {
  DEFAULT_ARTIFACT_DIR,
  addUsageRequest,
  agentFailureRetryable,
  blockedNotice,
  classifyAgentFailure,
  createUsageStats,
  detectMasterPlan,
  extractJsonObject,
  formatTokenCount,
  initializeWorkflow,
  adoptWorkflow,
  localNow,
  localTimezoneLabel,
  makeDeveloperTask,
  makeReviewerTask,
  normalizeDevSkills,
  normalizeDeveloperReport,
  normalizeReviewerReport,
  normalizeStallGate,
  planChangedSinceFrozen,
  resolvePlanSource,
  runWorkflow,
  splitArguments,
  stallIdentifiers,
  stallLocationFiles,
  stallRequirementBigrams,
  timelineFilePath,
  timelineLine,
  usageEntry,
  usageLine,
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
