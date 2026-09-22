import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHmac } from "node:crypto";
import { Type } from "typebox";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { runCommand, detectMasterPlan } from "../../dev-review/workflow.mjs";
import {
  DISCIPLINE_MARKER,
  POLICY_MARKER,
  desiredDiscipline,
  isWorkflowActive,
  routeDiscipline,
  shouldBlockTool,
} from "../../dev-review/discipline-router.mjs";
import {
  clearOverride,
  findProjectRoot,
  loadDiscipline,
  loadExtensionConfig,
  loadPolicy,
  readOverride,
  readWorkflowState,
  renderDiscipline,
  renderLifted,
  renderPolicy,
  renderSuspended,
  writeOverride,
} from "../../dev-review/discipline-runtime.mjs";

type WorkflowReport = {
  role: "developer" | "reviewer" | "escalation";
  round: number;
  status: string;
  summary: string;
  artifactPath: string;
  markdown: string;
};

function currentPiInvocation() {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript] };
  }

  const executable = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executable)) {
    return { command: process.execPath, args: [] };
  }

  return { command: process.env.PI_BIN || "pi", args: [] };
}

function reportTitle(report: WorkflowReport) {
  if (report.role === "escalation") {
    return `Escalation · ${report.status} · needs human decision`;
  }
  return `${report.role === "developer" ? "Development" : "Review"} · round ${report.round} · ${report.status}`;
}

/** Resolve a plan path for the master-plan preflight (cwd first, then project root). */
function resolvePlanPathForCheck(cwd: string, plan: string) {
  const fromCwd = resolve(cwd || process.cwd(), plan);
  if (existsSync(fromCwd)) return fromCwd;
  const root = findProjectRoot(cwd || process.cwd());
  const fromRoot = root ? resolve(root, plan) : fromCwd;
  return existsSync(fromRoot) ? fromRoot : fromCwd;
}

export default function (pi: any) {
  // These entries are deliberately TUI-only: the parent requirements-chat
  // session can display every completed handoff without injecting either role's
  // output into the parent's LLM context or into the other child role.
  pi.registerEntryRenderer<WorkflowReport>("dev-review-report", (entry: any, { expanded }: any, theme: any) => {
    const report = entry.data as WorkflowReport;
    const icon = report.role === "developer"
      ? theme.fg("accent", "◆")
      : report.role === "reviewer"
        ? theme.fg("success", "◇")
        : theme.fg("error", "⚠");
    const header = `${icon} ${theme.bold(reportTitle(report))}`;
    const summary = report.summary.replace(/\s+/g, " ").slice(0, 220);

    if (!expanded) {
      return new Text(
        `${header}\n${summary}${report.summary.length > 220 ? "…" : ""}\n${theme.fg("dim", report.artifactPath)}${theme.fg("muted", "  (Ctrl+O to expand)")}`,
        0,
        0,
      );
    }

    const container = new Container();
    container.addChild(new Text(header, 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(new Markdown(report.markdown.trim(), 0, 0, getMarkdownTheme()));
    return container;
  });

  // One-shot workflow notices: discipline state changes and stopped-run
  // reasons. Blocked notices are rendered in the TUI (display: true) so the
  // user also sees *why*; the LLM sees the same content either way.
  pi.registerMessageRenderer("dev-review-notice", (message: any, { expanded }: any, theme: any) => {
    const content = String(message?.content || "");
    const lines = content.split("\n");
    const head = theme.fg("warning", "⚠ dev-review");
    if (expanded || lines.length <= 6) return new Text(`${head}\n${content}`, 0, 0);
    return new Text(
      `${head}\n${lines.slice(0, 6).join("\n")}\n${theme.fg("dim", `… 还有 ${lines.length - 6} 行（Ctrl+O 展开）`)}`,
      0,
      0,
    );
  });

  // ---- Main-agent discipline (single source: dev-review/discipline.md) ----
  // Routing is code, not prompt: tail appends carry state changes, system-prompt
  // checkpoints happen only at free moments (session start / compaction / tree)
  // where the provider cache is rebuilt anyway, and the tool gate is the
  // backstop that never depends on the model reading anything.
  const disciplineState = { baselineActive: false, baselineText: "", appendedKey: "none" };

  const readDisciplineContext = async (ctx: any) => {
    const cwd = ctx?.cwd || process.cwd();
    const projectRoot = findProjectRoot(cwd);
    const workflow = await readWorkflowState(projectRoot);
    const override = await readOverride(projectRoot);
    return { projectRoot, workflow, override, ...desiredDiscipline(workflow, override) };
  };

  const checkpointDiscipline = async (ctx: any) => {
    const s = await readDisciplineContext(ctx);
    const { text, version } = await loadDiscipline();
    const policy = await loadPolicy();
    const config = await loadExtensionConfig();
    const policyBlock = config.injectWorkingAgreement && policy.text ? renderPolicy(policy.text) : "";
    const disciplineBlock = s.desired ? renderDiscipline(text, s.workflow) : "";
    disciplineState.baselineActive = s.desired;
    disciplineState.baselineText = [policyBlock, disciplineBlock].filter(Boolean).join("\n\n");
    disciplineState.appendedKey = s.desired ? `active:${version}` : "lifted";
  };

  pi.on("session_start", async (_event: any, ctx: any) => { await checkpointDiscipline(ctx); });
  pi.on("session_compact", async (_event: any, ctx: any) => { await checkpointDiscipline(ctx); });
  pi.on("session_tree", async (_event: any, ctx: any) => { await checkpointDiscipline(ctx); });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    if (!disciplineState.baselineText) await checkpointDiscipline(ctx);
    const s = await readDisciplineContext(ctx);
    const runNotice = await syncRunStatus(ctx, s.workflow);
    const { text, version } = await loadDiscipline();
    const route = routeDiscipline({
      event: "user_turn",
      desired: s.desired,
      reason: s.reason,
      version,
      override: s.override,
      baselineActive: disciplineState.baselineActive,
      appendedKey: disciplineState.appendedKey,
    });
    disciplineState.appendedKey = route.appendedKey;
    const out: any = {};
    if (disciplineState.baselineText) {
      out.systemPrompt = `${event.systemPrompt}\n\n${disciplineState.baselineText}`;
    }
    const notices: string[] = [];
    if (route.action === "append") {
      notices.push(route.kind === "active"
        ? renderDiscipline(text, s.workflow)
        : route.kind === "suspended"
          ? renderSuspended(s.override)
          : renderLifted());
    }
    if (runNotice) notices.push(runNotice);
    if (notices.length) {
      out.message = {
        customType: "dev-review-notice",
        content: notices.join("\n\n"),
        display: Boolean(runNotice),
      };
    }
    return out.message || out.systemPrompt ? out : undefined;
  });

  // Mid-run safety net: auto-compaction can happen between tool calls, where
  // before_agent_start does not fire again. Patch the provider payload only
  // when the baseline marker is missing; never toggle per turn.
  const payloadHasMarker = (payload: any): boolean => {
    const markers = [DISCIPLINE_MARKER, POLICY_MARKER];
    const has = (value: any): boolean =>
      typeof value === "string"
        ? markers.some((marker) => value.includes(marker))
        : Array.isArray(value) && value.some((part: any) => has(part?.text));
    try {
      if (has(payload?.system)) return true;
      const system = Array.isArray(payload?.messages)
        ? payload.messages.find((m: any) => m?.role === "system")
        : null;
      return Boolean(system && has(system.content));
    } catch {
      return false;
    }
  };

  const patchPayloadSystem = (payload: any, text: string) => {
    const marked = `${DISCIPLINE_MARKER}\n${text}`;
    if (typeof payload.system === "string") return { ...payload, system: `${payload.system}\n\n${marked}` };
    if (Array.isArray(payload.system)) return { ...payload, system: [...payload.system, { type: "text", text: marked }] };
    if (Array.isArray(payload.messages)) {
      const messages = [...payload.messages];
      const index = messages.findIndex((m: any) => m?.role === "system");
      if (index >= 0) {
        const content = typeof messages[index].content === "string"
          ? `${messages[index].content}\n\n${marked}`
          : [...(Array.isArray(messages[index].content) ? messages[index].content : []), { type: "text", text: marked }];
        messages[index] = { ...messages[index], content };
        return { ...payload, messages };
      }
    }
    return null;
  };

  pi.on("before_provider_request", (event: any) => {
    if (!disciplineState.baselineText) return;
    try {
      if (payloadHasMarker(event.payload)) return;
      return patchPayloadSystem(event.payload, disciplineState.baselineText) ?? undefined;
    } catch {
      return;
    }
  });

  // Hard gate: while the discipline applies, the main agent cannot modify files.
  // Sub-agents run pi with --no-extensions, so they are never affected.
  pi.on("tool_call", async (event: any, ctx: any) => {
    const s = await readDisciplineContext(ctx);
    if (shouldBlockTool(event?.toolName, { desired: s.desired })) {
      return {
        block: true,
        reason: "dev-review 工作流活跃：主 agent 不得修改文件。请用 dev_review_resolve / dev_review_run 推进工作流；确需例外时由用户执行 /dev-review escape 临时挂起纪律。",
      };
    }
  });

  const disciplineStatusLine = async (cwd: string) => {
    const projectRoot = findProjectRoot(cwd);
    const workflow = await readWorkflowState(projectRoot);
    const override = await readOverride(projectRoot);
    const { desired, reason } = desiredDiscipline(workflow, override);
    const state = desired
      ? `生效中（${workflow.key || "?"} · ${workflow.status}）`
      : reason === "suspended"
        ? `已挂起（${override.reason}，至 ${override.until ? new Date(override.until).toLocaleString("zh-CN", { hour12: false }) : "手动恢复"}）`
        : "未生效（无活跃工作流）";
    return `[discipline] ${state}`;
  };

  const handleEscape = async (args: string, ctx: any, notify: (message: string, level?: string) => void) => {
    const cwd = ctx?.cwd || process.cwd();
    const projectRoot = findProjectRoot(cwd);
    if (!projectRoot) {
      notify("未找到项目根目录（无 .git 或 .ai-dev-review）。", "error");
      return;
    }
    const workflow = await readWorkflowState(projectRoot);
    const action = (args.trim().split(/\s+/)[1] || "status").toLowerCase();

    if (action === "off" || action === "clear") {
      await clearOverride(projectRoot);
      notify("已提前恢复 dev-review 主 agent 纪律。", "info");
      return;
    }
    if (action === "status") {
      notify(await disciplineStatusLine(cwd), "info");
      return;
    }
    if (!isWorkflowActive(workflow)) {
      notify("当前项目没有活跃工作流，无需挂起纪律。", "error");
      return;
    }
    const noteMatch = args.match(/--note\s+(?:"([^"]*)"|'([^']*)'|(\S+))/);
    const minutesMatch = args.match(/--minutes\s+(\d+)/);
    const forever = /--forever\b/.test(args);
    const reason = (noteMatch && (noteMatch[1] ?? noteMatch[2] ?? noteMatch[3])) || "";
    if (!reason) {
      notify('用法：/dev-review escape --note "原因" [--minutes 30 | --forever]；/dev-review escape off；/dev-review escape status', "error");
      return;
    }
    const minutes = forever ? null : minutesMatch ? Math.max(1, Number(minutesMatch[1])) : 30;
    const record = await writeOverride(projectRoot, { reason, minutes });
    const untilText = record.until ? new Date(record.until).toLocaleString("zh-CN", { hour12: false }) : "手动恢复";
    notify(`dev-review 纪律已挂起至 ${untilText}（理由：${reason}）；已写入审计日志。`, "info");
  };

  // ---- Background workflow runs ------------------------------------------
  // run/start no longer block the agent turn: the engine keeps running in the
  // background while a widget tracks progress, so the user can keep chatting.
  // When the loop stops, a summary user message wakes the main agent.
  const RUN_STATUS_KEY = "dev-review-run";
  const RUN_WIDGET_KEY = "dev-review-run";
  const EXTERNAL_POLL_MS = Number(process.env.DEV_REVIEW_POLL_MS || 10000);
  let backgroundRun: { startedAt: number; lastMessage: string; timelinePath?: string; roleLine?: string; usageLine?: string; timer: ReturnType<typeof setInterval> | null } | null = null;
  let externalRun: { timer: ReturnType<typeof setInterval>; startedAt: number } | null = null;
  // Last terminal state (blocked/passed) this session has already told the main
  // agent about; prevents repeating the wake-up message on every user turn.
  let surfacedStateKey: string | null = null;

  const agoLabel = (iso: string | undefined) => {
    const at = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(at)) return "未知";
    const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
    return seconds < 60 ? `${seconds}s 前` : `${Math.floor(seconds / 60)}m 前`;
  };

  /** Latest token-usage line written by the engine (reports/usage.json). */
  const readUsageLine = async (artifactDir: string | null | undefined) => {
    if (!artifactDir) return null;
    try {
      const raw = JSON.parse(await readFile(join(artifactDir, "reports", "usage.json"), "utf8"));
      const entries = Array.isArray(raw?.entries)
        ? raw.entries.filter((entry: any) => entry && typeof entry.line === "string")
        : [];
      return entries.length ? entries[entries.length - 1].line : null;
    } catch {
      return null;
    }
  };

  const summarizeRunStatus = (message: string) => {
    const text = String(message || "");
    const blocked = text.match(/Blocked \(([^)]+)\)/);
    if (blocked) return `blocked (${blocked[1]})`;
    if (/passed|pass(ed)? after/i.test(text)) return "passed";
    if (/human decision|blocked/i.test(text)) return "blocked";
    if (/max rounds/i.test(text)) return "max-rounds";
    return "stopped";
  };

  const terminalStateKey = (
    status: string,
    key: string | null | undefined,
    updatedAt: string | null | undefined,
  ) => {
    if (status === "blocked") return `blocked:${key || "?"}:${updatedAt || "?"}`;
    if (status === "passed" || status === "abandoned") return `${status}:${key || "?"}:${updatedAt || "?"}`;
    return null;
  };

  // Wake-up text for a stopped run: reason code + engine summary + decision
  // questions/options, so the main agent can explain *why* it blocked and what
  // the human must choose without another round-trip.
  const stopNoticeText = (workflow: any, label: string, origin = "") => {
    const reason = workflow?.blocked?.reason;
    const reasonPart = reason && !label.includes(reason) ? `（${reason}）` : "";
    const summary = String(workflow?.blocked?.summary || "").replace(/\s+/g, " ").trim();
    const lines = [`[dev-review] 工作流已停止${origin}：${label}${reasonPart}。`];
    if (summary) lines.push(`为什么停：${summary.slice(0, 600)}`);
    const questions = Array.isArray(workflow?.blocked?.questions) ? workflow.blocked.questions : [];
    questions.slice(0, 2).forEach((item: any, index: number) => {
      lines.push(`待决定 Q${index + 1}：${String(item?.question || "").replace(/\s+/g, " ").slice(0, 220)}`);
      (Array.isArray(item?.options) ? item.options : []).slice(0, 4).forEach((option: string, optionIndex: number) => {
        lines.push(`  ${optionIndex + 1}) ${String(option).replace(/\s+/g, " ").slice(0, 200)}`);
      });
    });
    if (questions.length > 2) lines.push(`（还有 ${questions.length - 2} 个决策问题，见 dev_review_status 或决策文件）`);
    if (workflow?.timelinePath) lines.push(`时间线：${workflow.timelinePath}（按顺序记录 dev/review/决策全过程）`);
    lines.push("请把阻塞原因、需要用户决定什么转述给用户，并说明下一步。");
    return lines.join("\n");
  };

  // "dev r1 · opencode-go/deepseek-flash · thinking max" — which role is running,
  // with which provider/model and thinking level. Provider comes from the
  // provider/model config string.
  const roleLineFor = (workflow: any) => {
    const phase = String(workflow?.phase || "").toLowerCase();
    const isReview = phase === "review";
    const model = (isReview ? workflow?.reviewerModel : workflow?.developerModel) || null;
    const thinking = (isReview ? workflow?.reviewerThinking : workflow?.developerThinking) || null;
    if (!model && !workflow?.found) return null;
    // During the development phase state.currentRound still holds the previous
    // round (it is committed after the developer report is written).
    const round = isReview
      ? workflow?.currentRound ?? "?"
      : (workflow?.currentRound ?? 0) + 1;
    const role = `${isReview ? "review" : "dev"} r${round}`;
    if (!model) return role;
    const slash = model.indexOf("/");
    const provider = slash > 0 ? model.slice(0, slash) : null;
    const name = slash > 0 ? model.slice(slash + 1) : model;
    return [role, provider ? `${provider} / ${name}` : name, thinking ? `thinking ${thinking}` : null]
      .filter(Boolean)
      .join(" · ");
  };

  /** Compact model summary for stopped/idle states: both roles at a glance. */
  const configLineFor = (workflow: any) => {
    const short = (model: string | null, thinking: string | null) => {
      if (!model) return null;
      const slash = model.indexOf("/");
      const name = slash > 0 ? model.slice(slash + 1) : model;
      return `${name}${thinking ? ` (${thinking})` : ""}`;
    };
    const dev = short(workflow?.developerModel, workflow?.developerThinking);
    const review = short(workflow?.reviewerModel, workflow?.reviewerThinking);
    if (!dev && !review) return null;
    return [`dev: ${dev || "?"}`, `review: ${review || "?"}`].join(" · ");
  };

  const renderRunWidget = (ctx: any) => {
    try {
      if (!backgroundRun) {
        ctx?.ui?.setWidget?.(RUN_WIDGET_KEY, undefined);
        return;
      }
      const seconds = Math.max(0, Math.floor((Date.now() - backgroundRun.startedAt) / 1000));
      const clock = `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
      const lines = [`dev-review ▶ 运行中 ${clock}`];
      if (backgroundRun.roleLine) lines.push(backgroundRun.roleLine);
      if (backgroundRun.usageLine) lines.push(backgroundRun.usageLine);
      lines.push(backgroundRun.lastMessage ? `最近：${backgroundRun.lastMessage}` : "启动中…");
      lines.push(
        backgroundRun.timelinePath ? `日志：${backgroundRun.timelinePath}` : "输入不会被阻塞 · 详情用 dev_review_status",
      );
      ctx?.ui?.setWidget?.(RUN_WIDGET_KEY, lines, { placement: "belowEditor" });
      const role = backgroundRun.roleLine ? ` · ${backgroundRun.roleLine.split(" · ")[0]}` : "";
      ctx?.ui?.setStatus?.(RUN_STATUS_KEY, `dev-review: ${clock}${role}`);
    } catch {}
  };

  // The engine writes the workflow state (timeline path, active phase/round,
  // role/model) a moment after a managed run starts, and rewrites it on every
  // phase transition (dev rN -> review rN -> dev rN+1). Re-read it every tick so
  // the header follows the round actually running instead of freezing on the
  // one that happened to be active at startup; render only when it changes.
  const refreshRunWorkflow = async (ctx: any) => {
    if (!backgroundRun) return;
    try {
      const workflow = await readWorkflowState(findProjectRoot(ctx?.cwd || process.cwd()));
      if (!workflow.found) return;
      let changed = false;
      if (workflow.timelinePath && !backgroundRun.timelinePath) {
        backgroundRun.timelinePath = workflow.timelinePath;
        changed = true;
      }
      const roleLine = roleLineFor(workflow);
      if (roleLine && roleLine !== backgroundRun.roleLine) {
        backgroundRun.roleLine = roleLine;
        changed = true;
      }
      if (changed) renderRunWidget(ctx);
    } catch {}
  };

  // External runs: an engine started by a plain CLI/bash invocation (or by a
  // previous pi session). We cannot hook its completion, so poll its state
  // file: keep the widget accurate and wake the agent once when it stops.
  const stopExternalWatch = (ctx?: any) => {
    if (externalRun?.timer) clearInterval(externalRun.timer);
    externalRun = null;
    try {
      ctx?.ui?.setWidget?.(RUN_WIDGET_KEY, undefined);
    } catch {}
  };

  const renderExternalWidget = (ctx: any, workflow: any, usageLine: string | null = null) => {
    try {
      const round = `${workflow?.currentRound ?? "?"}/${workflow?.maxRounds ?? "?"}`;
      const lines = [`dev-review ▶ 运行中 · r${round}（外部启动）`];
      const roleLine = roleLineFor(workflow);
      if (roleLine) lines.push(roleLine);
      if (usageLine) lines.push(usageLine);
      lines.push(`最近引擎更新：${agoLabel(workflow?.updatedAt)}`);
      lines.push(
        workflow?.timelinePath ? `日志：${workflow.timelinePath}` : "输入不会被阻塞 · 详情用 dev_review_status",
      );
      ctx?.ui?.setWidget?.(RUN_WIDGET_KEY, lines, { placement: "belowEditor" });
      const role = roleLine ? ` ${roleLine.split(" · ")[0]}` : ` r${round}`;
      ctx?.ui?.setStatus?.(RUN_STATUS_KEY, `dev-review: running${role}`);
    } catch {}
  };

  const ensureExternalWatch = (ctx: any, workflow: any) => {
    if (externalRun) return;
    const tick = async () => {
      if (backgroundRun) {
        stopExternalWatch(ctx);
        return;
      }
      const root = findProjectRoot(ctx?.cwd || process.cwd());
      const fresh = await readWorkflowState(root);
      if (fresh.found && String(fresh.status) === "running") {
        renderExternalWidget(ctx, fresh, await readUsageLine(fresh.artifactDir));
        return;
      }
      const status = fresh.found ? String(fresh.status || "") : "stopped";
      const label = status === "blocked"
        ? `blocked${fresh.blocked?.reason ? ` (${fresh.blocked.reason})` : ""}`
        : status;
      stopExternalWatch(ctx);
      try {
        ctx?.ui?.setStatus?.(RUN_STATUS_KEY, `dev-review: ${label}`);
      } catch {}
      surfacedStateKey = terminalStateKey(status, fresh.key, fresh.updatedAt) ?? surfacedStateKey;
      workflowNotify(`dev-review 引擎已停止：${label}`);
      try {
        pi.sendUserMessage(stopNoticeText(fresh, label, "（外部启动，轮询检测）"), { deliverAs: "followUp" });
      } catch {}
    };
    externalRun = { timer: setInterval(() => void tick(), EXTERNAL_POLL_MS), startedAt: Date.now() };
    void tick();
  };

  // Called on every turn: the footer/widget always reflect the real state on
  // disk, whoever started the run. Managed runs keep their own widget.
  // Returns a one-shot notice when a run stopped outside this session's watch
  // (bash/CLI start, or finished before a reload) so the main agent still learns
  // the reason instead of only seeing a status-bar label.
  const syncRunStatus = async (ctx: any, workflow: any): Promise<string | null> => {
    if (backgroundRun) return null;
    const status = workflow?.found ? String(workflow.status || "") : "";
    if (status === "running") {
      ensureExternalWatch(ctx, workflow);
      renderExternalWidget(ctx, workflow, await readUsageLine(workflow.artifactDir));
      return null;
    }
    if (externalRun) stopExternalWatch(ctx);
    const label =
      status === "blocked"
        ? `blocked${workflow.blocked?.reason ? ` (${workflow.blocked.reason})` : ""}`
        : status === "passed" || status === "ready" || status === "abandoned"
          ? status
          : undefined;
    try {
      ctx?.ui?.setStatus?.(RUN_STATUS_KEY, label ? `dev-review: ${label}` : undefined);
    } catch {}
    // Keep the path of the unified timeline and the configured models visible
    // while the workflow is in a state where the user may want to inspect it
    // (blocked / ready).
    try {
      if (workflow?.found && workflow.timelinePath && (status === "blocked" || status === "ready")) {
        const lines = [`dev-review ${label || status}`];
        const roleLine = roleLineFor(workflow);
        const configLine = configLineFor(workflow);
        if (status === "ready" && roleLine) lines.push(roleLine);
        else if (configLine) lines.push(configLine);
        const usageLine = await readUsageLine(workflow.artifactDir);
        if (usageLine) lines.push(usageLine);
        lines.push(`日志：${workflow.timelinePath}`);
        ctx?.ui?.setWidget?.(RUN_WIDGET_KEY, lines, { placement: "belowEditor" });
      } else {
        ctx?.ui?.setWidget?.(RUN_WIDGET_KEY, undefined);
      }
    } catch {}

    const key = terminalStateKey(status, workflow?.key, workflow?.updatedAt);
    if (!key || key === surfacedStateKey) return null;
    surfacedStateKey = key;
    return stopNoticeText(workflow, label || status);
  };

  // An unattended batch (protocol: dev-review/unattended.md) keeps a queue file
  // in place while it runs. When it exists, a stopped run must be handled by the
  // batch rules (analyze -> verify-or-skip -> commit -> next plan) instead of
  // asking the user to triage mid-batch.
  const inUnattendedBatch = (ctx: any) => {
    try {
      const root = findProjectRoot(ctx?.cwd || process.cwd());
      return Boolean(root) && existsSync(join(root, ".ai-dev-review", "unattended-queue.md"));
    } catch {
      return false;
    }
  };

  const finishBackgroundRun = (ctx: any, result: { ok?: boolean; message?: string }) => {
    const message = result?.message || "dev-review 运行结束（无消息）";
    if (backgroundRun?.timer) clearInterval(backgroundRun.timer);
    backgroundRun = null;
    // The completion message below already carries the reason; mark this state
    // as surfaced so the next turn does not repeat it via syncRunStatus.
    const finalState = (result as any)?.state;
    if (finalState?.status) {
      surfacedStateKey =
        terminalStateKey(String(finalState.status), finalState.workflow?.key, finalState.updatedAt) ?? surfacedStateKey;
    }
    renderRunWidget(ctx);
    try {
      ctx?.ui?.setStatus?.(RUN_STATUS_KEY, `dev-review: ${summarizeRunStatus(message)}`);
    } catch {}
    workflowNotify(message);
    const text = inUnattendedBatch(ctx)
      ? [
          `[dev-review] 后台运行结束：${message}`,
          "【无人值守批跑】队列进行中（.ai-dev-review/unattended-queue.md）：按 ~/.pi/agent/dev-review/unattended.md 处理，不要等待或打扰用户。",
          "1) 先分析本次停机：能验证或可继续的 → dev_review_resolve（note 写明「无人值守预授权」，参见协议 §1）+ dev_review_run 继续；验证不了或需人拍板的 → 跳过（不 resolve），记入值守报告。",
          "2) 该 plan 收尾：工作树 commit 到无人值守分支，message 末尾带「遗留:」清单；跳过/blocked 的 WIP 先 park 到 unattended/<日期>-<key>，再把无人值守分支 reset 回上一个好 commit（保证下一份从干净树开工）。",
          "3) 启动队列下一项；队列全部跑完后写值守报告（.ai-dev-review/unattended-<日期>.md）并汇总，含每个 commit 的遗留项。",
        ].join("\n")
      : `[dev-review] 后台运行结束：${message}\n请把阻塞原因、需要用户决定什么转述给用户（完整决策问题与选项见 dev_review_status 或决策文件），并说明下一步。`;
    try {
      if (ctx?.isIdle?.() === false) pi.sendUserMessage(text, { deliverAs: "followUp" });
      else pi.sendUserMessage(text);
    } catch {
      try {
        pi.sendUserMessage(text, { deliverAs: "followUp" });
      } catch {}
    }
  };

  const startBackgroundRun = (args: string, ctx: any): { ok: boolean; message: string } => {
    if (backgroundRun) {
      const seconds = Math.max(0, Math.floor((Date.now() - backgroundRun.startedAt) / 1000));
      return {
        ok: false,
        message: `后台已有运行中的工作流（已运行 ${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s）：${backgroundRun.lastMessage}。用 dev_review_status 查看详情。`,
      };
    }
    if (externalRun) stopExternalWatch(ctx);
    backgroundRun = { startedAt: Date.now(), lastMessage: "启动中…", timer: null };
    const update = (message: string) => {
      if (!backgroundRun) return;
      backgroundRun.lastMessage = String(message).replace(/\s+/g, " ").trim().slice(0, 120) || "…";
      renderRunWidget(ctx);
    };
    backgroundRun.timer = setInterval(() => {
      void refreshRunWorkflow(ctx);
      renderRunWidget(ctx);
    }, 1000);
    renderRunWidget(ctx);
    void runCommand({
      args,
      cwd: ctx?.cwd || process.cwd(),
      piInvocation: currentPiInvocation(),
      notify: update,
      onStats: (stats: any) => {
        if (!backgroundRun || !stats?.line) return;
        backgroundRun.usageLine = String(stats.line);
        renderRunWidget(ctx);
      },
      onReport: async (report: WorkflowReport) => {
        try {
          pi.appendEntry<WorkflowReport>("dev-review-report", report);
        } catch {}
        update(`${report.role} r${report.round} · ${report.status}`);
      },
    })
      .then((result) => finishBackgroundRun(ctx, result))
      .catch((error) =>
        finishBackgroundRun(ctx, { ok: false, message: `dev-review 后台运行失败：${error?.message || String(error)}` }),
      );
    return {
      ok: true,
      message: "已在后台启动 dev-review（不阻塞输入）。进度见编辑器下方状态条；结束时会有总结消息。可用 dev_review_status 随时查看。",
    };
  };

  pi.on("session_shutdown", () => {
    if (backgroundRun?.timer) clearInterval(backgroundRun.timer);
    backgroundRun = null;
    if (externalRun?.timer) clearInterval(externalRun.timer);
    externalRun = null;
  });

  // Tools: let the main agent drive the formal workflow steps on the user's
  // behalf. The coordinator LLM can then translate natural-language decisions
  // ("同意，重录吧") into the protocol's resolve step without learning commands.
  pi.registerTool({
    name: "dev_review_resolve",
    label: "Dev-review resolve",
    description:
      "Record a human decision for the dev-review workflow and unblock it. " +
      "Use when the user agrees with / decides on an open escalation question. " +
      "Pass the user's decision as choice (short verdict) and note (details/instructions). " +
      "Only works while the workflow is blocked or ready.",
    parameters: Type.Object({
      choice: Type.Optional(Type.String({ description: "Short decision verdict, e.g. accept / reject / option text" })),
      note: Type.Optional(Type.String({ description: "Free-form decision details and instructions for the developer" })),
      decision_file: Type.Optional(Type.String({ description: "Path to a prepared decision document (overrides choice/note)" })),
      max_rounds: Type.Optional(Type.Number({ description: "Override max review rounds" })),
    }),
    async execute(toolCallId: any, params: any, signal: any, onUpdate: any, ctx: any) {
      const args = ["resolve"];
      if (params.decision_file) args.push(params.decision_file);
      if (params.choice) args.push("--choose", params.choice);
      if (params.note) args.push("--note", params.note);
      if (params.max_rounds) args.push("--max-rounds", String(params.max_rounds));
      const result = await runCommand({
        args,
        cwd: ctx?.cwd || process.cwd(),
        piInvocation: currentPiInvocation(),
      });
      return { content: [{ type: "text", text: result.message }], details: {} };
    },
  });

  pi.registerTool({
    name: "dev_review_status",
    label: "Dev-review status",
    description:
      "Get the current dev-review workflow state (status, phase, round, blocked reason, artifact paths). " +
      "Use before deciding how to respond to workflow questions.",
    parameters: Type.Object({}),
    async execute(toolCallId: any, params: any, signal: any, onUpdate: any, ctx: any) {
      const result = await runCommand({
        args: ["status"],
        cwd: ctx?.cwd || process.cwd(),
        piInvocation: currentPiInvocation(),
      });
      const line = await disciplineStatusLine(ctx?.cwd || process.cwd());
      const runLine = backgroundRun
        ? `[run] 托管后台运行中：${backgroundRun.lastMessage}`
        : String(result?.state?.status || "") === "running"
          ? "[run] 引擎运行中（外部启动，扩展在轮询跟踪）"
          : "[run] 无运行中的引擎";
      return { content: [{ type: "text", text: `${result.message}\n\n${line}\n${runLine}` }], details: {} };
    },
  });

  // Ghostty/iTerm2/WezTerm native desktop notification via OSC 777.
  // Ghostty only shows it when the window is NOT focused — exactly the
  // "remind me when I'm elsewhere" behavior; focused sessions stay silent.
  const desktopNotify = (title: string, body: string) => {
    try {
      process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
    } catch {}
  };

  // Feishu/Lark custom group-bot webhook push (optional). Configure in
  // ~/.pi/agent/dev-review/notify.json: {"feishuWebhook": "https://...", "feishuSecret": ""}
  let feishuCache: { webhook: string; secret: string } | null | undefined;
  const loadFeishuConfig = async () => {
    if (feishuCache !== undefined) return feishuCache;
    try {
      const raw = JSON.parse(await readFile(join(homedir(), ".pi", "agent", "dev-review", "notify.json"), "utf8")) as Record<string, unknown>;
      feishuCache = typeof raw.feishuWebhook === "string" && raw.feishuWebhook
        ? { webhook: raw.feishuWebhook, secret: typeof raw.feishuSecret === "string" ? raw.feishuSecret : "" }
        : null;
    } catch {
      feishuCache = null;
    }
    return feishuCache;
  };
  const feishuNotify = async (body: string) => {
    try {
      const cfg = await loadFeishuConfig();
      if (!cfg) return;
      const payload: Record<string, unknown> = { msg_type: "text", content: { text: `dev-review: ${body}`.slice(0, 900) } };
      if (cfg.secret) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        payload.timestamp = timestamp;
        // Feishu custom-bot signing: HMAC-SHA256(key = `${timestamp}\n${secret}`, message = ""), base64
        payload.sign = createHmac("sha256", `${timestamp}\n${cfg.secret}`).update("").digest("base64");
      }
      await fetch(cfg.webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    } catch {}
  };

  const workflowNotify = (message: string) => {
    const summary = message.replace(/\s+/g, " ").trim().slice(0, 100);
    desktopNotify("dev-review", summary || "workflow update");
    void feishuNotify(summary || "workflow update");
  };

  pi.registerTool({
    name: "dev_review_start",
    label: "Dev-review start",
    description:
      "Start a NEW dev-review workflow instance for a plan, in the background (non-blocking). " +
      "Instances are keyed by plan content hash + label: use this when no instance exists for the current plan " +
      "(first batch, or the plan file was amended so its hash changed), or when the same plan file must yield " +
      "another independent instance (pass a versioned label then). dev_review_run only resumes an existing instance. Progress widget + completion summary " +
      "are the same as dev_review_run. " +
      "IMPORTANT for multi-batch master plans: if the plan contains a current-batch marker (e.g. `当前执行批次`), " +
      "this tool first returns an advisory instead of starting. Ask the user which they want — (a) start the written " +
      "batch now as-is, or (b) settle this batch's scope/approach in conversation first (amend the plan, then start). " +
      "If the user picks (a), call again with confirm_master_plan=true.",
    parameters: Type.Object({
      plan: Type.String({ description: "Path to the plan file, e.g. docs/prd/v1.2-refactor-plan.md" }),
      test: Type.Optional(Type.String({ description: "Test command recorded in the workflow (combined string; quote inside is fine)" })),
      max_rounds: Type.Optional(Type.Number({ description: "Override max review rounds" })),
      agent_retries: Type.Optional(Type.Number({ description: "Automatic retries per agent run on transient execution failures (default from defaults.json)" })),
      protocol_retries: Type.Optional(Type.Number({
        description:
          "Automatic retries when an agent's final report cannot be parsed or validated (default 1). " +
          "The retry stays in the same session and asks for a corrected report only — the work is not redone.",
      })),
      dev_skills: Type.Optional(Type.Array(Type.String(), {
        description:
          "Skill paths injected into the developer sub-agent only (pi --skill; file or directory). " +
          "Roles otherwise run with --no-skills, so this is the only way they see a skill. " +
          "The reviewer never gets skills. Read from the plan's `## 注入技能` section when present.",
      })),
      label: Type.Optional(Type.String({
        description:
          "Only for a second independent instance from the SAME plan file (re-runs). It REPLACES the plan-derived " +
          "artifact folder name (not a prefix), so include the version — e.g. `v1.2-b2c-rerun`. Omit it by default: " +
          "the folder is named `<plan-stem>--<plan-hash>`, which already carries version + batch + topic.",
      })),
      confirm_master_plan: Type.Optional(Type.Boolean({ description: "Set true only after the user chose to start a multi-batch master plan as-is" })),
    }),
    async execute(toolCallId: any, params: any, signal: any, onUpdate: any, ctx: any) {
      const cwd = ctx?.cwd || process.cwd();
      // Preflight: a master plan (one file, several batches, some done) must not
      // silently kick off. Ask the user first; confirm_master_plan=true skips this.
      if (!params.confirm_master_plan) {
        try {
          const planPath = resolvePlanPathForCheck(cwd, String(params.plan || ""));
          const master = detectMasterPlan(await readFile(planPath, "utf8"));
          if (master) {
            const batch = master.currentBatch ? `当前标记的批次：\`${master.currentBatch}\`。` : "未找到明确的「当前执行批次」标记。";
            return {
              content: [{
                type: "text",
                text:
                  `检测到这是多批次总纲 plan（${batch}）——引擎不会拆分它，dev/reviewer 会按冻结副本里的当前批次执行。\n` +
                  "请先问用户怎么走：(a) 直接开始（按当前批次口径，立即启动），或 (b) 先把这一批的子 plan/范围/做法聊定（必要时修订 plan），再启动。\n" +
                  "用户选 (a) 时，用 confirm_master_plan=true 再调用一次本工具。",
              }],
              details: { masterPlan: master },
            };
          }
        } catch {
          // Plan unreadable here is not fatal; the engine will report it precisely.
        }
      }
      const args = ["start", params.plan];
      if (params.test) args.push("--test", JSON.stringify(String(params.test)));
      if (params.max_rounds) args.push("--max-rounds", String(params.max_rounds));
      if (params.agent_retries !== undefined) args.push("--agent-retries", String(params.agent_retries));
      if (params.protocol_retries !== undefined) args.push("--protocol-retries", String(params.protocol_retries));
      // JSON.stringify keeps paths with spaces intact through the engine's shell-like tokenizer.
      for (const skill of params.dev_skills ?? []) args.push("--dev-skill", JSON.stringify(String(skill)));
      if (params.label) args.push("--workflow", params.label);
      const started = startBackgroundRun(args.join(" "), ctx);
      return { content: [{ type: "text", text: started.message }], details: {} };
    },
  });

  pi.registerTool({
    name: "dev_review_run",
    label: "Dev-review run",
    description:
      "Start or resume the dev-review workflow loop in the background (non-blocking). Returns immediately; " +
      "progress is shown in a status widget and a summary message wakes the agent when the loop stops " +
      "(pass / blocked for human / max rounds). Use dev_review_status for details.",
    parameters: Type.Object({}),
    async execute(toolCallId: any, params: any, signal: any, onUpdate: any, ctx: any) {
      const started = startBackgroundRun("run", ctx);
      return { content: [{ type: "text", text: started.message }], details: {} };
    },
  });

  pi.registerCommand("dev-review", {
    description: "Run the isolated developer/reviewer workflow. Use /dev-review help.",
    handler: async (args: string, ctx: any) => {
      const notify = (message: string) => {
        if (!ctx.hasUI) {
          console.log(message);
          return;
        }
        try {
          ctx.ui.notify(message, "info");
        } catch {
          console.log(message);
        }
      };

      const onReport = async (report: WorkflowReport) => {
        if (!ctx.hasUI) {
          console.log(`\n=== ${reportTitle(report)} ===\n${report.markdown}`);
          return;
        }
        pi.appendEntry<WorkflowReport>("dev-review-report", report);
      };

      // The discipline escape hatch is handled locally, before the engine.
      const command = args.trim().split(/\s+/)[0] || "";
      if (command === "escape") {
        await handleEscape(args, ctx, notify);
        return;
      }

      // run / start execute in the background so the conversation is never queued.
      if (command === "run" || command === "start") {
        const started = startBackgroundRun(args, ctx);
        notify(started.message);
        return;
      }

      const result = await runCommand({
        args,
        cwd: ctx.cwd || process.cwd(),
        piInvocation: currentPiInvocation(),
        notify,
        onReport,
      });

      if (!ctx.hasUI) {
        console.log(result.message);
        return;
      }
      try {
        ctx.ui.notify(result.message, result.ok ? "info" : "error");
      } catch {
        console.log(result.message);
      }
    },
  });
}
