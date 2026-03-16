# Change: 运维任务节点级进度可观测与通知粒度治理

## Why
当前飞书运维通知已具备 `queued/started/progress/success/failed/cancelled` 生命周期回执，但 `progress` 仍是任务级粗粒度，无法定位“当前卡在哪个 pipeline 节点”。
在 run 任务耗时较长（特别是 LLM 节点）时，用户只能看到“执行中”，难以判断是否正常推进，排障与中止决策成本较高。

同时，若直接把每个节点都发成独立文本通知，会带来明显刷屏问题，影响群内可读性。

## What Changes
- 为 operation 执行链路增加“节点级进度事件”模型，覆盖 run 类任务关键节点（可扩展到完整节点 start/end）。
- 引入可配置通知粒度：
  - `off`：仅生命周期终态（queued/started/finished）。
  - `milestone`：仅关键里程碑节点（默认）。
  - `verbose`：节点级 start/end 全量进度。
- 引入“单任务进度卡”机制：
  - 每个 job 仅维护一张进度卡，随阶段推进 PATCH 更新，避免重复发消息。
  - 文本回执仅保留关键生命周期与终态，进度细节沉淀到卡片。
- 增加通知降噪治理：阶段去重、时间节流、单任务更新上限。
- 强化 `query_status` 直读结果：返回运行中 job 的当前阶段/节点、耗时与最近错误摘要。

## Impact
- Affected specs:
  - `ai-reporting-pipeline`
- Affected code (planned):
  - `src/cli.ts`（operation worker、子进程进度上报、状态查询增强）
  - `src/daemon/worker.ts`（进度事件协议扩展）
  - `src/review/feishu.ts`（进度卡构建与单卡更新）
  - `src/pipeline/graph.ts` / `src/pipeline/nodes.ts`（节点事件埋点）
  - `src/daemon/operation-job-store.ts`（运行态进度快照持久化）
  - `tests/operation-worker.test.ts`、`tests/feishu.test.ts`、`tests/review-api-server.test.ts`
- Docs to update during implementation:
  - `docs/PRD.md`
  - `docs/architecture.md`
  - `docs/learning-workflow.md`
  - `docs/learning-sessions/*`（新增本迭代复盘文档并填写 3 分钟复盘）
- Risks:
  - 节点事件过多可能造成飞书 API 压力与通知噪音。
  - 子进程上报协议若设计不稳，可能导致主 worker 解析失败。
  - 进度卡更新失败时需要明确降级策略，避免影响主流程。
