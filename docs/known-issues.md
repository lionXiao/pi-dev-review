# 已知注意事项

- **改完必须重启 pi**：`workflow.mjs`、扩展、`discipline.md` 都是启动时加载（ESM 已缓存）；重启 pi 或 `/reload` 后才对运行中的会话生效。CLI 直跑（`node .../workflow.mjs <cmd>`）永远用磁盘最新版。
- **硬拦截是预期行为**：工作流活跃期间主 agent 的 `edit` / `write` 会被拒绝；例外出口是 `/dev-review escape`（会写审计日志）。
- **后台运行**：`run` / `start` 在后台执行，编辑器下方有实时进度条；所有后台任务共用一个运行槽，重复启动会被拒绝；目前不支持中途取消（没有 abort 接口），要停只能等停止条件或挂起纪律。
- **外部启动的运行**：用 CLI/bash 直接拉起引擎（或换 session 后遗留的运行）会被轮询识别（默认 10s，`DEV_REVIEW_POLL_MS` 可调），进度条标注「外部启动」，停止时会唤醒主 agent；底部状态栏反映磁盘真实状态，不会因启动方式不同而不一致。
- **子 agent 不受纪律钩子影响**：developer / reviewer 以 `--no-extensions` 启动；`discipline.md` 的规则只约束主 agent。
- **审计文件不要提交**：`.ai-dev-review/`（含 `discipline-audit.jsonl`、handoffs、private sessions）是项目本地运行态。
- **测试按 glob 传参**：`node --test tests/*.test.mjs`；直接把目录传给 `--test` 在部分 Node 版本不生效。
- **多工作流并行**：不推荐；要并行请用 `git worktree` 开独立目录，不要在同一工作树同时 run 两个。
- **旧安装包已废弃**：`pi-dev-review-workflow-2026-09-07`（Downloads 里的老包）以及更早的手抄版 `CLAUDE.md` 纪律段落，均被本仓库取代；不要再运行老包的 `install.sh`。
