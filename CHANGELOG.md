# Changelog

## Unreleased — 停滞检测（stall detection）

- **机械识别停滞家族，并在命中时只做软/硬两件事**（真实事故：b2a 19 轮、7 次人工加轮；b2c 8 轮，用户以「打地鼠」记录叫停；a3e2 11 轮、max_rounds 10→12。三次都是同一种失效模式：评审发现的是「下一条可达路径」，开发者只修被点名的那条，引擎对「同一根因家族跨轮存活」没有任何感知）。
  - **数据层**：新增 `reports/findings.jsonl`（append-only，每轮 review 后追加一条 `{round, decision, verdicts, findings}`，字段与冻结 fixture 同构，fixture 可直接喂给检测器）；`state.openIssues` 每项新增派生字段 `partial_streak`（连续未闭合判定轮数）与 `rounds_open`，`issueSummary()` 一并带出，两个角色都能看到「这是第几轮尝试」。
  - **检测器**（`detectStallClusters`，纯函数、无 LLM/网络/文件系统）：对每个新 finding 与其出现时仍未闭合的旧 finding 配对，信号为 `sameFile + 2·ref + [reqSim≥0.35] + [identSim≥0.08] + 0.5·parentOpen`，`score ≥ 1.75` 连边后 union-find 得家族；`identSim` 严格只取 `evidence+required_fix` 中长度 ≥5 的 ASCII 标识符（requirement 只由 reqSim 代表，不再混入 identifier 集合）；`spec_blocked` 轮的 finding 无代码信号，既不参与连接也不参与 `partial_streak` 触发（否则会出现 hard 命中但家族表为空的升级）。soft 触发：open issue `partial_streak ≥ 2`，或活跃家族（≥2 成员、至少一人未闭合）跨度 ≥ 3 轮；hard 触发：open issue `partial_streak ≥ 3`，或家族跨度 ≥ 4 轮、未闭合成员 ≥2 且最近两轮窗口（r-1 或 r）内出现新成员（不要求两轮都有）。仅在 `decision === "fix_required"` 的轮之后评估。
  - **阈值标定**：初值来自会话回放，最终以 `tests/fixtures/stall/labels.json` 的 17 个标注 run 全绿为准（3 stalled / 6 churn / 8 healthy）；标定过程中保持 fixture 与标签零改动（不改标签、不改 fixture）。标定结论：家族跨度按「首现轮 → 当前评估轮」计算（活跃家族存活轮数）；父 finding 必须在新轮开始时仍未闭合，且 `parentOpen` 半权只在父项**熬过本轮 verdict** 时成立——本轮被 `verified_closed` 的父项不得靠同文件单信号连边。第二次标定（identSim 改为严格的 evidence+required_fix 后）：满足全部标签的参数空间是 `identSim ≤ 0.10` 且 `linkThreshold ∈ [1.6, 2.0]`；低于该空间 b2a 的 R17-001（其全部父项都在 r17 被关闭，只能靠同文件 + evidence 标识符 0.125 重叠连接）不再聚入标签家族，高于/收紧则会丢失某个 knownL2Misses 的 L3 候选覆盖。最终取 `identSim 0.08 / linkThreshold 1.75`：关键对恰好落在 0.10，1.75 又把「单弱信号 + parentOpen（1.5）」挡在门外，只放行两个弱信号或一个强信号（≥2.0）。由于不含 parentOpen 的得分恒为整数，1.75 下 parentOpen 半权在 fixture 语料上不改变任何单对判定，但它仍按公式参与评分，并在阈值为 1.5 的边界场景（回归测试使用）中决定结果。
  - **软信号只注入命中轮的任务包**：`makeDeveloperTask` 追加 `STALL_DIRECTIVE`（家族级验收判据：根因不变量 + 边界清单 + 「已修/不可达/不在本批」结论；独立常量，删除不影响路由/升级/观测）；`makeReviewerTask` 在家族热态时追加未连接候选段，要求逐条确认或分离，确认为同源时在新 finding 上用 optional 字段 `repeat_of: "<family id>"` 声明（schema 层 optional，不影响既有输出）。不命中时两个任务包与关闭检测时逐字节一致。
  - **硬升级**：新 reason `stalled-issue-family`，复用现有 escalate/blockedNotice 通道；内容为机器生成的家族表（成员、首现轮、判定链、开放数、跨度、热态文件）+ 结构化三选项：① 授权一轮钉死范围的系统性修复（人写范围）；② 登记为已知限制并顺延后续批次；③ 修订计划/口径（附家族报告）。触发时机在 review 结束、下一轮开始前；同一实例连续 hard 触发仍由人 resolve 控制，不新增冷却逻辑；最后一轮同时命中 `max-rounds` 时优先输出停滞家族报告（阻断语义不变，只是停止原因更有信息量）。
  - **配置与观测**：`defaults.json` 新增 `stallGate`（`enabled: true` 时开启，`false` 完全关闭；阈值随实例冻结，`local.json` 可覆盖）；每次 soft/hard 触发追加一行 timeline（kind、家族成员、原因、是否注入）并写 `state.stallEvents[]`：事件里的 `clusters` 是家族 key，`members` 是该次命中所有家族的完整 finding ID 列表（timeline 摘要同时展开 key 与成员），为命中率/收敛率统计与「删除决策」留数据。旧实例没有 `findings.jsonl` 时视为空历史：不触发、不报错。
  - **测试**：新增 `tests/stall-detection.test.mjs`（fixture 回放与 labels 对齐、链接信号单测、父项闭合不复活、同轮关闭父项无半权、requirement 内标识符不参与 identSim、首次变热家族的 L3 候选、spec_blocked 不触发、已闭合成员判定链、hard 两轮窗口边界、零注入逐字节一致、配置关闭零触发、`repeat_of` 固化、三个引擎端到端注入/升级/不误升级用例）；既有 53 个测试保持全绿，共 70 个。
  - `prompts/developer.md` 与 `prompts/reviewer.md` 本批零改动：补偿文本只在检测命中时出现在任务包里，不是常驻教义。

## 0.11.0 — 2026-09-16

- **子 agent 瞬时故障自动重试**（真实事故：b2a 工作流 review r2，reviewer 已跑 30 个请求/21 分钟，上游网关在最后一条消息上 `stream_read_error` 断流；pi 在 `--mode json` 下对最终 assistant 消息 `stopReason: "error"` **仍然 exit 0**，引擎只靠“没有最终文本”兜住，随后直接 block，无重试）：
  - 执行层新增重试：`invokePiAgent` 拆成外层重试循环 + `spawnPiAgentOnce` 单次进程；仅对**瞬时执行故障**重试（`stream_read_error` 等 provider 流中断、网络/超时、异常退出、无最终消息），默认 2 次（3 次尝试），指数退避 5s/10s；额度/鉴权失败、`stopReason: "aborted"`、spawn 失败不重试。协议错误（报告 JSON/schema 不合法）仍直接升级，不自动重试。
  - 重试复用同一 session id：pi 生成 provider 输入时会跳过 `stopReason: "error"/"aborted"` 的 assistant 轮次，因此重试接着出错前的 transcript 跑，不丢已完成的工作。
  - 检测修正：直接读取最终 assistant 消息的 `stopReason`/`errorMessage`（不再只靠空文本兜底）——带部分文本的断流也不会被当成报告去解析；错误对象携带 `kind`/`exitCode`/`errorMessage`/`stderr`/`partialText`，部分文本仍会落盘 `*.raw.txt`。
  - 可观测：每次重试写一条 `agent-retry` 时间线 + `[dev/review rN] ⚠️ attempt 1/3 failed: stream_read_error — retrying in 5s` 通知；最终失败的 escalation 摘要带 `(after N/M attempts)` 与真实错误码；usage 按轮次聚合所有尝试（失败尝试的 token 不再丢失）。
  - 配置：`--agent-retries <n>`（init/configure/run/resolve 可用，`0` 关闭）、`defaults.json` / `local.json` 默认值、`dev_review_start` 工具新增 `agent_retries` 参数；老实例没有该字段时回退默认 2。
  - 新增 `agent-retry` 单测 + 假 pi 端到端（流中断重试后跑通、带部分文本断流、额度失败不重试）；退避基准可用 `DEV_REVIEW_RETRY_BASE_MS` 覆盖（测试/调试）。
- **给 developer 注入技能（`--dev-skill`，不硬编码任何技能清单）**：子 agent 一直以 `--no-skills` 启动（结果不受本机 skills 目录漂移影响），需要专门指导时没有任何通道，只能改角色提示词。现在加一条显式通道，且只给 developer：
  - `--dev-skill <path>`（init/start/run/configure 可用，可重复）：目录（含 `SKILL.md`）或单个技能文件；`~` 展开，相对路径按调用时的 cwd 解析。引擎只在 developer 进程上追加 pi 的 `--skill <path>`（pi 语义：`--no-skills` 下显式 `--skill` 仍然叠加生效）；reviewer 进程永远拿不到技能——它的价值在独立性，喂指导反而污染判断。
  - 校验前置 + 冻结：init/configure 时逐条 `existsSync`（目录还必须含 `SKILL.md`），失败即终止（避免第 3 轮才发现技能根本没生效）；解析结果 canonicalize 为绝对路径写进 `state.json`，`/dev-review status` 输出 `Dev skills:` 行、timeline 初始化段落记 `Developer skills (--skill):`，随时可审计。
  - 三层来源，复用现有配置优先级：主 agent `dev_review_start({ dev_skills: [...] })`（推荐——它看过计划内容，知道这批动不动 SwiftUI）/ 用户手输 `--dev-skill` / 项目默认 `local.json` 的 `devSkills`；`defaults.json` 默认 `[]`，老实例缺该字段按空列表处理、行为不变；`configure --dev-skill`（或 `run --dev-skill`）整体替换冻结清单。
  - 计划文件里写 `## 注入技能` 一节时，主 agent 把其中路径转成 `dev_skills` 参数（引擎不解析计划——不做语义解析，只是工具描述里约定了这个交接）；技能需求因此和计划一起冻结、一起评审。
  - 新增 `dev-skills.test.mjs`（6 用例：纯函数解析/~ 展开/去重/坏路径拒绝，端到端只注入 developer 且 reviewer 无 `--skill`，含空格路径过 CLI tokenizer，缺失路径 fail fast 且不落盘，run/configure 替换与校验）。
- **产物目录命名引导修正（只改文案/工具描述，无行为变化）**：`dev_review_start` 原来的 label 描述写「use a distinct label per batch sharing the same plan file」，诱使主 agent 给每个批次编造 `b1a`/`b2b` 这类裸批次 label；而 label 是**整体替换**计划文件名派生的目录名（不是前缀），版本号因此从目录名消失（真实例子：dieMoney 的 `.ai-dev-review/b2c--da037be4` 而不是 `v1-2-b2c-settings-ia-fix-plan--da037be4`）。现在统一口径（工具描述 + `--workflow` 帮助 + README §3.1 + plan 模板）：每批一份 plan 文件时**不传 label**，默认目录名已自带版本+批次+主题；只有同一份 plan 要跑第二个独立实例时才传，且带版本（如 `v1.2-b2c-rerun`）。已存在的目录不动。
## 0.10.1 — 2026-09-13

- **无人值守批跑：停机唤醒自动注入处理指令**（`index.ts`，无引擎改动）：项目里存在 `.ai-dev-review/unattended-queue.md`（= 批次进行中）时，后台运行结束的唤醒消息不再写「请把阻塞原因转述给用户」（这句与无人值守直接冲突、会把队列卡死等用户），改为无人值守三步指令：① 先分析本次停机——能验证/可继续的 `dev_review_resolve` + `dev_review_run`，验证不了或需人拍板的跳过；② 该 plan 收尾——工作树 commit 到无人值守分支（message 带 `遗留:` 清单），跳过/blocked 的 WIP park 后 reset 回干净基础；③ 启动下一项，全部跑完写值守报告。主 agent 不再依赖上下文记忆里的协议；非无人值守场景文案不变。
- `unattended.md` 同步补充：§0 启动话术（用户只需一句）、队列文件生命周期（批次结束/中止后删除，否则下次停机误判）。

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
