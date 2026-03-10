# Change: 运维任务阶段通知、失败通知、中止能力与状态直读优化

## Why
当前飞书运维动作采用“统一入队异步执行”策略，长任务在执行过程中缺乏阶段性可见性，用户容易误判为“无响应”或“卡死”。
同时，`查询本期状态` 也走同一队列，前置任务卡住时会导致状态查询不可用；且缺少“中止本次运行”入口，不利于止损与快速恢复。

## What Changes
- 将飞书运维动作拆分为两类：
  - 读类动作（`query_status`）改为回调直读，不入队。
  - 执行类动作（`run/recheck/watchdog/reminder`）继续入队异步执行。
- 为执行类动作增加阶段通知与失败通知：
  - 至少覆盖 `queued`、`started`、关键阶段进展、`succeeded/failed/cancelled`。
  - 失败通知提供结构化失败原因摘要。
- 增加“中止本次运行”按钮与取消机制：
  - 支持对当前运行中 operation job 发起 cancel 请求。
  - worker 支持硬中止当前执行步骤（子进程 `SIGTERM/SIGKILL`）。
- 当触发执行类动作时若发现同类任务已在运行中：
  - 发送冲突控制通知。
  - 提供“中止当前任务 / 中止并重新开始”双入口。
- 保持现有“点击即受理回执 + 最终结果回执”兼容，新增通知不破坏既有机器人交互。

## Impact
- Affected specs:
  - `ai-reporting-pipeline`
- Affected code (planned):
  - `src/review/feishu.ts`
  - `src/review/review-db.ts`（operation_jobs 状态/取消标记）
  - `src/daemon/*`（worker 执行与阶段回执）
  - `src/pipeline/*`（阶段事件上报点）
  - `tests/feishu.test.ts`
  - `tests/*operation*` / `tests/*daemon*`
- Risks:
  - 阶段通知过多可能造成群内噪音，需要控制通知粒度与去重。
  - cancel 为协作式中止，需保证状态一致性（避免“已中止但仍回执成功”）。
