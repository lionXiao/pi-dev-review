import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { createHmac } from "node:crypto";
import { Type } from "typebox";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { runCommand } from "../../dev-review/workflow.mjs";
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
    syncRunStatus(ctx, s.workflow);
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
    if (route.action === "append") {
      const content = route.kind === "active"
        ? renderDiscipline(text, s.workflow)
        : route.kind === "suspended"
          ? renderSuspended(s.override)
          : renderLifted();
      out.message = { customType: "dev-review-discipline", content, display: false };
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
  let backgroundRun: { startedAt: number; lastMessage: string; timer: ReturnType<typeof setInterval> | null } | null = null;
  let externalRun: { timer: ReturnType<typeof setInterval>; startedAt: number } | null = null;

  const agoLabel = (iso: string | undefined) => {
    const at = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(at)) return "未知";
    const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
    return seconds < 60 ? `${seconds}s 前` : `${Math.floor(seconds / 60)}m 前`;
  };

  const summarizeRunStatus = (message: string) => {
    const text = String(message || "");
    if (/passed|pass(ed)? after/i.test(text)) return "passed";
    if (/human decision|blocked/i.test(text)) return "blocked";
    if (/max rounds/i.test(text)) return "max-rounds";
    return "stopped";
  };

  const renderRunWidget = (ctx: any) => {
    try {
      if (!backgroundRun) {
        ctx?.ui?.setWidget?.(RUN_WIDGET_KEY, undefined);
        return;
      }
      const seconds = Math.max(0, Math.floor((Date.now() - backgroundRun.startedAt) / 1000));
      const clock = `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
      ctx?.ui?.setWidget?.(
        RUN_WIDGET_KEY,
        [
          `dev-review ▶ 运行中 ${clock}`,
          backgroundRun.lastMessage || "启动中…",
          "输入不会被阻塞 · 详情用 dev_review_status",
        ],
        { placement: "belowEditor" },
      );
      ctx?.ui?.setStatus?.(RUN_STATUS_KEY, `dev-review: ${clock}`);
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

  const renderExternalWidget = (ctx: any, workflow: any) => {
    try {
      const round = `${workflow?.currentRound ?? "?"}/${workflow?.maxRounds ?? "?"}`;
      ctx?.ui?.setWidget?.(
        RUN_WIDGET_KEY,
        [
          `dev-review ▶ 运行中 · r${round}（外部启动）`,
          `最近引擎更新：${agoLabel(workflow?.updatedAt)}`,
          "输入不会被阻塞 · 详情用 dev_review_status",
        ],
        { placement: "belowEditor" },
      );
      ctx?.ui?.setStatus?.(RUN_STATUS_KEY, `dev-review: running r${round}`);
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
        renderExternalWidget(ctx, fresh);
        return;
      }
      const label = !fresh.found
        ? "stopped"
        : String(fresh.status) === "blocked"
          ? `blocked${fresh.openIssue ? ` (${fresh.openIssue.id})` : ""}`
          : String(fresh.status);
      stopExternalWatch(ctx);
      try {
        ctx?.ui?.setStatus?.(RUN_STATUS_KEY, `dev-review: ${label}`);
      } catch {}
      workflowNotify(`dev-review 引擎已停止：${label}`);
      try {
        pi.sendUserMessage(
          `[dev-review] 后台引擎已停止（外部启动，轮询检测）：${label}。请用 dev_review_status 查看详情并向用户汇报。`,
          { deliverAs: "followUp" },
        );
      } catch {}
    };
    externalRun = { timer: setInterval(() => void tick(), EXTERNAL_POLL_MS), startedAt: Date.now() };
    void tick();
  };

  // Called on every turn: the footer/widget always reflect the real state on
  // disk, whoever started the run. Managed runs keep their own widget.
  const syncRunStatus = (ctx: any, workflow: any) => {
    if (backgroundRun) return;
    const status = workflow?.found ? String(workflow.status || "") : "";
    if (status === "running") {
      ensureExternalWatch(ctx, workflow);
      renderExternalWidget(ctx, workflow);
      return;
    }
    if (externalRun) stopExternalWatch(ctx);
    try {
      const label =
        status === "blocked"
          ? `blocked${workflow.openIssue ? ` (${workflow.openIssue.id})` : ""}`
          : status === "passed" || status === "ready" || status === "abandoned"
            ? status
            : undefined;
      ctx?.ui?.setStatus?.(RUN_STATUS_KEY, label ? `dev-review: ${label}` : undefined);
    } catch {}
    try {
      ctx?.ui?.setWidget?.(RUN_WIDGET_KEY, undefined);
    } catch {}
  };

  const finishBackgroundRun = (ctx: any, result: { ok?: boolean; message?: string }) => {
    const message = result?.message || "dev-review 运行结束（无消息）";
    if (backgroundRun?.timer) clearInterval(backgroundRun.timer);
    backgroundRun = null;
    renderRunWidget(ctx);
    try {
      ctx?.ui?.setStatus?.(RUN_STATUS_KEY, `dev-review: ${summarizeRunStatus(message)}`);
    } catch {}
    workflowNotify(message);
    const text = `[dev-review] 后台运行结束：${message}\n请用 dev_review_status 查看详情，并向用户汇报下一步（若是 blocked，说明需要用户决定什么）。`;
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
    backgroundRun.timer = setInterval(() => renderRunWidget(ctx), 1000);
    renderRunWidget(ctx);
    void runCommand({
      args,
      cwd: ctx?.cwd || process.cwd(),
      piInvocation: currentPiInvocation(),
      notify: update,
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
      "(first batch, or the plan file was amended so its hash changed), or when you need a separate instance per " +
      "batch via label. dev_review_run only resumes an existing instance. Progress widget + completion summary " +
      "are the same as dev_review_run.",
    parameters: Type.Object({
      plan: Type.String({ description: "Path to the plan file, e.g. docs/prd/v1.2-refactor-plan.md" }),
      test: Type.Optional(Type.String({ description: "Test command recorded in the workflow (combined string; quote inside is fine)" })),
      max_rounds: Type.Optional(Type.Number({ description: "Override max review rounds" })),
      label: Type.Optional(Type.String({ description: "Workflow label; use a distinct label per batch sharing the same plan file" })),
    }),
    async execute(toolCallId: any, params: any, signal: any, onUpdate: any, ctx: any) {
      const args = ["start", params.plan];
      if (params.test) args.push("--test", JSON.stringify(String(params.test)));
      if (params.max_rounds) args.push("--max-rounds", String(params.max_rounds));
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
