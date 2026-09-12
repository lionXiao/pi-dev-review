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
  desiredDiscipline,
  isWorkflowActive,
  routeDiscipline,
  shouldBlockTool,
} from "../../dev-review/discipline-router.mjs";
import {
  clearOverride,
  findProjectRoot,
  loadDiscipline,
  readOverride,
  readWorkflowState,
  renderDiscipline,
  renderLifted,
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
    disciplineState.baselineActive = s.desired;
    disciplineState.baselineText = s.desired ? renderDiscipline(text, s.workflow) : "";
    disciplineState.appendedKey = s.desired ? `active:${version}` : "lifted";
  };

  pi.on("session_start", async (_event: any, ctx: any) => { await checkpointDiscipline(ctx); });
  pi.on("session_compact", async (_event: any, ctx: any) => { await checkpointDiscipline(ctx); });
  pi.on("session_tree", async (_event: any, ctx: any) => { await checkpointDiscipline(ctx); });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    const s = await readDisciplineContext(ctx);
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
    if (disciplineState.baselineActive && disciplineState.baselineText) {
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
    const has = (value: any): boolean =>
      typeof value === "string"
        ? value.includes(DISCIPLINE_MARKER)
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
    if (!disciplineState.baselineActive || !disciplineState.baselineText) return;
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
      return { content: [{ type: "text", text: `${result.message}\n\n${line}` }], details: {} };
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
    name: "dev_review_run",
    label: "Dev-review run",
    description:
      "Continue the dev-review workflow loop after a decision was resolved (or resume an interrupted/paused one). " +
      "Blocks until the loop stops (pass / blocked for human / max rounds). Call after dev_review_resolve succeeds.",
    parameters: Type.Object({}),
    async execute(toolCallId: any, params: any, signal: any, onUpdate: any, ctx: any) {
      const result = await runCommand({
        args: ["run"],
        cwd: ctx?.cwd || process.cwd(),
        piInvocation: currentPiInvocation(),
        // Stream live progress into the tool call UI
        notify: (message: string) => onUpdate?.({ content: [{ type: "text", text: message }] }),
        // Append per-round reports / escalations into the session transcript
        onReport: async (report: WorkflowReport) => {
          try {
            pi.appendEntry<WorkflowReport>("dev-review-report", report);
          } catch {}
        },
      });
      workflowNotify(result.message);
      return { content: [{ type: "text", text: result.message }], details: {} };
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
      if ((args.trim().split(/\s+/)[0] || "") === "escape") {
        await handleEscape(args, ctx, notify);
        return;
      }

      const result = await runCommand({
        args,
        cwd: ctx.cwd || process.cwd(),
        piInvocation: currentPiInvocation(),
        notify,
        onReport,
      });

      // Push a desktop notification for long-running commands so the user can
      // leave the window while the loop runs. Short commands stay silent.
      const command = args.trim().split(/\s+/)[0] || "";
      if (command === "run" || command === "start") {
        workflowNotify(result.message);
      }

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
