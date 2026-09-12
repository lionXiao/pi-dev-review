# Changelog

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
