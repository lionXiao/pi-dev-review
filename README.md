# pi-dev-review

[![CI](https://github.com/lionXiao/pi-dev-review/actions/workflows/ci.yml/badge.svg)](https://github.com/lionXiao/pi-dev-review/actions/workflows/ci.yml)

一个人工审签、双 Agent 自动执行的**开发-评审工作流**（Pi 扩展）：冻结计划 → developer 实现 → reviewer 独立评审 → pass/blocked 循环。主 agent 是秘书不是施工队，决策权永远在人手里。

> 定位：**verification-first** —— 本地优先、可审计、人做最终决定。市场卖「放手」，这里卖「敢放手的前提」。

> 文档内的例子均为脱敏虚构项目（`shop-service` 电商后端，通用 Node 测试命令），与本机任何真实仓库无关。

## 0. 与近邻的差异

| 近邻 | 它是什么 | 本项目的差异 |
| --- | --- | --- |
| [github/spec-kit](https://github.com/github/spec-kit) | 规格驱动开发工具包 | 不做规格工件格式，只做「冻结计划 → 实现 → 独立评审」的执行循环 |
| [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) | 多角色敏捷方法论（文档集） | 可执行的引擎 + 状态机 + 人工决策协议，不是方法论 |
| Ralph 系循环（ralph-claude-code 等） | 让 agent 反复跑到通过 | 有角色分离、冻结计划归因、人工决策门与审计，不是无脑循环 |
| Pi 自带 subagent 示例 | worker → reviewer → worker 链 | 多了轮次预算、协议校验、决策留痕、主 agent 纪律自动注入 |

适用：本地仓库、个人或小团队、对可复现/可审计有要求、愿意为验收付出人工成本。
不适用：追求完全自动、无人值守的批量改动。

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
bash install.sh        # 装到 ~/.pi/agent/（扩展 + 引擎 + 纪律 + prompt 模板）
cp ~/.pi/agent/dev-review/local.json.example ~/.pi/agent/dev-review/local.json
# 编辑 local.json：developerModel / reviewerModel（必须不同）/ 两个 thinking 档
```

验证：`pi` 启动后 `/dev-review help`。

主 agent 纪律由扩展**自动注入**（见 §7），项目 `CLAUDE.md` 里不再需要手写；已有手写纪律段落的项目建议替换为一行指针，避免两份文本各自漂移。

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
- 工作树有"故意要被评审的代码"时加 `--allow-dirty`（仅 start 检查，run 不检查）
- 模型可写在 `local.json`，start 时不用传

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

`run` / `start` 不阻塞主 agent 的回合：引擎在后台继续跑，编辑器下方有一条实时更新的进度条（运行时长 · 最近引擎事件 · 轮次），底部状态栏同步显示。你可以随时继续聊天，主 agent 也能正常回复。机器停止时（pass / blocked / max-rounds）会有一条总结消息自动唤醒主 agent，直接给出结果与下一步。

- 进度条：`dev-review ▶ 运行中 3m12s` + 最近一条引擎事件，每秒更新；
- **外部启动也能识别**：如果是用 CLI/bash 直接拉起引擎（或上一个 pi 会话遗留的运行），扩展会按轮询跟踪：进度条标注「外部启动」，停止时同样会唤醒主 agent；底部状态栏始终反映磁盘上的真实状态（running rN/blocked/passed），不依赖谁启动的；
- 随时查询：`dev_review_status` 工具或 `/dev-review status`，输出带 `[run]` 行；
- 同一时间只允许一个后台运行，重复启动会被拒绝；
- 新建实例用 `dev_review_start`（工具，plan 哈希变化/新批次必需）；`dev_review_run` 只续跑已有实例，两者都走后台上进；
- 目前不提供中途取消（引擎无 abort 接口）：要停只能等到停止条件，或 `/dev-review escape` 挂起纪律后手动处理。

### 3.4 日常命令

```text
/dev-review status     # 状态（blocked 时把 escalation 摘要也展示）
/dev-review list       # 多工作流列表
/dev-review use <id>   # 切换活动工作流
/dev-review adopt      # 换机/换 checkout 后接管（.ai-dev-review/ 拷过去之后）
/dev-review configure  # 改模型/轮数/测试命令
```

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
3. **磁盘全量**：`handoffs/`（每轮 JSON+MD）、`reports/`（最终报告）、`private/*-sessions/*.jsonl`（两边的完整过程，可用 `pi --session-dir ... -r` 交互回看）。
4. **后台运行进度条**：`run` / `start` 后台执行时，编辑器下方显示实时进度（运行时长 + 最近引擎事件），主 agent 回合不被占用；停止时注入总结消息。CLI/bash 直接拉起的「外部启动」由轮询跟踪，同样有进度与停止唤醒。

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

## 7. 主 agent 纪律（自动注入）

主 agent 纪律不再需要手抄进项目 `CLAUDE.md`：dev-review-loop 扩展会**自动检测活跃工作流并注入**，内容单一来源为 `~/.pi/agent/dev-review/discipline.md`。

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
- 修改 `workflow.mjs` / 扩展 / `discipline.md` 后**必须重启 pi** 才对运行中的会话生效（ESM 模块已缓存）；CLI 直跑（`node .../workflow.mjs <cmd>`）永远用磁盘上的最新版本。
- 测试命令要自足：agent 环境变量依赖（如录制开关）必须在命令里显式写出，否则会出现"循环重试永远失败"。
- 多工作流：串行为主；真要并行请用 `git worktree` 开独立目录，不要在同一工作树同时 run 两个。
