/**
 * IO + rendering for the dev-review main-agent discipline.
 * Pure routing decisions live in discipline-router.mjs.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile, rm, appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { DISCIPLINE_MARKER, isOverrideActive } from "./discipline-router.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DISCIPLINE_PATH = join(here, "discipline.md");
export const ARTIFACT_ROOT = ".ai-dev-review";
export const OVERRIDE_NAME = "discipline-override.json";
export const AUDIT_NAME = "discipline-audit.jsonl";

let cachedDiscipline = null;

/** Load the single-source discipline text; version = content hash prefix. */
export async function loadDiscipline() {
  if (cachedDiscipline) return cachedDiscipline;
  try {
    const text = (await readFile(DISCIPLINE_PATH, "utf8")).trim();
    cachedDiscipline = {
      text,
      version: createHash("sha256").update(text).digest("hex").slice(0, 8),
    };
  } catch {
    cachedDiscipline = { text: "", version: "missing" };
  }
  return cachedDiscipline;
}

export function artifactRoot(projectRoot) {
  return join(projectRoot, ARTIFACT_ROOT);
}

/** Walk up from startDir: nearest dir holding an active workflow pointer, else the git root. */
export function findProjectRoot(startDir) {
  let dir = resolve(startDir || process.cwd());
  let gitRoot = null;
  for (;;) {
    if (existsSync(join(dir, ARTIFACT_ROOT, "active-workflow.json"))) return dir;
    if (!gitRoot && existsSync(join(dir, ".git"))) gitRoot = dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return gitRoot;
}

/** Read the active workflow state for a project root. Never throws. */
export async function readWorkflowState(projectRoot) {
  if (!projectRoot) return { found: false };
  try {
    const pointer = JSON.parse(
      await readFile(join(projectRoot, ARTIFACT_ROOT, "active-workflow.json"), "utf8"),
    );
    if (!pointer || typeof pointer.artifactDir !== "string") return { found: false };
    const artifactDir = join(projectRoot, pointer.artifactDir);
    const state = JSON.parse(await readFile(join(artifactDir, "state.json"), "utf8"));
    const issue = Array.isArray(state.openIssues) && state.openIssues.length ? state.openIssues[0] : null;
    return {
      found: true,
      projectRoot,
      artifactDir,
      key: state.workflow?.key || pointer.workflowKey || null,
      status: String(state.status || ""),
      phase: String(state.phase || ""),
      currentRound: state.currentRound ?? null,
      maxRounds: state.config?.maxReviewRounds ?? null,
      openIssue: issue
        ? { id: issue.id, severity: issue.severity, requirement: issue.requirement || "" }
        : null,
    };
  } catch {
    return { found: false };
  }
}

/** Read a non-expired override, or null. */
export async function readOverride(projectRoot) {
  if (!projectRoot) return null;
  try {
    const raw = JSON.parse(await readFile(join(artifactRoot(projectRoot), OVERRIDE_NAME), "utf8"));
    if (!raw || typeof raw !== "object" || typeof raw.reason !== "string") return null;
    return isOverrideActive(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Suspend the discipline; minutes = null means until manually resumed. */
export async function writeOverride(projectRoot, { reason, minutes }) {
  const dir = artifactRoot(projectRoot);
  await mkdir(dir, { recursive: true });
  const createdAt = new Date();
  const until = minutes === null ? null : new Date(createdAt.getTime() + minutes * 60_000).toISOString();
  const record = { reason, createdAt: createdAt.toISOString(), until, minutes, forever: minutes === null };
  await writeFile(join(dir, OVERRIDE_NAME), JSON.stringify(record, null, 2) + "\n", "utf8");
  await appendAudit(projectRoot, { action: "suspend", reason, until, minutes });
  return record;
}

export async function clearOverride(projectRoot, { reason = "resumed by user" } = {}) {
  await rm(join(artifactRoot(projectRoot), OVERRIDE_NAME), { force: true });
  await appendAudit(projectRoot, { action: "resume", reason });
}

/** Append-only audit trail for escapes (project-local, never committed). */
export async function appendAudit(projectRoot, entry) {
  try {
    await mkdir(artifactRoot(projectRoot), { recursive: true });
    await appendFile(
      join(artifactRoot(projectRoot), AUDIT_NAME),
      JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n",
      "utf8",
    );
  } catch {}
}

export function renderDiscipline(template, workflow) {
  const header = workflow?.found
    ? [
        `当前工作流：${workflow.key || "?"} · 状态 ${workflow.status} · 第 ${workflow.currentRound ?? "?"}/${workflow.maxRounds ?? "?"} 轮`,
        workflow.openIssue ? `开放问题：${workflow.openIssue.id}（${workflow.openIssue.severity}）` : null,
      ].filter(Boolean).join(" · ")
    : "当前工作流：未知";
  return `${DISCIPLINE_MARKER}\n${template}\n\n> ${header}\n> 实时状态以 dev_review_status 为准。`;
}

export function renderSuspended(override) {
  const until = override?.until
    ? new Date(override.until).toLocaleString("zh-CN", { hour12: false })
    : "用户手动恢复";
  const reason = override?.reason ? `理由：${override.reason}` : "未提供理由";
  return [
    `dev-review 主 agent 纪律已被用户临时挂起（${reason}）。`,
    `挂起至：${until}。期间按普通模式工作；若改动了工作流范围内的文件，需在日志或决策 note 中注明「未经工作流评审」。`,
  ].join("\n");
}

export function renderLifted() {
  return "dev-review 工作流已结束，主 agent 纪律解除：恢复普通模式。";
}
