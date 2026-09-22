# pi-dev-review

[![CI](https://github.com/lionXiao/pi-dev-review/actions/workflows/ci.yml/badge.svg)](https://github.com/lionXiao/pi-dev-review/actions/workflows/ci.yml)

一个人工审签、双 Agent 自动执行的**开发-评审工作流**（Pi 扩展）：冻结计划 → developer 实现 → reviewer 独立评审 → pass/blocked 循环。主 agent 是秘书不是施工队，决策权永远在人手里。

> 定位：**verification-first** —— 本地优先、可审计、人做最终决定。市场卖「放手」，这里卖「敢放手的前提」。

> README 内的命令与产物示例均为脱敏虚构项目（`shop-service` 电商后端，通用 Node 测试命令）。例外：`agent/dev-review/tests/fixtures/stall/` 下的回归语料来自真实运行，按 `tools/stall-fixture-map.json` 的映射做了**重命名式假名化**（只替换路径与项目名；行为文本保留，否则相似度结构就不成立），映射表本身保留了源项目名。

## 0. 与近邻的差异

| 近邻 | 它是什么 | 本项目的差异 |
| --- | --- | --- |
| [github/spec-kit](https://github.com/github/spec-kit) | 规格驱动开发工具包 | 不做规格工件格式，只做「冻结计划 → 实现 → 独立评审」的执行循环 |
| [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) | 多角色敏捷方法论（文档集） | 可执行的引擎 + 状态机 + 人工决策协议，不是方法论 |
| Ralph 系循环（ralph-claude-code 等） | 让 agent 反复跑到通过 | 有角色分离、冻结计划归因、人工决策门与审计，不是无脑循环 |
| Pi 自带 subagent 示例 | worker → reviewer → worker 链 | 多了轮次预算、协议校验、决策留痕、主 agent 纪律自动注入 |

适用：本地仓库、个人或小团队、对可复现/可审计有要求、愿意为验收付出人工成本。
不适用：把验收交给模型自己拍板的完全自动。

夜间串行批跑（`unattended.md`）是例外而不是反例：它要求人**事前一次性授权**、blocked 先自判（能交给工作流验证的继续验证，验证不了就跳过并标记）、成果提交到 `unattended/<date>` 分支并留「遗留:」清单、早上一次性汇总复核。放手由人授权、可回滚、可审计——这与「让 Agent 自己决定验收」是两件事。

## 1. 架构与原理

```text
你（人）─────────────"说人话/敲命令"─────────────┐
                                                │
主 agent（pi 会话的 LLM，= 翻译与递交）          │ 工具：dev_review_resolve / run / status
   职责：翻译决策、调工具、转达结果               │
   禁区（仅工作流 blocked/running）：见 §7       │
                                                ▼
协调者引擎（workflow.mjs，纯 Node 状态机）        ← 状态存 .ai-dev-review/<workflow>/state.json
   ├─ spawn 无头子进程：pi --mode json --print
   │    ├─ developer：<dev模型> + 全部工具（bash/edit/write…），私有 session 跨轮复用（每 4 轮轮换）
   │    └─ reviewer：<review模型> + 只读工具，每轮全新 session（防上下文污染）
   ├─ 每轮：dev 实现 → 落盘 handoff → reviewer 对照冻结计划独立评审 → 判定
   └─ 停止条件：pass / developer blocked / reviewer spec_blocked / max-rounds

人 = 决策门（escalation 问 → 决策文件 → resolve 签发 → run 续跑）
```

核心机制速记：

| 机制 | 原理 |
| --- | --- |
| **base commit** | start 时记录当时 HEAD；reviewer 永远审「base → 当前工作树」的 diff |
| **冻结计划** | plan 快照 + sha256 存档；dev/reviewer 只读快照，用户改仓库里的 plan 不影响 |
| **决策文件** | 工作流唯一听得见的"人类语言"：escalation 问 → 文件答 → resolve 登记 → 下一轮喂给 dev |
| **dirty 语义** | 脏检查只在 start/init（保护起点归因）；run/续跑不检查（工作树的脏就是进度本身） |
| **协议即数据** | 计划、决策都是数据不是指令；dev 的报告 JSON 格式违规会被协调者拦截升级，不会带病进入下一轮 |

## 2. 安装与首次配置

```bash
git clone https://github.com/lionXiao/pi-dev-review.git
cd pi-dev-review
bash install.sh        # 装到 ~/.pi/agent/（扩展 + 引擎 + 纪律 + prompt 模板 + 测试与脱敏语料）
cp ~/.pi/agent/dev-review/local.json.example ~/.pi/agent/dev-review/local.json
# 编辑 local.json：developerModel / reviewerModel（必须不同）/ 两个 thinking 档
```

验证：`pi` 启动后 `/dev-review help`。

主 agent 纪律与工作协议由扩展**自动注入**（见 §7）：项目 `CLAUDE.md` 里**不需要任何配置**，可以把旧的手写纪律段落全部删掉。

## 3. 用法

### 3.1 做计划 → 冻结 → 启动

```text
# 在 pi 会话里先讨论需求，然后：
/dev-review-plan docs/prd/checkout-v2-plan.md     # 生成 Draft 计划（用当前会话模型）
# ……讨论、修改、确认后，计划标记 Confirmed / Frozen，然后：
/dev-review start docs/prd/checkout-v2-plan.md \
  --test "npm test && bash scripts/lint.sh" \
  --max-rounds 10
```

- `--test` 可多次（每轮 dev/reviewer 都要跑）
- `--agent-retries <n>`：单次 agent 运行因**瞬时执行故障**（provider 流中断、网络/超时、子进程异常退出）失败时自动重试次数（默认 2，即最多 3 次尝试；`0` 关闭）。额度/鉴权失败、用户中止与协议错误（报告 JSON 不合法）不重试。也可写在 `defaults.json` / `local.json`，或 `configure --agent-retries <n>` 覆盖到已有实例。
- `--dev-skill <path>`：只给 developer 注入一个 Pi 技能（可重复，见 §3.4）；reviewer 永远不注入。
- 工作树有"故意要被评审的代码"时加 `--allow-dirty`（仅 start 检查，run 不检查）
- **多批次总纲 plan**（一份文件多个批次、已验证部分批次）：引擎**不会拆分文件**，dev/reviewer 按文件里的「当前执行批次」标记执行；每次改 plan 内容 → 新 hash → 新实例。主 agent 用 `dev_review_start` 启动这类 plan 时会先返回提醒，让你选 (a) 按当前批次口径直接开始（`confirm_master_plan=true`），还是 (b) 先把这一批的子 plan/范围/做法聊定再启动；你手输 `/dev-review start` 则视为已拍板、直接开始。
- **产物目录命名（每批一个 plan 文件时不要传 label）**：默认目录名 = `<plan 文件名去扩展名>--<plan 内容 hash 前8位>`，例如 `v1-2-b2c-settings-ia-fix-plan--da037be4`——版本、批次、主题、计划版本一眼可辨（改过 plan 内容会得到新 hash 新目录）。`--workflow <label>` 是**整体替换**这个名字而不是前缀：传 `b2c` 只会得到 `b2c--da037be4`，版本号就没了。所以只有「同一份 plan 要跑出第二个独立实例」（重跑/对照实验）才传 label，并且带上版本，如 `v1.2-b2c-rerun`。
- 模型可写在 `local.json`，start 时不用传；也可在命令行传 `--developer-model` / `--reviewer-model`（两者必填其一来源）
- 其余选项（`--developer-thinking` / `--reviewer-thinking`、`--developer-reset-after <n>`、`--artifact-dir <dir>` 等）见 `/dev-review help`；本文只列常用项

### 3.2 blocked 时的三种回应方式（任选，效果等价）

**方式 A：主 agent 代办（推荐，说人话即可）**

```text
（⚠ Escalation 条目出现）
你："同意了，就按方案 ② 重录基线，PRD 口径同步改"
主 agent → 调用 dev_review_resolve（自动整理 choice/note）
        → 调用 dev_review_run（循环恢复）
你：全程说完一句话就完事
```

**方式 B：行内一行命令（不依赖任何 agent）**

```text
/dev-review resolve --choose "按方案②执行" --note "接受行为差异，重录受影响基线，PRD 口径同步修订"
/dev-review run
```

**方式 C：写决策文件（决策复杂/要留长篇依据时）**

```markdown
# 决策（shop-service checkout v2）
选择：方案②。
理由：X；对 developer 的指示：1) … 2) …
```

```text
/dev-review resolve docs/decisions/checkout-decision-1.md
/dev-review run
```

决策文件要点：**选了什么 + 要 developer 干什么**，文采不重要。想反问也可以写在里面（"先回答 X 再继续"），dev 下一轮会先回答。

### 3.3 后台运行（不阻塞对话）

`run` / `start` 不阻塞主 agent 的回合：引擎在后台继续跑，编辑器下方有一条实时更新的进度条（运行时长 · 最近引擎事件 · 轮次），底部状态栏同步显示。你可以随时继续聊天，主 agent 也能正常回复。机器停止时（pass / blocked / max-rounds）会有一条总结消息自动唤醒主 agent，消息里直接带着停止原因：reason 代码、摘要、决策问题与选项（不是只有一句 "blocked"）。

- 进度条：`dev-review ▶ 运行中 3m12s` + 当前角色与模型行（如 `review r2 · bigfish / gpt-5.6-luna · thinking max`）+ token 使用行（`tokens ↑11.3k ↓4.8k · R246.1k (CH 99.6%) · 61.2 tok/s · TTFT 1.83s (setup 0.42s) · think 2.6k`）+ 最近一条引擎事件 + 时间线路径，每秒更新；底部状态栏同步显示角色；
- token 统计：引擎按 role+round 写 `reports/usage.json`，`/dev-review status` / `dev_review_status` 输出 `Usage dev/review rN:` 行，timeline 的 dev/review 行尾也附同一摘要。口径：命中率公式与 pi 主状态栏一致（`cacheRead / (input + cacheRead + cacheWrite)`）；**TTFT = 子进程发出 provider 请求 → 首个内容 token**（标准客户端首字口径，含建连、请求上传、网关排队，不含 pi 启动），括号内 `setup` 是其中「请求发出 → SSE 响应头」的准备段；`tok/s` 用业界文档化的 throughput 口径：**输出 token（含 reasoning）÷ 请求发出 → 消息结束**（OpenRouter `generation_time` 的定义：「from dispatching the upstream request until its response body ended. Divide the completion token count by this for throughput.」），包含 TTFT、不含工具执行与协调时间；TTFT 单独列出，所以也能反推 Artificial Analysis 的 Output Speed（首 token 起算的解码速度），行尾的 `req` 数是该值合并了多少个请求；
- **外部启动也能识别**：如果是用 CLI/bash 直接拉起引擎（或上一个 pi 会话遗留的运行），扩展会按轮询跟踪：进度条标注「外部启动」，停止时同样会唤醒主 agent；底部状态栏始终反映磁盘上的真实状态（running rN/blocked(reason)/passed），不依赖谁启动的；
- **事后补报**：如果运行在扩展观察窗口之外结束（bash 拉起未走扩展、或 block 发生在 reload 之前），下一个回合会自动补报一次停止原因，状态栏与 `dev_review_status` 都带 `blocked (reason)`；
- **瞬时故障自动重试**：子 agent 因 provider 流中断（如 `stream_read_error`）、网络/超时、异常退出而未产出最终报告时，引擎按 `--agent-retries`（默认 2）自动重跑该轮（复用同一 session；pi 会把出错的那次 assistant 轮次从 provider 输入里剔掉，再接着跑），每次重试写一条 `agent-retry` 时间线；重试仍失败才升级为 `*-protocol-or-execution-error`，摘要里带尝试次数与真实错误码。额度/鉴权失败、用户中止、报告 JSON 协议错误一律不重试（重试也治不好，直接叫人）。
- **统一时间线 = 全过程日志**：每个实例的 `reports/timeline.md` 同时是里程碑表和 dev/review 的完整过程日志——「plan 冻结 → dev rN → review rN → 决策/升级 → pass」每个事件一行（时间戳 + 轮次 + 结果 + 摘要 + 产物路径）；事件之间按顺序追加该阶段的 assistant 正文、thinking 标记、工具调用（名称 + 参数一行）与工具结果，阶段头为 `## dev r1 · <model> · <时间>`，所以可直接当 dev+review 拼接日志读，也可以 `tail -f` 边跑边看；工具结果超过 8k 字符时保留头 5k + 尾 3k 并标注省略字符数，thinking 默认只留一行 `🧠 thinking · N tok`（不内联全文，控制体积），逐字原文都在 `private/` 的 session JSONL；`DEV_REVIEW_TRANSCRIPT=full` 内联 thinking 全文，`DEV_REVIEW_TRANSCRIPT=0` 退回只记里程碑。running/blocked/ready 时编辑器下方 widget 显示相对路径，`dev_review_status` 输出 `Timeline:` 行；
- 随时查询：`dev_review_status` 工具或 `/dev-review status`，blocked 时输出原因、摘要与决策问题/选项，另带 `[run]` 行；
- 同一时间只允许一个后台运行，重复启动会被拒绝；
- 新建实例用 `dev_review_start`（工具，plan 哈希变化/新批次必需；可用 `dev_skills` 注入 developer 技能，见 §3.4）；`dev_review_run` 只续跑已有实例，两者都走后台上进；
- 目前不提供中途取消（引擎无 abort 接口）：要停只能等到停止条件，或 `/dev-review escape` 挂起纪律后手动处理。

### 3.4 developer 技能注入（`--dev-skill`）

子 agent 默认带 `--no-skills` 启动（不发现本机技能，结果不受机器上装了什么影响）。需要专门指导时，由**调用方显式注入**，且只给 developer：

```text
# 可重复
/dev-review start docs/prd/plan.md \
  --dev-skill ~/.pi/agent/skills/xcode/swiftui-specialist \
  --dev-skill /path/to/skill-dir
```

- **只影响 developer**：reviewer 永远拿不到技能——它的价值在独立性，喂指导反而污染判断。
- 路径可以是技能目录（含 `SKILL.md`）或单个技能文件；`~` 会展开，相对路径按命令执行目录解析。init/run/configure 时逐条校验并**冻结为绝对路径**写进 `state.json`，`status` 与 timeline 里可见；路径写错、目录缺 `SKILL.md`、或技能 frontmatter 没有可用的 `description`（pi 会静默忽略这种技能）都会立即失败，不会等到第 3 轮才发现。
- 技能清单**冻结在实例上**：已启动的实例后来改了 `local.json` 也不会变（要改用 `configure --dev-skill <path>` 或 `run --dev-skill <path>`，会整体替换）。
- 三种调用方式各有分工：主 agent 用 `dev_review_start({ dev_skills: [...] })`（推荐，它看过计划内容）；用户手输用 `--dev-skill`；项目级默认写 `local.json` 的 `devSkills`。计划文件里若有 `## 注入技能` 一节，主 agent 应把其中路径转成 `dev_skills` 参数，让技能需求和计划一起冻结、一起评审。

### 3.5 日常命令

```text
/dev-review status     # 状态（blocked 时把 escalation 摘要也展示）
/dev-review list       # 多工作流列表
/dev-review use <id>   # 切换活动工作流
/dev-review adopt      # 换机/换 checkout 后接管（.ai-dev-review/ 拷过去之后）
/dev-review configure  # 改模型/轮数/测试命令
```

### 3.6 停滞检测（stall detection）

评审反复发现「下一条可达路径」、开发者只修被点名的那条——同一根因的 finding 家族跨轮存活时，引擎原来毫无感知（真实事故：19 轮 / 11 轮 / max_rounds 被打满）。停滞检测把这件事变成机械信号，命中时只做两件事。

- **判定是纯代码**：`detectStallClusters` 只做计数与字符串比对（同文件、`ref` 显式引用、需求 bigram 相似度、`evidence`/`required_fix` 里的标识符重合、父项是否仍未闭合），union-find 聚成家族。它只声明「这些 finding 与仍未闭合的东西关联紧密」，**不宣布同根因**——语义确认在 reviewer，范围决策在人。
- **阈值**（`defaults.json` 的 `stallGate`，随实例冻结在 `state.config`，`local.json` 可覆盖；默认开启）：`linkThreshold 1.75`、`reqSim 0.35`、`identSim 0.08`、`softStreak 2`、`softSpan 3`、`hardStreak 3`、`hardSpan 4`。标定以 `tests/fixtures/stall/labels.json` 的 17 个标注 run 全绿为准（3 stalled / 6 churn / 8 healthy），**改阈值要新实例**；`enabled:false` 关闭判定层。
- **soft 命中**：下一轮 dev 任务包末尾注入家族级验收判据（列出家庭成员、首现轮、最近判定、是否闭合，要求给出根因不变量、逐一列出会违反它的边界，并对每条给出「已修 / 不可达 / 不在本批」的结论与证据）；reviewer 侧另给「未连接候选确认」，要求逐条确认或分离，确认为同源时在新 finding 上写 optional 字段 `repeat_of: "<family id>"`。**不命中则任务包逐字节不变**。
- **hard 命中**：把实例 block 在 reason `stalled-issue-family`，决策文件里带机器生成的家族表（成员、首现轮、判定链、开放数、跨度、热态文件）与三个结构化选项（① 授权一轮钉死范围的系统性修复；② 登记为已知限制并顺延后续批次；③ 修订计划/口径）。不新增冷却逻辑：连续 hard 由人 resolve 控制。
- **观测与数据**：每轮 review 追加 `reports/findings.jsonl`（append-only，数据层独立于判定层——`enabled:false` 时仍记录，方便以后打开或离线分析）；每次 soft/hard 触发追加一行 timeline（`stall-soft` / `stall-hard`，含家族、成员、原因、是否注入）并写 `state.stallEvents[]`。旧实例没有 `findings.jsonl` 时按空历史处理（不触发、不报错）。
- 两段注入文本是**英文指令**（与角色提示词同一惯例：指令用英文，人类可读内容跟随冻结 plan 语言）；家族表里的 requirement 文本不翻译，给人看的硬升级报告仍是中文。

## 4. 断点恢复

| 停的方式 | 恢复动作 |
| --- | --- |
| 轮间正常停（ready） | `/dev-review run` |
| blocked（含会话断开后的重启） | `/dev-review run` 会**把 escalation 全文重新推回 TUI**，看完直接（说人话/resolve）→ run |
| 跑到一半被杀（state 卡 running） | `/dev-review unlock --note "原因"`（正式命令，留审计）→ `/dev-review run`；若当前轮 dev 报告已完整落盘，**自动续跑 review，不烧 dev 轮** |
| 早期版本无 unlock 命令 | 手改 state.json：status→ready（phase 不用改），效果等价 |
| 换机器/换 worktree | 拷贝 `.ai-dev-review/` 目录 → `/dev-review adopt` |

dev 有跨轮私有 session（`private/developer-sessions/`），重启不丢记忆；reviewer 每轮独立。

## 5. 可见性（三层）

1. **TUI 实时流**：子 Agent 每个工具调用/助手消息/失败以事件形式推到主 TUI（dev/reviewer r{N} 前缀）。设 `DEV_REVIEW_STREAM=0` 关闭。
2. **每轮条目**：`◆ Development` / `◇ Review` / `⚠ Escalation` markdown 条目追加进会话流（Ctrl+O 展开，含完整 handoff）。
3. **磁盘全量**：`reports/timeline.md`（里程碑 + 两边完整过程的可读日志，见 §3.3）、`handoffs/`（每轮 JSON+MD）、`reports/final-report.md`（最终报告）、`private/*-sessions/*.jsonl`（逐字原文，可用 `pi --session-dir ... -r` 交互回看）。
4. **后台运行进度条**：`run` / `start` 后台执行时，编辑器下方显示实时进度（运行时长 + 最近引擎事件），主 agent 回合不被占用；停止时注入总结消息（含 reason / 摘要 / 决策问题与选项）。CLI/bash 直接拉起的「外部启动」由轮询跟踪，同样有进度与停止唤醒；在观察窗口之外结束的运行会在下一回合补报一次原因。

## 6. 版本 v2 相对原包的改进清单

1. **reviewer 也落 session**（每轮独立，过程可审计，隔离设计不变）
2. **实时事件流**进主 TUI（`DEV_REVIEW_STREAM=0` 可关）
3. **escalation 断点重推**：重启后 `/dev-review run` 会重新展示 blocked 原因（不再只报错拒绝）
4. **协议错误内容增强**：dev 报告 JSON 解析失败时，原始报告随 escalation 留存并结构化渲染（"Questions for you" 直接标题化，blockers 即使格式违规也可读）
5. **行内决策**：`resolve --choose/--note`，引擎自动生成决策文档（零 agent 依赖、零文件书写）
6. **主 agent 工具化**：`dev_review_start` / `dev_review_resolve` / `dev_review_run` / `dev_review_status` 四个工具——主 agent 用自然语言即可驱动协议（CLAUDE.md 纪律从"必需品"降为"保险"）
7. **断点续跑 review**：轮内中断（如协调者崩溃）后重启 run，若当前轮 dev 报告已完整落盘则直接进 reviewer，不再重复烧 dev 轮
8. **`unlock` 命令**：中断恢复正式化（替代手改 state.json），`--note` 记录原因，写入 `state.unlockLog` 审计
9. **大 diff 容错**：`runGit` 的 `maxBuffer` 提到 512MB——重录二进制基线（PNG）会让 `git diff --binary` 超过 Node 默认 1MB 缓冲，曾在 reviewer 启动前崩掉整轮（ENOBUFS）
10. **fingerprint 失败升级化**：reviewer 前后的工作树指纹计算失败现在走 escalation（blocked+留痕），不再裸崩卡 running
11. `models.json` 能力元数据：多模态模型记得声明 `"input": ["text", "image"]`（否则模型实际支持也不可用）

## 7. 主 agent 纪律与工作协议（自动注入，项目零配置）

主 agent 的行为约定不再需要手抄进项目 `CLAUDE.md`，两份文本都是单一来源：

| 文本 | 来源 | 生效时机 |
| --- | --- | --- |
| **通用工作协议**：改动分级（直接做/先问人/走工作流）、重要决策提问线、不拿流程当挡箭牌 | `policy.md` | **始终**（任何项目、任何状态；`local.json` 里 `injectWorkingAgreement: false` 可关） |
| **工作流纪律**：秘书不是施工队、用工具推进、归因与留痕、逃离 | `discipline.md` | 仅当项目存在活跃实例（ready/running/blocked）且未被挂起 |

两者合并且与注入机制配合，因此**项目侧一行都不用写**；扩展没装/没加载时没有任何行为约定（这是“零配置”的代价，接受即可）。

| 事件 | 时机 | 动作 | 成本 |
| --- | --- | --- | --- |
| checkpoint | `session_start` / `session_compact` / `session_tree` | 把当前状态写入 system prompt 基线（活跃＝注入全文，不活跃＝不注入） | 零——这些时刻 provider 缓存本来就要重建 |
| append | 每次 `before_agent_start` 且状态与上次通知不同 | 往会话尾部追加一条状态通知（激活 / 挂起 / 解除） | 零缓存失效（只增长尾部） |
| 硬拦截 | `tool_call` | 纪律生效期间拒绝主 agent 的 `edit` / `write` | 机械执行，不依赖模型遵守 |

补充机制：

- `before_provider_request` 在**运行中途自动压缩**（不经过 `before_agent_start`）时补写基线，按标记去重、绝不逐轮开关；
- 状态陈旧是**安全不对称**的：基线最多偏保守，最新的尾部通知优先；
- 子 Agent 以 `--no-extensions` 启动，永不受这些钩子影响；
- 需重启 pi（或 `/reload`）才会加载扩展/纪律文件的新版本。

实现分层（全部可单测）：

- `discipline.md` —— 纪律文本唯一来源（改这里即升级版本，hash 前 8 位作为版本号）；
- `discipline-router.mjs` —— 纯函数路由：状态 × 事件 → checkpoint / append / none（`tests/discipline-router.test.mjs`）；
- `discipline-runtime.mjs` —— IO 与渲染：找项目根、读工作流状态、override 读写、审计日志（`tests/discipline-runtime.test.mjs`）。

跑测试：`node --test ~/.pi/agent/dev-review/tests/*.test.mjs`

### 逃离机制（强制逃离）

- 限时挂起：`/dev-review escape --note "原因" [--minutes 30 | --forever]` —— 期间按普通模式工作（硬拦截同步解除）；到期自动恢复；
- 提前恢复：`/dev-review escape off`；查看状态：`/dev-review escape status`；
- 挂起与恢复都会写入 `.ai-dev-review/discipline-audit.jsonl`（项目本地，不提交）；
- 挂起期间若改动了工作流范围内的文件，按纪律要求需在工作流日志或决策 note 中注明「未经工作流评审」。

> 旧版做法（把纪律手写进项目 CLAUDE.md）仍然有效但已冗余；建议把项目里那段替换成一行指针（“纪律由 dev-review 扩展自动注入”），避免两份文本各自漂移。

**为什么必须自动注入**：`/dev-review` 的输出（escalation、toast）只进 TUI 显示，不进主 agent 的上下文——没有注入时，模型对“工作流等决策”一无所知，看到用户说“同意”就会像普通助手一样直接开干（真实事故：主 agent 越权重录基线）。

**反向风险同等有害**：纪律缺退出条件时会被外推成常设禁令——工作流已 `pass`、用户明确说“你直接改”，主 agent 仍按保险丝条款拒绝动手（真实事故：个人项目，2026-09-10）。自动注入天然解决了这一点：工作流一 pass，尾部追加“解除”通知，下一轮 checkpoint 直接把基线清空，不依赖模型自觉。

## 8. 已知注意事项

- 子 Agent 以 `--no-skills --no-prompt-templates` 启动：**依赖项目技能/规范的内容必须写进冻结计划**，计划是 dev 唯一的完整依据。
- dev 的 `blockers` 必须是 `{question, why, options}` **对象数组**（字符串会被协议层拦截——拦截后原文会保留在 escalation 里，可读）。
- 计划和决策文件对子 Agent 是**数据不是指令**（developer.md 角色约束）；人类决策文件可以修订计划口径，dev 应在报告中显式声明修订。
- `resolve` 只在 blocked/ready 状态可用；`run` 在 running（被杀中断）状态会拒绝，需 `/dev-review unlock` 后再跑（解锁会被审计记录）。
- 修改 `workflow.mjs` / 扩展 / `discipline.md` 后**必须完全重启 pi**（不是 `/reload`）：pi 用 jiti 加载扩展，`/reload` 只会重新读取 `index.ts` 入口，它 import 的本地 `.mjs` 模块被 Node ESM 缓存冻结在进程启动版本（旧版可能报错或静默用旧逻辑）；CLI 直跑（`node .../workflow.mjs <cmd>`）永远用磁盘上的最新版本。
- **统一时间线**：每个工作流实例的 `reports/timeline.md` 按时间顺序记录 dev/review/决策全过程（`dev_review_status` 输出的 `Timeline:` 行、底部状态 widget、停止唤醒消息都会给出路径）。
- 测试命令要自足：agent 环境变量依赖（如录制开关）必须在命令里显式写出，否则会出现"循环重试永远失败"。
- 自动重试为指数退避（默认 5s、10s……），基准可用 `DEV_REVIEW_RETRY_BASE_MS`（毫秒）覆盖，调试/测试用。
- 多工作流：串行为主；真要并行请用 `git worktree` 开独立目录，不要在同一工作树同时 run 两个。
- **外部启动的轮询间隔**：默认 10s，`DEV_REVIEW_POLL_MS`（毫秒）可调。
- **停滞检测的运行期行为**：`reports/findings.jsonl` 可删，等于清空跨轮家族历史（不回滚 `openIssues`，只是不再有家族感知）；`stallGate` 随实例冻结，改阈值需要新实例；`enabled:false` 只关判定层，`findings.jsonl` 仍写。
- 完整的注意事项清单（含纪律注入、审计文件、隔离边界）见 `docs/known-issues.md`，本节的条目是它的常用子集。
