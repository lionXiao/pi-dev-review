# 停滞检测（stall detection）实施计划

**状态：已确认 / 已冻结（2026-09-19，用户聊天确认；`.ai-dev-review/` 运行产物已加入 .gitignore）**
**批次：pi-dev-review 自身 · 引擎段（引导段的 fixture/label 已冻结，见 §3）**

## 1. 问题与目标

b2a（19 轮，7 次人工加轮）、b2c（8 轮，用户叫停并留下"打地鼠"记录）、a3e2（11 轮）暴露同一个失效模式：**评审发现的是"下一条可达路径"，开发者修的是"被点名的那条路径"，引擎对"同一根因家族跨轮存活"没有任何感知**。结果轮次无限增长、人工在 max-rounds 上反复救火。

目标：引擎机械识别停滞家族，并只在命中时做两件事——

1. **软信号**：下一轮任务包里注入一段"家族级验收判据"（给 developer）与"未连接候选确认"（给 reviewer）；
2. **硬信号**：带机器生成的家族报告停给人，附结构化选项。

设计原则（本批的验收底线，同时也是实现约束）：

- **条件注入，不是常驻教义**：`prompts/developer.md` 与 `prompts/reviewer.md` 本批**零改动**；补偿文本只在检测命中时出现在任务包里，不命中时任务包与现状逐字节一致。
- **机械路由**：检测是纯函数（计数 + 字符串比对），无 LLM、无网络；语义确认交回 reviewer（`repeat_of`），范围决策留给人。
- **内容可删除**：补偿文本是独立常量，删除它不影响路由/升级/观测。
- **不越权**：引擎只报"这些 finding 与仍未闭合的东西关联紧密"，不宣布"同根因"。

## 2. 非目标

- 不修改 `prompts/developer.md`、`prompts/reviewer.md`。
- 不改 max-rounds 语义、不自动决定"重做/顺延/改计划"（那是人的选项）。
- **不编辑 `tests/fixtures/stall/*.json` 与 `labels.json`**。若实现中发现某条标签与事实不符：返回 `blocked` 并附证据，不得就地改标签或改 fixture。
- 不做 UI、不做跨实例统计报表（后续批次）。

## 3. 已冻结的验收资产（引导段产出）

- `agent/dev-review/tests/fixtures/stall/`：17 个真实 run 的脱敏回放（3 stalled / 6 churn / 8 healthy）+ `labels.json`（人工 ground truth，含 `knownL2Misses`）+ README（脱敏与再生成说明）。
- `agent/dev-review/tools/export-stall-fixtures.mjs` + `stall-fixture-map.json`：确定性导出器（本批**不改**；如需新增映射，属引导段维护，另行处理）。
- `agent/dev-review/tests/stall-fixtures.test.mjs`：契约测试（当前 53/53 全绿的一部分）。
- 验收判据（由 `labels.json` 的 `firePolicy` 定义）：
  - `stalled-family`：家族成员聚成一类（`knownL2Misses` 例外，见下），soft 在 `soft.round` 前触发；
  - `healthy`：soft/hard 均不得触发；
  - `churn`：soft 允许；hard 首触不得早于 `hard.round`；
  - `knownL2Misses`（b2a 的 R16-001/R18-001/R19-001、a3e2 的 R10-001）：文本链接器**允许漏**，但必须出现在 L3 候选列表（见 §4.3），且在被 reviewer `repeat_of` 确认后进入家族。

## 4. 技术方案

### 4.1 数据层

- 新增 `reports/findings.jsonl`（append-only，每轮 review 后追加一条）：
  `{ "round": N, "decision": "...", "verdicts": [{id, verdict}], "findings": [{id, severity, location, requirement, evidence, required_fix}] }`
  字段与 fixture 保持同构（fixture 可直接喂给检测器，测试零转换）。
- `state.openIssues` 每项增加派生字段：`partial_streak`（连续未闭合判定的轮数）、`rounds_open`；`issueSummary()` 一并带出，让两个角色看得到"这是第几轮尝试"。

### 4.2 检测器（纯函数，导出供单测）

```
detectStallClusters(log, openIssues, config) -> {
  clusters: [{ key, members, rounds, openMembers, hot }],
  soft: { fired, reasons, clusters },
  hard: { fired, reasons, clusters }
}
```

链接信号（对每个新 finding 与其之前、且当时未闭合的 finding 配对）：

- `sameFile`：location 文件部分相同；
- `ref`：finding 文本（requirement+evidence+required_fix）包含父 issue id；
- `reqSim`：requirement 去除样板前缀与标点后的中文双字组 Jaccard；
- `identSim`：evidence+required_fix 中长度 ≥5 的 ASCII 标识符集合 Jaccard；
- `parentOpen`：父项在该轮尚未 `verified_closed`（半权）。

`score = sameFile + 2·ref + [reqSim ≥ cfg.reqSim] + [identSim ≥ cfg.identSim] + 0.5·parentOpen`；`score ≥ cfg.linkThreshold` 连边，union-find 得家族。排除 `spec_blocked` 轮的 finding（无代码信号）。

触发（初值，允许按 fixture 标定微调）：

- **soft**：存在 open issue `partial_streak ≥ cfg.softStreak`；或活跃家族（≥2 成员、至少一人未闭合）跨度 `≥ cfg.softSpan` 轮；
- **hard**：存在 open issue `partial_streak ≥ cfg.hardStreak`；或家族跨度 `≥ cfg.hardSpan` 且 open 成员 ≥2 且最近 2 轮有新成员；
- 仅在 `decision === "fix_required"` 的轮之后评估。

初值：`linkThreshold 1.5`、`reqSim 0.35`、`identSim 0.30`、`softStreak 2`、`softSpan 3`、`hardStreak 3`、`hardSpan 4`。这些值来自会话回放标定；**以 `labels.json` 全绿为准，可调实现，不可改标签**（若出现无法同时满足的组合，返回 blocked 附权衡表）。

### 4.3 注入（只在命中时）

- `makeDeveloperTask`：soft 命中时追加 `STALL_DIRECTIVE`（导出常量），内容为判据而非方法：
  > 该文件族在最近 N 轮评审中产生 M 条同源 finding，仍有 K 条未闭合（列出 id/轮次/最近判定）。本轮按家族整体验收：给出根因不变量，逐一列出会违反它的边界，并对每条给出"已修/不可达/不在本批"的结论与证据；实现方式不限，但只修被点名的那条路径、其余沉默视为未完成。
- `makeReviewerTask`：家族处于热态时追加候选段——列出**未连接**的同轮/同区 finding，要求逐条确认或分离；确认为同源时在新 finding 上用 optional 字段 `repeat_of: "<family id>"` 声明（schema 层 optional，不影响既有输出）。
- **不命中：任务包零变化**（测试断言与当前输出逐字节一致）。

### 4.4 硬升级

- 新 reason `stalled-issue-family`，复用现有 escalate/ blockedNotice 通道；
- 内容：机器生成的家族表（成员、首现轮、判定链、开放数、跨度、热态文件）+ 结构化问题三选项：
  1. 授权一轮钉死范围的系统性修复（人写范围）；
  2. 该家族登记为已知限制并顺延到后续批次；
  3. 修订计划/口径（附当前家族报告）。
- 触发时机：review 结束、下一轮开始前；同一实例连续 hard 触发由人 resolve 控制（沿用现有阻断语义，不新增冷却逻辑）。

### 4.5 配置与观测

- `defaults.json` 新增 `stallGate: { enabled: true, linkThreshold, reqSim, identSim, softStreak, softSpan, hardStreak, hardSpan }`；per-instance 冻结（沿用现有配置优先级）；`enabled:false` 完全关闭。
- 每次 soft/hard 触发：timeline 追加一行（kind、家族成员、原因、是否注入）+ `state.stallEvents[]` 记录同样内容。为将来的命中率/收敛率统计与"删除决策"留数据。

## 5. 测试计划

新增 `agent/dev-review/tests/stall-detection.test.mjs`：

1. **fixture 回放（17 个）**：按 `labels.json` 断言 firePolicy、家族聚类（`knownL2Misses` 除外）、L3 候选覆盖 known misses；
2. **链接信号单测**：小样本逐信号验证（ref / sameFile / reqSim / identSim / parentOpen）；
3. **不触发零注入**：healthy 场景下 `makeDeveloperTask`/`makeReviewerTask` 输出与关闭检测时逐字节一致；
4. **配置关闭**：`stallGate.enabled=false` 时零触发、零注入；
5. **repeat_of 固化**：reviewer 声明后该 finding 进入家族，后续轮不再出现在候选列表。

现有 53 个测试必须保持全绿。命令：

```
cd agent/dev-review && node --test tests/*.test.mjs
```

## 6. 假设与未决问题

- **假设**：引擎可以读 `reports/findings.jsonl` 并只用它 + `openIssues` 判定；不引入新的持久化格式版本迁移（旧实例无该文件时视为空历史，不触发，不报错）。
- **假设**：`repeat_of` 只作为可选确认信号，不要求 reviewer 一定识别血缘（机械信号兜底）。
- **未决**：soft 注入是否也直接给 reviewer 一段"必须给可证伪闭合判据"的要求（当前方案只给候选确认；若 fixture 回放显示 stalled 家族反复无法收敛，可在本批内补充）。
- **未决**：L3 候选的收集范围（同文件 vs 同目录）。初值为"同文件 + 家族热态时的同轮 finding"；若 healthy/churn 出现噪音，收紧到同文件。

## 7. 交付物

- `agent/dev-review/workflow.mjs`：检测器 + 注入 + 升级 + 观测 + 配置；
- `agent/dev-review/tests/stall-detection.test.mjs`；
- `agent/dev-review/defaults.json`：`stallGate` 段；
- `CHANGELOG.md` 条目（含 b2a/b2c/a3e2 事故出处与阈值标定结论）；
- `docs/known-issues.md`（如引入新的运行期注意事项）。
