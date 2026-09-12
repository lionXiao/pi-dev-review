/**
 * Pure routing logic for the dev-review main-agent discipline.
 *
 * No IO in this module (see discipline-runtime.mjs): the decision of
 * "append vs checkpoint vs nothing" is code, not prompt. Unit-tested in
 * tests/discipline-router.test.mjs.
 *
 * Design (agreed 2026-09-12):
 * - Tail append: cheap, no prompt-cache invalidation; used for state changes
 *   between checkpoints.
 * - Checkpoint: rewrite the system-prompt baseline only at "free moments"
 *   (session start / compaction / branch switch) where the provider cache is
 *   being rebuilt anyway.
 * - Staleness is asymmetric and safe: a stale baseline can only be
 *   over-restrictive, and the newest tail notice wins.
 * - Hard enforcement (tool_call) never depends on the model reading anything.
 */

export const DISCIPLINE_MARKER = "<!-- dev-review-discipline -->";
export const POLICY_MARKER = "<!-- dev-review-policy -->";

/** Statuses that mean the workflow no longer applies. */
export const INACTIVE_STATUSES = new Set(["passed", "abandoned", "complete", "cancelled"]);

export function isWorkflowActive(workflow) {
  if (!workflow || !workflow.found) return false;
  const status = String(workflow.status || "").toLowerCase();
  if (!status) return false;
  return !INACTIVE_STATUSES.has(status);
}

export function isOverrideActive(override, now = Date.now()) {
  if (!override || typeof override !== "object") return false;
  if (override.until === null || override.until === undefined) {
    return override.forever === true;
  }
  const until = Date.parse(override.until);
  return Number.isFinite(until) && until > now;
}

export function overrideIdentity(override) {
  if (!override) return "unknown";
  return String(override.createdAt || override.until || "unknown");
}

/**
 * Whether the discipline should currently apply.
 * @returns {{desired: boolean, reason: "active"|"inactive"|"suspended"}}
 */
export function desiredDiscipline(workflow, override, now = Date.now()) {
  if (!isWorkflowActive(workflow)) return { desired: false, reason: "inactive" };
  if (isOverrideActive(override, now)) return { desired: false, reason: "suspended" };
  return { desired: true, reason: "active" };
}

export function noticeKey({ desired, reason, version, override = null }) {
  if (desired) return `active:${version}`;
  if (reason === "suspended") return `suspended:${overrideIdentity(override)}`;
  return "lifted";
}

/**
 * @param {object} input
 * @param {"checkpoint"|"user_turn"} input.event
 * @param {boolean} input.desired - whether discipline should apply right now
 * @param {"active"|"inactive"|"suspended"} input.reason
 * @param {string} input.version - discipline text version (hash prefix)
 * @param {object|null} [input.override]
 * @param {boolean} [input.baselineActive] - what the system-prompt baseline currently claims
 * @param {string} [input.appendedKey] - key of the last tail notice appended in this session
 * @returns {{action:"checkpoint"|"append"|"none", baselineActive?:boolean, appendedKey:string, kind?:"active"|"suspended"|"lifted"}}
 */
export function routeDiscipline(input) {
  const {
    event,
    desired,
    reason,
    version,
    override = null,
    baselineActive = false,
    appendedKey = "none",
  } = input;
  const key = noticeKey({ desired, reason, version, override });

  if (event === "checkpoint") {
    // Free moment: the cache is being rebuilt anyway, so fold the current
    // state into the system-prompt baseline and mark the tail as in sync.
    return { action: "checkpoint", baselineActive: desired, appendedKey: key };
  }

  if (event !== "user_turn") return { action: "none", appendedKey };

  if (key === appendedKey) return { action: "none", appendedKey };

  // Nothing was ever appended and the baseline is empty: there is nothing to
  // lift, so stay silent instead of emitting a spurious "lifted" notice.
  if (!desired && !baselineActive && reason !== "suspended" &&
      (appendedKey === "none" || appendedKey === "lifted")) {
    return { action: "none", appendedKey: "lifted" };
  }

  return {
    action: "append",
    kind: desired ? "active" : reason === "suspended" ? "suspended" : "lifted",
    appendedKey: key,
  };
}

/** Hard gate: the main agent may not modify files while the discipline applies. */
export function shouldBlockTool(toolName, { desired }) {
  if (!desired) return false;
  return toolName === "edit" || toolName === "write";
}
