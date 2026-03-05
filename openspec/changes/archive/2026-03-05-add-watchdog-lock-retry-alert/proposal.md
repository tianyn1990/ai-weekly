# Change: 增加 watchdog 互斥锁、失败重试与告警输出

## Why
当前 watchdog 已能扫描并执行 pending 周报复检，但在定时任务真实运行中仍存在稳定性缺口：
1) 多实例并发触发时可能重复处理同一报告；
2) 短暂 I/O 异常会直接导致失败；
3) 缺少结构化告警输出，难以接入运维监控。

## What Changes
- 为 weekly watchdog 增加单实例互斥锁（基于 lock 文件）。
- 为候选报告复检增加可配置重试（次数+间隔）。
- 输出结构化 watchdog summary 到磁盘，用于告警与追踪。
- 当存在失败项时输出显式 alert 日志，便于 cron/CI 抓取。

## Impact
- Affected specs: `ai-reporting-pipeline`
- Affected code:
  - `src/cli.ts`
  - `src/pipeline/watchdog.ts`
  - `tests/watchdog.test.ts`
  - `README.md`
  - `docs/architecture.md`
  - `docs/learning-workflow.md`
