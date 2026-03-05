# Change: 增加 pending 周报定时守护（watchdog）能力

## Why
M2.5 已支持手动执行 `--recheck-pending`，但自动发布仍依赖人工触发命令，无法稳定满足“周一 12:30 未审自动发布”的运行目标。需要一个可定时执行的 watchdog 入口，自动扫描 pending 周报并触发复检发布。

## What Changes
- 新增 watchdog 扫描能力：自动遍历 `outputs/review/weekly/*.json` 中的 pending 周报。
- 对候选周报执行复检发布判定：调用现有 recheck 流程，不重跑采集链路。
- 新增 dry-run 与执行摘要输出，支持运维排查与安全上线。
- 支持 cron/CI 定时调用（先做一次性扫描模式，后续可扩展常驻进程）。

## Impact
- Affected specs: `ai-reporting-pipeline`
- Affected code:
  - `src/cli.ts`
  - `src/pipeline/recheck.ts`
  - `src/pipeline/review-policy.ts`
  - `tests/*`
  - `README.md`
  - `docs/architecture.md`
  - `docs/learning-workflow.md`
