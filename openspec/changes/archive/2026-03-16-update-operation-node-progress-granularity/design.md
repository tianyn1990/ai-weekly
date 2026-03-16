## Context
当前系统已实现运维任务生命周期通知与中止控制，但 `progress` 事件主要描述“任务开始执行某类操作”，缺乏 pipeline 节点级可见性。
在周报/日报 run 任务中，用户无法快速判断：
1) 当前处于哪个节点；
2) 是否仍在推进；
3) 是否应继续等待或手动中止。

另一方面，直接按“每节点发一条文本消息”会显著增加群噪音，不符合运维可读性目标。

## Goals / Non-Goals
### Goals
- 在不破坏现有异步队列架构下，提供节点级运行可观测能力。
- 通过可配置粒度在“可见性”和“噪音控制”之间取得平衡。
- 用“单任务进度卡”承载高频进度更新，文本消息只保留关键状态。
- `query_status` 能返回“当前节点 + 耗时 + 最近错误”的可诊断信息。

### Non-Goals
- 不改变当前单 worker 串行执行模型。
- 不引入新的外部可观测系统（如 Prometheus/Grafana）。
- 不在本次改动中重构报告业务规则（采集/排序/审核判定逻辑保持不变）。

## Decisions
### 1) 进度事件模型
定义统一 OperationProgressEvent（逻辑模型）：
- `jobId`
- `operation`
- `lifecycle`：`queued|started|progress|success|failed|cancelled`
- `phase`：`operation|pipeline`
- `nodeKey`：如 `collect_items`、`llm_classify_score`、`llm_summarize`
- `nodeState`：`start|end`
- `detail`
- `elapsedMs`
- `createdAt`

说明：
- lifecycle 与 pipeline node 解耦，避免后续扩展（recheck/watchdog）时复用困难。
- 对非 run 任务可仅使用 operation phase，不强制 nodeKey。

### 2) 通知粒度策略（可配置）
新增配置：
- `OP_PROGRESS_NOTIFY_LEVEL=off|milestone|verbose`（默认 `milestone`）
- `OP_PROGRESS_CARD_ENABLED=true|false`（默认 `true`）
- `OP_PROGRESS_NOTIFY_THROTTLE_MS`（默认 15000）
- `OP_PROGRESS_NOTIFY_MAX_UPDATES`（默认 20）

行为：
- `off`：仅发送 `queued/started/success/failed/cancelled`。
- `milestone`：发送生命周期 + 关键节点（默认：collect、llm_classify_score、rank、llm_summarize、build_report、publish_or_wait）。
- `verbose`：发送生命周期 + 全节点 start/end。

### 3) 子进程进度上报协议
run/recheck/watchdog 等执行类任务当前通过子进程运行。为获得节点进度：
- 子进程 stdout 输出结构化进度行（约定前缀，例如 `[op-progress] {json}`）。
- 主 worker 仅解析该前缀行并转换为 OperationProgressEvent。
- 非协议日志忽略，不影响现有日志输出。

这样可避免把回调接口直接穿透到 graph 内部，降低耦合。

### 4) 飞书通知落地形态
- 每个 `jobId` 维护一张“运行进度卡”（存储 messageId）。
- 进度事件优先 PATCH 该卡，不重复发送新卡。
- 文本消息仅用于：
  - 任务受理（queued）
  - 任务开始（started）
  - 任务终态（success/failed/cancelled）
  - 冲突控制/中止交互

降级策略：
- 若卡片 PATCH 失败，则尝试补发新卡并覆盖 messageId。
- 若补发失败，仅记录 warning，不阻断主流程。

### 5) 降噪与幂等
- 事件去重键：`jobId + lifecycle + phase + nodeKey + nodeState`。
- 时间节流：同一签名事件在 `THROTTLE_MS` 内不重复通知。
- 更新上限：单 job 超过 `MAX_UPDATES` 后，仅保留终态更新。

### 6) 状态查询增强
`query_status` 继续保持“回调直读不入队”，并新增字段：
- `runningJobId`
- `currentPhase/currentNode`
- `elapsed`
- `lastProgressAt`
- `lastError`（若有）

用于快速区分“正常推进”与“卡住/异常”。

## Risks / Trade-offs
- 风险：verbose 模式下飞书 API 调用数上升。
  - 缓解：节流 + 单任务更新上限 + 默认 milestone。
- 风险：子进程进度协议解析失败导致可观测空洞。
  - 缓解：协议解析失败只记 warning，不影响任务执行。
- 风险：进度卡 messageId 丢失导致更新失败。
  - 缓解：失败自动补发新卡并重建映射。

## Migration Plan
1. 定义进度事件模型与存储结构（最小可用字段）。
2. 为 run 任务接入子进程进度上报协议。
3. 接入飞书单任务进度卡更新与降噪策略。
4. 增强 `query_status` 输出，暴露当前节点与耗时。
5. 完成回归测试与文档同步。

## Open Questions
- milestone 默认节点集合是否需要按 `daily/weekly` 区分。
- 是否在后续阶段加入“卡住检测阈值告警”（例如节点超过 N 分钟未前进）。
