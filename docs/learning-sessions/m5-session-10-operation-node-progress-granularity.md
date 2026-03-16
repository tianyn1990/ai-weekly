# M5 学习复盘 10：节点级进度可观测 + 单任务进度卡 + 粒度治理

## 1. 本次实现了什么
- 新增子进程进度协议：pipeline 节点会输出结构化 `[op-progress]{json}` 事件。
- 主 worker 新增进度事件解析与分发：支持 `off/milestone/verbose` 三档粒度控制。
- 新增“单任务进度卡”机制：同一 `jobId` 持续 PATCH 更新，不再为每个节点重复发新卡。
- 新增降噪策略：进度事件去重、节流窗口、单任务更新上限。
- 新增运行态进度快照：`operation_jobs` payload 内嵌 `runtimeProgress`，供 `query_weekly_status` 直读。
- `query_weekly_status` 增强：返回 `phase/stage/node/elapsed/lastError` 等诊断上下文。

## 2. 流程图（本次增量）
```text
operation job (run/recheck/watchdog)
  -> spawn cli subprocess
  -> subprocess graph node start/end emits [op-progress]{json}
  -> worker parses progress event
  -> write runtimeProgress snapshot to operation_jobs payload
  -> notify strategy
      -> lifecycle: text receipt + progress card update
      -> progress: level gate(off/milestone/verbose) + throttle/dedupe + card patch
  -> query_weekly_status direct-read returns running node context
```

## 3. 源码导读（建议顺序）
1. `src/utils/operation-progress.ts`
- 定义 stdout 前缀协议、事件解析与 milestone 节点集合。

2. `src/pipeline/graph.ts`
- 对每个 node 增加 `start/end` 进度埋点，失败场景也会输出 `end(ok=false)`。

3. `src/cli.ts`
- `runQueuedCliSubprocess` 解析子进程进度事件。
- `notifyOperationEventBestEffort` 统一生命周期与进度通知分流。
- `queryWeeklyStatusDetail` 读取 `runtimeProgress` 输出可诊断状态。

4. `src/daemon/operation-job-store.ts`
- 新增 `updateRuntimeProgress`，把运行态快照写入 payload 并统计事件计数。

5. `src/review/feishu.ts`
- 新增 `upsertOperationProgressCard` 与进度卡构建函数。

## 4. 运行验证
- `pnpm test tests/operation-progress.test.ts tests/operation-job-store.test.ts tests/operation-worker.test.ts tests/feishu.test.ts`：通过。
- `pnpm test`：通过（32 files / 186 tests）。
- `pnpm build`：通过。

## 5. 设计取舍
- 为什么进度快照写入 `payload_json` 而不是新增表字段：
  - 先保证向后兼容与低迁移成本；后续若需要 SQL 查询优化再升级 schema。
- 为什么采用“单任务进度卡”而不是每节点发消息：
  - 节点级可见性提升的同时，控制群消息噪音与飞书 API 压力。
- 为什么默认 `milestone`：
  - `verbose` 更适合短时排障，日常运行优先稳定与可读性平衡。

## 6. 3 分钟复盘模板（已填写）
```text
【1】本轮目标（30s）
- 我本轮要验证的能力点是：让飞书运维链路可看到“当前节点进度”，并且不刷屏。
- 我完成后的可见结果是：同一 job 有一张持续更新的进度卡，query_status 能返回当前节点与耗时。

【2】关键实现（60s）
- 我改了哪 3 个核心文件：
  1) src/cli.ts
  2) src/review/feishu.ts
  3) src/daemon/operation-job-store.ts
- 每个文件“为什么要改”：
  - cli：打通子进程进度协议、粒度治理、查询增强。
  - feishu：实现单任务进度卡 upsert，承载高频进度。
  - job-store：持久化运行态快照，支持直读诊断。

【3】运行验证（45s）
- 我执行的命令：
  - pnpm test tests/operation-progress.test.ts tests/operation-job-store.test.ts tests/operation-worker.test.ts tests/feishu.test.ts
  - pnpm test
  - pnpm build
- 结果是否符合预期：符合。
- 有无 warning/边界场景：
  - verbose 模式事件较多，建议仅在排障时临时开启。

【4】设计取舍（30s）
- 我放弃了哪个方案，原因是：放弃“每节点单独文本回执”，因为噪音过高且不利于运维阅读。
- 当前实现的风险点是：运行态快照写在 payload_json，跨实例高频查询场景下检索效率一般。

【5】下一步（15s）
- 我下一轮最小可执行目标是：增加“节点卡住阈值告警”（例如 N 分钟未推进自动提示）。
```
