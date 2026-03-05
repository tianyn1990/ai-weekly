# M3 学习复盘 01：pending 周报 watchdog 扫描

## 1. 本次实现了什么
- 新增 watchdog 扫描能力：批量巡检 `outputs/review/weekly/*.json`。
- 新增 `--watch-pending-weekly` 与 `--dry-run` 参数，支持安全灰度上线。
- watchdog 复用 M2.5 的 recheck 逻辑，不重跑采集链路。
- 输出守护摘要：`processed/published/skipped/failed`，便于 cron 观测。

## 2. 流程图（M3）
```text
watch_pending_weekly
  -> scan review artifacts
  -> validate artifact schema
  -> filter pending_review + pending
  -> recheck_pending_weekly_report
  -> optional persist (skip when dry-run)
  -> print summary
```

## 3. 源码导读（建议阅读顺序）
1. `src/pipeline/watchdog.ts`
   - 看 `evaluateCandidate`：理解为什么先跳过已发布或非 pending 报告。
   - 看 `runPendingWeeklyWatchdog`：理解 dry-run 与实际落盘共用同一套判定逻辑。
2. `src/cli.ts`
   - 看 `runWatchPendingWeekly`：理解扫描、加载、复检、摘要输出如何串起来。
   - 看 `loadWatchdogCandidates`：理解坏文件不阻断巡检的 fail-soft 策略。
3. `tests/watchdog.test.ts`
   - 看 dry-run / missing snapshot / still pending 场景，理解 watchdog 边界行为。

## 4. 验证结果
- `pnpm test`：通过（19 tests）。
- `pnpm build`：通过。
- `pnpm run:weekly:mock`：通过。
- `npx tsx src/cli.ts run --mode weekly --watch-pending-weekly --dry-run --generated-at 2026-03-09T05:00:00.000Z`：可预览将发布条目。
- `npx tsx src/cli.ts run --mode weekly --watch-pending-weekly --generated-at 2026-03-09T05:00:00.000Z`：可执行超时发布。

## 5. 3 分钟复盘模板（M3 版本）
```text
【1】本轮目标（30s）
- 我本轮要验证的能力点是：在不改动采集内容的前提下，系统能否自动批量处理 pending 周报并在超时后发布。
- 我完成后的可见结果是：新增 watchdog 巡检入口，可 dry-run 预览与实跑发布，并输出处理摘要。

【2】关键实现（60s）
- 我改了哪 3 个核心文件：
  1) `src/pipeline/watchdog.ts`
  2) `src/cli.ts`
  3) `src/core/review-artifact.ts`
- 每个文件“为什么要改”：
  - `watchdog.ts`：集中实现候选筛选、复检执行、摘要统计，避免 CLI 逻辑膨胀。
  - `cli.ts`：提供 `--watch-pending-weekly` / `--dry-run` 入口，打通扫描到落盘全流程。
  - `review-artifact.ts`：统一 artifact schema，复检与守护共享同一解析规则，减少重复定义。

【3】运行验证（45s）
- 我执行的命令：
  - `pnpm test`
  - `pnpm build`
  - `pnpm run:weekly:mock`
  - `npx tsx src/cli.ts run --mode weekly --watch-pending-weekly --dry-run --generated-at 2026-03-09T05:00:00.000Z`
- 结果是否符合预期：符合；watchdog 能正确识别 pending 周报并给出“将发布”结果，实跑后可落盘 published 产物。
- 有无 warning/边界场景：有，缺少 snapshot 的历史周报会标记 failed，不会阻断其他报告处理。

【4】设计取舍（30s）
- 我放弃了哪个方案，原因是：放弃“守护时重跑采集”，因为会造成审核版本与发布时间点内容漂移。
- 当前实现的风险点是：当前为顺序执行且无分布式锁，多实例并发运行时可能重复处理同一报告。

【5】下一步（15s）
- 我下一轮最小可执行目标是：为 watchdog 增加多实例互斥（锁）与失败重试策略，并接入基础告警。
```
