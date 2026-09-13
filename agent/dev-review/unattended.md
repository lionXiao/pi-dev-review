# 无人值守批处理协议（Unattended Batch）

> 触发：用户说「无人值守」并给出队列文件（默认 `.ai-dev-review/unattended-queue.md`）。
> 目标：一个 pi 会话内串行跑完队列里所有 plan；中途**不找用户**，早上一次性汇总与排查。
> 用户授权日期：2026-09-13（规则来源：用户口述，见 §1）。

## 1. 授权边界（最重要）

用户给出队列文件 = **预授权**主 agent 在无人值守期间按本协议代为决策。仅限：

- 技术/事实/验证类问题：可代决策继续（先验证，验证不了按最保守假设继续并登记风险）；
- 协议类/环境类故障：可代为「重试」；
- **产品口径、范围、设计取舍、需要人签核的事项：不在授权内，一律跳过。**

每次代决策必须在 `dev_review_resolve` 的 note 里写明：

```
无人值守预授权（队列 .ai-dev-review/unattended-queue.md，<日期>），无人工当场确认。
依据：<分类表条目>。<具体处理方式>
```

reviewer 会读 decision note，没有这句留痕的自动决策视为主 agent 越权。

## 2. 开跑前检查（任何一项不过 → 不启动，说明原因等用户）

- [ ] 队列文件存在且每行格式合法（见 §6）
- [ ] 没有 `running` 实例（`/dev-review list`）；有 blocked 旧实例 → 记入值守报告「遗留」节，不阻挡开跑
- [ ] 工作树干净（`git status`）。不干净 → 先 commit/stash 或等用户，**不得**用 `--allow-dirty` 绕过
- [ ] 队列内每份 plan 都已冻结（无人值守期间不改 plan；改了 = 新实例）
- [ ] 创建无人值守分支：`git checkout -b unattended/<YYYY-MM-DD>`（从当前 HEAD）
- [ ] 提醒用户：`caffeinate -i` 防睡 + 保持 pi 会话打开（会话退出 = 链条断，但磁盘状态可续）

## 3. blocked 分类表（reason → 动作）

| 停机 reason | 无人值守期间的动作 |
|---|---|
| `developer-protocol-or-execution-error` | 重试 1 次（note：报告按严格合法 JSON 重发，不重做已完成工作）；再犯 → SKIP |
| `reviewer-protocol-or-execution-error` | 同上 |
| `invalid-review-pass` / `invalid-review-fix-required` | 重试 1 次；再犯 → SKIP |
| `developer-blocked` | 读 questions/options：**不涉及产品口径**且有「继续/验证」类选项 → 选它并注明先验证；否则 SKIP |
| `reviewer-spec-blocked` | 默认 SKIP（口径歧义要人拍板）。仅当问题纯属事实核对、且选项含「按现状继续」时才可继续 |
| `max-rounds` | 默认 SKIP；仅当 open issues ≤1 且明显可修时，加 2 轮（一次） |
| reviewer 改动仓库 / 状态机异常 | 立即 SKIP，标记「异常」 |

每份 plan 的自动 resolve 上限 **2 次**；超过即 SKIP，写进值守报告，不再纠缠。

## 4. 主循环（对队列每项依次）

1. `dev_review_start(plan, label, test, max_rounds, confirm_master_plan=true)`
   （队列文件即用户预授权，`confirm_master_plan=true` 合法）
2. 等待 stop 唤醒。正常 dev↔review 修复轮次**不干预**。
3. stop 后查 `dev_review_status`，按 §3 分类：
   - 可继续 → `dev_review_resolve`（note 带 §1 留痕句）+ `dev_review_run`，回到步骤 2；
   - 否则 → 标记 SKIP，**不 resolve**（保持 blocked 原样留待早上）。
4. 该 plan 收尾（git 卫生，保证下一份从干净可构建的基础开工）：
   - **pass**：把工作树提交到无人值守分支，message：`unattended: <key> pass (pending morning review)`；
   - **skip / blocked / 异常**：把当前工作树提交到 `unattended/<date>-<key>`（park，注明「未评审 WIP」），
     再把无人值守分支 `git reset --hard` 回上一份 pass 的 commit。
     这样半成品不会把后续 plan 的构建/审查污染掉；被 park 的 WIP 早上可单独恢复。
   - **每个 commit 的 message 末尾必须带遗留清单**（`遗留:` 起一行，逐条列出未完成/未整理的项，没有就写「无」），
     这样早上 `git log` 就能直接看到「这个提交还欠着什么」，不用翻值守报告。
   - **不 push**：所有无人值守 commit 只留在本地分支，去向由用户早上决定。
5. 追加值守报告一节（§7），进入下一项。
6. **熔断**：cutoff 由用户决定（队列文件 `cutoff:` 行，可选）：写了就按它停，没写就一直跑到队列结束。
   不要自行设定时间。

## 5. 同一 plan 内未完成的部分

不追加轮次硬啃。值守报告里按三栏记录（从 dev/reviewer 报告与 escalation 里提取）：

- 已完成：<验收项/批次>
- 未完成：<验收项/批次>（具体到条目）
- 阻塞点：<一句话> + escalation 路径

## 6. 队列文件格式（`.ai-dev-review/unattended-queue.md`）

```md
# 无人值守队列 2026-09-13

授权：用户于 2026-09-13 预授权，按 ~/.pi/agent/dev-review/unattended.md 执行。
cutoff: <可选，如 07:00；不写=跑完为止>
test: xcodebuild test -project dieMoney.xcodeproj -scheme dieMoney -destination 'platform=iOS Simulator,name=iPhone 17 Pro'

- docs/prd/v1.2-b2-xxx-plan.md | label=b2 | max-rounds=6
- docs/prd/v1.2-b3-yyy-plan.md | label=b3 | max-rounds=6 | note=依赖 b2 的改动
```

- `test` 行：整个队列共用的测试命令（引擎要求自足，环境变量写全）
- 每份 plan 一行，顺序即执行顺序；`note` 原文交给 dev 作为任务补充说明

## 7. 值守报告格式（`.ai-dev-review/unattended-<date>.md`）

每份 plan 一节：

```md
## <key> — <outcome>
- outcome: pass | skipped(blocked|异常|超限) | max-rounds | not-started
- 轮次: r<N>（自动决策 N 次：每条一句话 + decision note 路径）
- commit: <SHA>（无人值守分支 / park 分支）— 遗留: <该 commit 未完成/未整理的项，逐条；无则「无」>
- 已完成: …
- 未完成: …（没有就写「无」）
- 阻塞点 & 待早上决策: Q/选项原文 + escalation 路径
- 验收命令: <单条可复制的命令>
```

结尾 **总表**：key / outcome / 轮次 / 需人工处理 / 建议排查顺序。

## 8. 早上的收尾流程

1. 先读值守报告，按「建议排查顺序」逐份处理
2. blocked 的 plan：`/dev-review use <key>` 切为活动实例 → `dev_review_resolve` → `dev_review_run`
3. 被 park 的 WIP（`unattended/<date>-<key>` 分支）：建议在独立 `git worktree` 里恢复续跑，避免与后续 plan 的改动互染
4. 验收无人值守分支：每份 plan 一个 commit，边界即 plan 边界
5. **统一整理遗留**：把所有 commit 的 `遗留:` 清单汇总成一份待办，一起排版/收尾（用户统一处理）
6. 全部处理完再决定合并/丢弃/续跑

## 9. 已知限制（如实告知用户）

- 会话退出、机器睡眠 = 唤醒链断（状态都在磁盘，早上可手动续）
- 一段无人值守只在一个工作树里串行；真正的跨工作树并行需要 CLI 驱动，会失去主 agent 的判断力
- 所有 commit 只在本地分支，**不 push**；无人值守期间不做任何远端操作
- 不会推送手机（未配置 notify.json）；桌面通知在窗口失焦时可能出现
- 被 SKIP 的 plan 不会被无人值守自动回头处理，只做标记
