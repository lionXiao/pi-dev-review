# ADR 0002：技能注入通道 —— 由调用方决定，只给 developer

- **状态**：已接受
- **日期**：2026-09-16
- **背景**：子 agent 以 `--no-skills` 启动，这是有意的（结果不受本机 skills 目录漂移影响，受评审的是代码而不是环境）。但需要专门指导时（例如 SwiftUI 批次需要 SwiftUI 专项技能），此前没有任何通道：要么改 `prompts/developer.md`（全局的，会把一次性需求固化进角色提示词），要么放开技能发现（评审结果从此依赖「机器上装了什么」）。

## 决策

1. **只加通道，不硬编码清单**。引擎不认识任何具体技能：新增 `--dev-skill <path>`（可重复，目录含 `SKILL.md` 或单个技能文件），只在 developer 进程上追加 pi 的 `--skill <path>`。保留 `--no-skills`，注入项 100% 由调用方显式给出——白名单 ≥ 自动发现。
2. **只给 developer**。reviewer 永远没有技能：评审的价值在独立性，注入 how-to 指导会污染 verdict（把「独立判断」变成「按技能自证」）。
3. **校验前置，冻结绝对路径**。init/configure 时逐条 `existsSync`（目录还必须含 `SKILL.md`），失败即终止；`~` 展开、相对路径按调用 cwd 解析，canonicalize 后写进 `state.json`。理由：技能没生效是**静默失败**，等第 3 轮才发现时，本该使用它的轮次已经烧掉了。
4. **来源三层，复用现有配置优先级**：CLI/工具参数 > state 冻结值 > `local.json`/`defaults.json`。冻结意味着改 `local.json` 不影响已启动实例；要用新的技能得显式 `configure --dev-skill` / `run --dev-skill`（整体替换）。
5. **可审计**：`state.config.devSkills` + `status` 的 `Dev skills:` 行 + timeline 初始化段落的 `Developer skills (--skill):`。
6. **引擎不做计划解析**。计划文件里的 `## 注入技能` 一节由主 agent 读取并转成 `dev_skills` 参数——引擎只冻结文本、不做语义解析，与「计划是唯一依据」的现有边界一致。

## 备选方案与取舍

| 方案 | 影响面 | 风险 | 结论 |
| --- | --- | --- | --- |
| 放开 `--no-skills`（子 agent 自动发现本机技能） | 最大 | 结果依赖机器状态、不可复现；reviewer 一并被污染 | 未采纳 |
| 把指导写进 `prompts/developer.md` | 全局 | 一次性需求固化成角色提示词，所有项目所有批次一起承担 | 未采纳 |
| 引擎解析计划里的技能声明 | 中 | 语义解析进引擎，格式一变就坏；与「计划冻结文本」边界冲突 | 未采纳 |
| **本方案（显式路径参数，只给 developer）** | 小 | 调用方要多传一个参数；路径写错会 fail fast（这正是想要的） | 采纳 |

## 后果

- 批次级指导可以随计划一起冻结、一起评审，批次结束即失效（新实例不继承）。
- 技能内容不在引擎审计范围内（引擎只记录路径）；技能本身的能力/安全性由使用者负责——pi 文档已提示 skills 可以指示模型执行任意操作。
- `~` 在冻结时展开为绝对路径，`state.json` 不可跨机器移植；与 dev-review 产物的本地性一致（`adopt` 也不迁移技能，需在新机器上重新 `configure --dev-skill`）。

## 验证

- `dev-skills.test.mjs`（6 用例）：纯函数解析 / `~` 展开 / 去重 / 坏路径拒绝；端到端「developer 有 `--skill` 且 reviewer 没有」；含空格路径过 CLI tokenizer；缺失路径 fail fast 且不落盘；`run`/`configure` 替换与校验。
