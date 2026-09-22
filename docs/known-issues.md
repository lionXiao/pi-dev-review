# 已知注意事项

- **改完必须重启 pi（`/reload` 不够）**：pi 用 jiti 加载扩展，`index.ts` 入口会随 `/reload` 重新读取，但它 import 的本地 `.mjs` 模块（`workflow.mjs` / `discipline-runtime.mjs` / `discipline-router.mjs`）被 Node 的 ESM 模块缓存冻结在**进程启动时的版本**，`/reload` 换不掉。表现可能是两类：旧的模块缺新函数 → 报 `(0, _disciplineRuntime.loadPolicy) is not a function` 之类的错；或接口没变但行为是旧的 → 静默用旧逻辑（更阴）。所以：改完这些模块后**完全退出并重启 pi**。CLI 直跑（`node .../workflow.mjs <cmd>`）永远用磁盘最新版。
- **硬拦截是预期行为**：工作流活跃期间主 agent 的 `edit` / `write` 会被拒绝；例外出口是 `/dev-review escape`（会写审计日志）。
- **后台运行**：`run` / `start` 在后台执行，编辑器下方有实时进度条；所有后台任务共用一个运行槽，重复启动会被拒绝；目前不支持中途取消（没有 abort 接口），要停只能等停止条件或挂起纪律。
- **外部启动的运行**：用 CLI/bash 直接拉起引擎（或换 session 后遗留的运行）会被轮询识别（默认 10s，`DEV_REVIEW_POLL_MS` 可调），进度条标注「外部启动」，停止时会唤醒主 agent；底部状态栏反映磁盘真实状态，不会因启动方式不同而不一致。若运行在扩展观察窗口之外结束（拉起时扩展没看到、或 block 发生在 reload 之前），下一个回合会补报一次停止原因（reason + 摘要 + 决策问题）；唤醒消息与状态栏都带 `blocked (reason)`，不是光秃秃的 "blocked"。
- **统一时间线日志 = 全过程日志**：每个工作流实例的 `reports/timeline.md` 按时间顺序追加全部事件（plan 冻结 → dev rN → review rN → 人工决策/升级 → pass），每行带时间戳、轮次、结果、摘要和产物相对路径；事件之间还按顺序追加该阶段的 assistant 正文、thinking 标记、工具调用（参数一行）与结果（阶段头 `## dev r1 · <model> · <时间>`、消息头 `### <时间> · assistant`），可以直接当 dev+review 的拼接日志读，也可以 `tail -f` 边跑边看。为控制体积，工具结果超过 8k 字符时保留头 5k + 尾 3k 并标注省略字符数，thinking 默认只留一行 `🧠 thinking · N tok` 标记（全文不内联），逐字原文在 `private/` 的 pi session JSONL；`DEV_REVIEW_TRANSCRIPT=full` 内联 thinking 全文，`DEV_REVIEW_TRANSCRIPT=0` 关闭过程部分只留里程碑。`dev_review_status` 输出 `Timeline:` 行，底部/编辑器下方状态也会显示相对路径。
- **子 agent 不受纪律钩子影响**：developer / reviewer 以 `--no-extensions` 启动；`discipline.md` 的规则只约束主 agent。
- **审计文件不要提交**：`.ai-dev-review/`（含 `discipline-audit.jsonl`、handoffs、private sessions）是项目本地运行态。
- **项目零配置**：纪律与工作协议均由扩展注入，项目 `CLAUDE.md` 不需要写任何 dev-review 相关内容（旧的手写段落可直接删除）。代价：扩展未安装/未加载时没有任何行为约定。
- **测试按 glob 传参**：`node --test tests/*.test.mjs`；直接把目录传给 `--test` 在部分 Node 版本不生效。
- **多工作流并行**：不推荐；要并行请用 `git worktree` 开独立目录，不要在同一工作树同时 run 两个。
- **计划改了就换实例**：实例按「计划文件 hash + label」区分；下一批次改了计划就要用 `dev_review_start` 新建。对已 passed 的旧实例执行 `run`、且计划文件已变时，引擎会报错提示改用 `start`（不再静默无操作）。
- **旧安装包已废弃**：`pi-dev-review-workflow-2026-09-07`（Downloads 里的老包）以及更早的手抄版 `CLAUDE.md` 纪律段落，均被本仓库取代；不要再运行老包的 `install.sh`。
- **停滞检测（stall detection）运行期注意**：
  - `reports/findings.jsonl` 是新的运行产物（append-only，每轮 review 一条）。旧实例没有该文件时按空历史处理：soft/hard 都不触发、不报错；从中间开始新建的实例只有新轮次进入家族判断。手动删除该文件等于清空停滞历史（不回滚 openIssues，只是不再有跨轮家族感知）。
  - `stallGate`（`defaults.json`，可被 `local.json` 覆盖）随实例冻结在 `state.config`。`enabled:false` 关闭判定层（不写 `state.stall`、不注入、不升级），但 `findings.jsonl` 仍按轮记录（数据层独立于判定层，方便后续打开或离线分析）；改阈值需要新实例（或直接改 `local.json` 后重新 `init`）。
  - hard 触发会把实例 block 在 reason `stalled-issue-family`，决策文件里带机器生成的家族表和三个结构化选项；`resolve` 后同一家族可能再次触发（没有冷却，沿用「连续 hard 由人控制」的阻断语义）。
  - reviewer 可用新 finding 上的 optional 字段 `repeat_of: "<family id>"` 确认同源；旧模型不输出该字段时，机械链接信号仍然兜底。
  - 命中判据是纯函数（计数 + 字符串比对），只声明「这些 finding 与仍未闭合的东西关联紧密」，不宣布「同根因」；语义确认在 reviewer，范围决策在人。
