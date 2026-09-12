# Changelog

## 0.5.0 — 2026-09-12

- **blocked 不再只说 "blocked"**：引擎的停止返回值（`run` / `start` / 后台唤醒消息 / CLI）统一携带阻塞详情 —— reason 代码、摘要、决策问题与选项（`blockedNotice`）。主 agent 被唤醒时即可向用户解释为什么停、要决定什么，不用再先跑一轮 `dev_review_status`。
- **事后补报**：运行在扩展观察窗口之外结束（bash/CLI 拉起、或 block 发生在 reload 之前）时，下一个回合 `syncRunStatus` 会补发一次停止原因（每会话每状态一次），不再只把状态栏画成 `blocked`。
- **状态可读性**：底部状态栏显示 `blocked (reason)`；`/dev-review status` / `dev_review_status` 在 blocked 时输出原因、摘要与决策问题/选项；外部轮询的停止唤醒消息同样带原因与决策问题。
- **修复 policy 标记重复**：`policy.md` 文件自带一份 `<!-- dev-review-policy -->`，与 `renderPolicy` 添加的标记重复，system prompt 中出现两次；现只由渲染函数添加（单测锁定）。
- 新增 `blockedNotice` 单测与 `readWorkflowState.blocked.questions` 覆盖。

## 0.4.0 — 2026-09-12

- **通用工作协议（始终注入）**：新增 `policy.md`（改动分级 / 提问线 / 不拿流程当挡箭牌），由扩展在任何项目、任何状态注入；工作流纪律仍只在活跃期注入。项目 `CLAUDE.md` 从此**零配置**（可直接清空旧的纪律段落）。
  - 基线组合 = policy + (活跃时) discipline；policy 恒定不变，缓存行为不变；系统提示词仅在 checkpoint 时刻变化；
  - `before_provider_request` 补写改为按两个标记（policy / discipline）判重；
  - `local.json` 新增 `injectWorkingAgreement`（默认 true）开关；
  - `discipline.md` 移除重复的提问线/态度段；新增 policy 相关单测。

## 0.3.2 — 2026-09-12

- `discipline.md` 吸收两条原先只写在项目 CLAUDE.md 里的通用规则：实现细节讨论引导（dev 私有 session + resolve note 带回结论）、工作树非工作流变更的归因纪律；解除纪律后的改动也明确要求留痕「未经工作流评审」。项目 CLAUDE.md 可据此只保留降级兜底 + 项目级改动分级。

## 0.3.1 — 2026-09-12

- **`run` 不再静默无操作**：当活跃实例已 `passed` 且计划文件自冻结后已改变时（典型场景：下一批次修订了计划，应新建实例），`run` 现在会报错并给出 action：`plan changed (oldhash -> newhash): run start ...`。之前它返回 ok:true 的友好提示，容易被误认为启动成功（真实事故：批 2 改计划后主 agent 调 run 未生效，只能绕 bash）。新增导出 `planChangedSinceFrozen` + 单测。

## 0.3.0 — 2026-09-12

- **状态显示不再受启动方式影响**：新增每轮状态同步，底部状态栏/进度条始终反映磁盘上的真实工作流状态（running rN / blocked(issue) / passed / ready）。
- **外部启动的运行可见可控**：CLI/bash 直接拉起（或上个会话遗留）的运行会被轮询跟踪（默认 10s，`DEV_REVIEW_POLL_MS` 可调）：进度条标注「外部启动」，停止时同样唤醒主 agent。修复了「状态栏停留在旧的 passed」问题。
- **新增 `dev_review_start` 工具**：后台新建工作流实例（plan / test / max_rounds / label），解决多批次场景下 plan 哈希变化、旧实例已 passed 时 `run` 无法启动的问题；`dev_review_run` 只续跑已有实例，两者都走后台上进。

## 0.2.0 — 2026-09-12

- **后台运行**：`dev_review_run` 工具与 `/dev-review run|start` 不再阻塞主 agent 回合——引擎在进程内后台执行，编辑器下方显示每秒更新的进度条（运行时长 + 最近引擎事件），底部状态栏同步；停止时自动注入总结消息唤醒主 agent（pass / blocked / max-rounds / 失败）。
- 同一时间只允许一个后台运行；`dev_review_status` 输出增加 `[run]` 行；`session_shutdown` 清理监控定时器。
- 待办：引擎暂无 abort 接口，不支持中途取消（README §3.4 / known-issues 已注明）。

## 0.1.0 — 2026-09-12

首个版本，包含：

- **协调者引擎（workflow.mjs）**：冻结计划（快照 + sha256）→ developer 实现 → reviewer 独立评审 → pass/blocked 循环；base commit 归因、轮次预算、协议 JSON 校验、escalation 决策文件、`unlock` 审计。
- **双模型角色隔离**：developer 全工具 + 私有 session 跨轮复用（默认每 4 轮轮换）；reviewer 只读工具 + 每轮全新 session。
- **主 agent 纪律自动注入**（本次新增）：
  - 单一来源 `discipline.md`，按内容 hash 作为版本号；
  - `discipline-router.mjs` 纯函数路由：`checkpoint`（`session_start` / `session_compact` / `session_tree`，缓存重建时刻写 system prompt 基线）与 `append`（其余状态变化只追加尾部通知，零额外缓存失效）；
  - `before_provider_request` 在运行中途自动压缩时按标记补写基线，绝不逐轮开关；
  - `tool_call` 硬拦截：纪律生效期间拒绝主 agent 的 `edit` / `write`（机械执行，不依赖模型遵守）；
  - 逃离机制：`/dev-review escape --note "原因" [--minutes N | --forever]`、`escape off`、`escape status`；挂起与恢复写入 `.ai-dev-review/discipline-audit.jsonl`；工作流 pass/终止后自动解除。
- **测试**：`discipline-router`（11 用例）+ `discipline-runtime`（4 用例），`node --test` 可跑；CI 见 `.github/workflows/ci.yml`。
- **安装**：`install.sh` 复制式安装（版本化文件之外不触碰 `local.json` / `notify.json`，覆盖前自动备份到 `~/.pi/agent/.backups/`）。

设计决策见 [docs/adr/0001-discipline-injection.md](docs/adr/0001-discipline-injection.md)。
