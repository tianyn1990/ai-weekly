## Context
M3 已提供 watchdog 扫描与 dry-run，但默认假设单次、单实例、稳定 I/O。为进入可长期运行阶段，需要补齐最小可靠性保障：互斥执行、瞬时失败重试、结构化告警输出。

## Goals / Non-Goals
- Goals:
  - 同一时刻仅允许一个 watchdog 实例执行。
  - 对单条候选复检失败提供重试，降低短暂异常影响。
  - 运行后输出结构化 summary 文件，便于监控与审计。
- Non-Goals:
  - 不实现分布式锁（当前仅单机 lock file）。
  - 不实现外部告警通道（Slack/Email），先输出可消费文件与日志。

## Decisions
- Decision: lock 采用 `fs.open(path, wx)` 原子创建。
  - Why: 最小实现即可满足单机互斥，且无额外依赖。
- Decision: 重试在单候选粒度执行，默认 `maxRetries=2`，固定间隔 `retryDelayMs=300`。
  - Why: 控制复杂度，避免引入全局队列和指数退避策略。
- Decision: summary 输出到 `outputs/watchdog/weekly/<timestamp>.json`。
  - Why: 便于按时间追踪每次守护执行结果并接入外部抓取。

## Risks / Trade-offs
- lock 文件在异常退出时可能残留。
  - Mitigation: 写入 lock 内容（pid/startedAt），并提供 `--watch-force-unlock` 手动清理。
- 固定间隔重试在部分故障下恢复能力有限。
  - Mitigation: 后续版本再升级为指数退避。

## Migration Plan
1. 增加 lock 管理与 CLI 参数。
2. 增强 watchdog 执行为重试模式。
3. 输出 summary 文件与 alert 日志。
4. 补齐测试与文档。

## Open Questions
- 是否需要在失败项 > 0 时返回非 0 退出码（便于 CI 报警）？本次暂保持 0，仅日志告警。
