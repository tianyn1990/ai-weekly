# M4 学习复盘 04：daemon 自动化 + @机器人主动触发 + 自动 Git 同步

## 1. 本次实现了什么
- 新增 daemon 常驻运行模式：统一托管 scheduler、Feishu callback、operation worker。
- 新增 operation job 队列（DB）：
  - 支持任务入队、去重、重试、状态流转（pending/running/success/failed）。
- 新增 @机器人主动触发流程：
  - 群内提及机器人后下发“运维操作卡”；
  - 按钮动作入队异步执行，并在完成后推送结果回执。
- 审核动作回调自动推进：
  - `approve_outline/approve_final` 写入后自动入队 `recheck_weekly`，减少人工补命令。
- 新增自动 Git 同步执行器：
  - 对受控目录执行 `add/commit/push`；
  - 支持 push 代理环境变量注入。

## 2. 流程图（M4.3）
```text
daemon start
  -> scheduler tick（daily/weekly/reminder/watchdog enqueue）
  -> callback server（review action / mention / operation action）
  -> operation worker poll
  -> execute queued job
  -> feishu async result receipt
  -> optional git auto-sync
```

## 3. 源码导读（建议阅读顺序）
1. `src/cli.ts`
- 看 `runDaemon`：理解 scheduler、callback、worker 如何在一个进程协作。
- 看 `processOneOperationJob`：理解任务路由与失败重试回执。
- 看 `autoSyncOutputsIfNeeded`：理解“主流程不被 Git 失败阻断”的策略。

2. `src/daemon/operation-job-store.ts`
- 看 `enqueue/pickNextPending/markFailed`：理解队列幂等与重试状态机。

3. `src/daemon/scheduler.ts`
- 看 `computeDueScheduledJobs`：理解调度窗口与补偿触发判定。

4. `src/review/feishu.ts`
- 看 `parseCallbackBody`：理解 review action / operation action / mention event 三类回调统一解析。
- 看 `notifyOperationControlCard`：理解主动触发面板的动作契约。

5. `src/git/auto-sync.ts`
- 看 `autoSyncToGit`：理解受控目录变更检测与代理注入 push。

## 4. 验证结果
- `pnpm build`：通过。
- `pnpm test`：通过（20 files / 86 tests）。
- 新增测试覆盖：
  - `tests/operation-job-store.test.ts`
  - `tests/daemon-scheduler.test.ts`
  - `tests/operation-worker.test.ts`
  - `tests/git-auto-sync.test.ts`
  - `tests/feishu.test.ts`（新增 operation/mention 回调场景）
  - `tests/review-api-server.test.ts`（新增 operation-jobs 查询）

## 5. 3 分钟复盘模板（M4.3 版本）
```text
【1】本轮目标（30s）
- 我本轮要验证的能力点是：系统是否可以在后台自动运行，并支持飞书端主动触发运维动作。
- 我完成后的可见结果是：daemon 常驻后自动调度；@机器人可下发操作卡并异步执行任务；审核动作后自动 recheck。

【2】关键实现（60s）
- 我改了哪 3 个核心文件：
  1) `src/cli.ts`
  2) `src/review/feishu.ts`
  3) `src/daemon/operation-job-store.ts`
- 每个文件“为什么要改”：
  - `cli.ts`：把 scheduler/callback/worker 串成可运行的 daemon 主流程。
  - `feishu.ts`：扩展回调协议，支持 mention 与 operation action，并保持审核动作兼容。
  - `operation-job-store.ts`：提供可持久化、可重试、可去重的任务队列语义。

【3】运行验证（45s）
- 我执行的命令：
  - `pnpm test`
  - `pnpm build`
- 结果是否符合预期：符合，新增场景与全量回归均通过。
- 有无 warning/边界场景：
  - 有，Git push 失败不会中断主流程，仅输出 warning。
  - 有，非 DB 模式下主动触发队列不可用，会返回明确提示。

【4】设计取舍（30s）
- 我放弃了哪个方案，原因是：放弃“回调内直接执行业务长任务”，因为容易超时且难重试。
- 当前实现的风险点是：单机 daemon 无分布式选主；当前通过单进程串行与任务去重降低风险。

【5】下一步（15s）
- 我下一轮最小可执行目标是：进入 M5，接入 LLM 总结节点，并保持规则链路可回退。
```
