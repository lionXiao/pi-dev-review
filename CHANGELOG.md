# Changelog

## 0.10.0 — 2026-09-13

- **新增无人值守批跑协议**（`unattended.md`，纯文档 + 部署，不改引擎）：支持「睡前排好多个 plan，一夜串行跑完，早上一次汇总」的用法。协议固化了用户 2026-09-13 定的规则：blocked 先分析——能交给工作流验证的继续验证，验证不了就跳过；同一 plan 内没写完的部分同样跳过并标记；全程不中途找用户，最后一起汇总。
  - 预授权边界：技术/事实/验证类与协议类故障可代决策（note 必须写「无人值守预授权，无人工当场确认」留痕）；产品口径/范围/设计取舍一律跳过。
  - git 卫生：无人值守在 `unattended/<date>` 分支；pass 的成果提交在无人值守分支上顺序叠加，skip/blocked 的 WIP 提交到 `unattended/<date>-<key>` 停放分支后把无人值守分支 reset 回上一个好 commit，保证后续 plan 从干净、可构建的基础开工。
  - 预算熔断：每份 plan 自动 resolve ≤ 2 次；cutoff 由用户决定（可选，不写则跑到队列结束）；夜报固定三栏「已完成/未完成/阻塞点」+ 早上的收尾流程。
  - 每个无人值守 commit 的 message 末尾带 `遗留:` 清单（未完成/未整理的项），早上 `git log` 即可对照；所有 commit 只留本地分支，**不 push**，去向由用户早上决定。

## 0.9.3 — 2026-09-13

- **修复托管运行 widget 的角色行跨轮冻结**（真实事故：b1b 工作流 review r1 判 fix_required、dev 已进入 r2，widget 顶行仍显示 `dev r1 · opencode-go/deepseek-flash · thinking max`，而实时「最近」行已是 `[dev r2] …`，usage 行也是 r2 的数字）。根因：`refreshRunWorkflow` 首次读到 state 后用 `timelinePath && roleLine` 做了「已初始化」闩锁，之后每秒 tick 直接 return——role/model 行（包括 review 轮的 reviewer 模型）永远停在启动那一刻的 phase/round，review r1 期间也会错标成 dev r1。现在每 tick 重读 state，仅在内容变化时重绘；「最近」行与 usage 行行为不变（过渡瞬间 usage 行仍会短暂保留上一轮数字，直到新一轮首个请求完成）。

## 0.9.2 — 2026-09-12

- **TTFT 修正为标准客户端口径**：旧实现从子进程 `message_start`（SSE 响应头到达）起算，漏掉「请求发出 → 响应头」的建连/上传/网关排队段，系统性偏快——实测同一请求旧口径 0.69s，真实首字 1.56s（漏 56%）；b3 r6 的 19 次请求同理。现在改用 pi 在 `message_start.message.timestamp` 里盖的「发请求前」时间戳：`TTFT = 首个内容 token − 请求发出`，含连接、请求上传、网关排队与 prefill，与业界 TTFT 定义一致。
- token 行新增 `(setup X)`：请求发出 → SSE 响应头的准备段（建连/上传/排队），用于分辨「网络/网关慢」还是「模型慢」，例如 `TTFT 1.56s (setup 0.87s) · 274.2 tok/s`；`reports/usage.json` 同步新增 `setupAvgMs`。
- 无 `message.timestamp` 的 provider / 旧子进程自动回退旧口径（从响应头起算）并省略 setup 段；`tok/s` 口径不变（首 token → 结束的解码段，含 reasoning）。

## 0.9.1 — 2026-09-12

- **修复协议性停机的两个诊断 bug**（真实事故：b3 工作流 r4，dev 交卷里 `"cmd1" + "cmd2"` 非法 JSON，引擎却报成 `developer.status must be one of: done, blocked`）：
  - `extractJsonObject` 不再在「外层对象语法错」时静默降级到嵌套子对象。若选中的可解析片段被一个解析失败（或未闭合）的更大片段包着，直接抛 `Agent returned malformed JSON: … (line/col) … Near: …`，并附出错位置附近的原文；截断输出报 `unterminated JSON object`。纯 prose 夹合法 JSON 的宽松解析保持不变。
  - 协议错误 catch 块里的 `output` 作用域修复（原先 `const output` 在 try 内，catch 引用必抛 `ReferenceError` 且被空 catch 吞掉，导致设计好的 raw report/blocker 回捞从未生效）。
  - 无论能否解析，dev/reviewer 的最终原文都会落盘到 `handoffs/<role>-rNN.raw.txt` 并写进 escalation（新增「Raw agent output (verbatim)」小节），不再需要翻私有 session。
- 新增 `protocol-recovery` 单测（malformed 外层 + 嵌套合法片段、截断对象、schema 错但仍可回捞、两个 run 级端到端断言）。

## 0.9.0 — 2026-09-12

- **子 agent token 使用追踪**：引擎从子进程 `--mode json` 事件流统计每个 dev/review 轮的 token（↑input ↓output · RcacheRead / WcacheWrite · think）与性能（流式 tok/s、请求平均 TTFT）；缓存命中率公式与 pi 主状态栏一致：`cacheRead / (input + cacheRead + cacheWrite)`。
- 增量写 `reports/usage.json`（每 role+round 一条，含引擎预格式化的 `line`）；同时通过新的 `onStats` 回调实时喂给扩展。
- 展示：运行 widget 增加一行 usage（托管/外部运行都显示）；timeline 的 dev/review 行尾附 usage；`/dev-review status` 与 `dev_review_status` 输出 `Usage dev/review rN: …`。
- 已知限制（属正常现象）：provider 只在请求完成时上报 usage 的话，数字到 `message_end` 才出现；TTFT 从 pi 的 `message_start` 起算，不含建连时间；部分网关无价格表导致 `cost` 为 0，故只显示 token 不显示金额。
- 新增 usage 单测 + 假 pi 端到端测试（33 用例）。

## 0.8.0 — 2026-09-12

- **运行状态带上角色与模型**：运行中 widget 新增一行 `review r2 · bigfish / gpt-5.6-luna · thinking max`（角色 + provider/模型 + 思考强度；provider 取自 `provider/model` 配置前缀），托管运行与外部运行都有；底部状态栏带角色（`dev-review: 3m12s · dev r1` / `dev-review: running review r2`）。
- **blocked / ready 的 widget** 显示 `dev: deepseek-flash (max) · review: gpt-5.6-luna (max)` 配置行，方便判断是哪个模型/额度出的问题；`dev_review_status` 的模型行带上 thinking，并新增 `Active role` 行。
- 引擎的 `Development/Review agent: round N started` 通知带上模型与思考强度。

## 0.7.0 — 2026-09-12

- **总纲 plan 启动前置提醒**：`dev_review_start`（主 agent 工具）识别「多批次总纲 plan」（含 `当前执行批次` 标记）后**不直接启动**，而是返回建议让主 agent 问用户走哪条路——(a) 按当前批次口径直接开始（再次调用时带 `confirm_master_plan=true`），或 (b) 先把这一批的子 plan/范围/做法聊定再启动。用户手输 `/dev-review start` 不受影响（视为已拍板）。
- 引擎 `init/start` 的结果消息也附同样提示（含识别到的当前批次），CLI 同样可见；`/dev-review-plan` 提示词模板新增多批次总纲一节。
- 新增 `detectMasterPlan` 单测（30 用例）。

## 0.6.1 — 2026-09-12

- **`start`/`init` 的 plan 路径兜底**：cwd 相对路径找不到、但同一路径相对仓库根存在时，自动按仓库根解析并在结果里注明；错误信息同时列出两个解析结果。真实事故：会话 cwd 是 `<repo>/docs/prd`，却传了仓库根相对路径 `docs/prd/v1.2-refactor-plan.md`，拼成双层目录直接失败（批 3 启动失败但主 agent 会误汇报成旧实例）。
- 新增 `resolvePlanSource` 单测（29 用例）。

## 0.6.0 — 2026-09-12

- **统一时间线日志 `reports/timeline.md`**：每个工作流实例一份追加式时间线，按顺序记录「plan 冻结 → dev r1 → review r1 → 人工决策/升级 → dev r2 → … → pass/blocked」，每行含时间戳、轮次、事件、结果、摘要与产物相对路径；中断/续跑不清空。
- **时间戳改本机时区**：timeline / handoff / escalation / final report / 决策文档的时间戳都按本机时区显示（timeline 头部标注时区，如 `Asia/Shanghai (UTC+08:00)`）；`state.json` 等机器状态仍保持 ISO/UTC，便于比较与恢复。
- **子 agent 失败原因分类**：模型额度/限流、鉴权、网络、超时会被识别并在错误里标注 `[likely model quota/rate limit（额度或限流）]` 之类的前缀（原始 stderr 尾部仍保留），不再和协议错误长得一样；分类会随 escalation、blocked 唤醒消息、时间线一起呈现。
- **时间线路径处处可见**：`/dev-review status` 与 `dev_review_status` 输出 `Timeline:` 行；底部/编辑器下方 widget 在 running/blocked/ready 时显示相对路径；停止唤醒消息也带时间线路径。
- 新增 `timelineLine` / `timelineFilePath` / `localNow` / `classifyAgentFailure` 单测 + status 输出集成测试（28 用例）。

## 0.5.1 — 2026-09-12

- 文档修正：`/reload` 只能刷新扩展入口 `index.ts`；它 import 的本地 `.mjs` 模块被 Node ESM 缓存冻结在进程启动版本，改完这些模块必须**完全重启 pi**（known-issues 已重写，含报错样例 `(0, _disciplineRuntime.loadPolicy) is not a function`）。

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
