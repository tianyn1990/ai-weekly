## Context
当前系统已支持单份周报复检发布（`--recheck-pending`），但缺少批量扫描入口，运维需要手动指定 `reportDate`。在真实运行中，自动发布应由定时任务驱动，因此需要一个“可重复执行、幂等、可观测”的 watchdog 模式。

## Goals / Non-Goals
- Goals:
  - 提供一次性 watchdog 扫描命令，自动处理所有 pending 周报。
  - watchdog 复用既有 recheck 逻辑，避免规则重复实现。
  - 提供 dry-run 和处理摘要，便于逐步上线。
- Non-Goals:
  - 本阶段不实现常驻 daemon 进程。
  - 本阶段不实现分布式锁或多实例抢占。

## Decisions
- Decision: 在 CLI 新增 watchdog 子模式（如 `run --watch-pending-weekly`）。
  - Why: 复用现有运行入口和参数体系，降低学习成本。
- Decision: 扫描目录固定为 `outputs/review/weekly/*.json`，筛选 `reviewStatus=pending_review` 且 `publishStatus=pending`。
  - Why: 以 review 产物作为事实来源，保证与人工审核基线一致。
- Decision: 对每个候选项依次执行 recheck，并产出处理摘要（processed/published/skipped/failed）。
  - Why: 先保证可预测和可调试；后续再做并发优化。
- Decision: 增加 `--dry-run`，仅打印将处理的报告，不落盘修改。
  - Why: 降低生产变更风险，便于灰度验证。

## Risks / Trade-offs
- 顺序处理在候选量大时耗时偏长。
  - Mitigation: 首版候选量可控；后续根据指标再引入并发。
- 缺少分布式锁，多个调度实例可能重复处理同一报告。
  - Mitigation: 当前部署约束为单实例 cron；后续升级 DB 锁。

## Migration Plan
1. 新增 watchdog 扫描与筛选逻辑。
2. 接入 recheck 执行与 dry-run 分支。
3. 输出处理摘要并补单测。
4. 更新文档与学习材料。

## Open Questions
- watchdog 命令名是否保持在 `run` 子命令内，还是拆分成独立 `watch` 子命令？
