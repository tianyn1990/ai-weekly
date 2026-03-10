## Context
飞书运维动作目前统一进入 operation queue。优点是串行可控，但当某个任务长时间运行或异常卡住时，后续动作（包括状态查询）会排队等待，造成“点击没反应”的体验。

本次设计目标是提升可观测性与可控性，在不破坏现有异步架构的前提下实现：
1) 关键阶段有进度通知；
2) 失败有明确原因；
3) 支持人工中止；
4) 状态查询不受队列阻塞。

## Goals / Non-Goals
### Goals
- `query_status` 在飞书点击后秒级返回，不依赖 operation worker。
- 执行类动作提供阶段通知与失败通知，便于判断“正在做什么”。
- 提供显式 cancel 操作，支持对运行中 job 安全止损。
- 保持现有异步受理/最终回执机制与幂等策略兼容。

### Non-Goals
- 不在本次引入多 worker 并发执行。
- 不在本次实现任意节点强制 kill（仅协作式 cancel）。
- 不在本次调整报告生成业务规则（仅调整运维交互与控制面）。

## Decisions
### 1) 运维动作分流：读直读、写入队
- `query_status`：回调线程直接读取当前 reportDate 状态并回复，不创建 operation job。
- 其余动作：维持“创建 operation job + worker 异步执行”。

原因：
- 状态查询属于读操作，应优先满足可用性与低延迟。
- 执行类操作仍需要串行执行与统一审计。

### 2) 阶段通知模型
对执行类 action 建立标准生命周期事件：
- `queued`：已受理并入队
- `started`：worker 开始执行
- `progress`：关键阶段（例如 collect/classify/build/recheck/publish）
- `succeeded` / `failed` / `cancelled`：终态

通知策略：
- 保留当前“受理回执 + 终态回执”。
- 新增 `started` 与有限 `progress`，默认按关键节点触发，避免每条数据级别刷屏。

### 3) 取消机制（cooperative cancel）
- 新增 cancel action（卡片按钮）。
- DB 层为 operation job 记录 `cancel_requested_at/cancel_requested_by`。
- worker 在阶段边界检查 cancel 标记；命中后将 job 置为 `cancelled` 并发送回执。

原因：
- 避免直接终止进程带来的状态不一致。
- 保证可审计与幂等（重复点击 cancel 不产生重复终态）。

### 3.2) 硬中止执行步骤（hard cancel）
- 执行类长任务通过子进程运行，主 worker 负责生命周期管理。
- 收到 cancel 请求后，主 worker 立即向子进程发送 `SIGTERM`，若宽限期未退出再发送 `SIGKILL`。
- 为避免“中止后仍无法重提”，cancel 请求生效时立即清空该任务 dedupe 占位。

原因：
- 单进程内纯 Promise 任务难以强制中断；子进程模型可实现“当前步骤立即停止”。
- 提前释放 dedupe 占位可避免运维被“任务进行中”状态长时间阻塞。

### 3.1) 运行冲突控制（中止/重启）
- 当执行类动作入队时若命中“同类任务已 running/pending”，系统不重复入队同 dedupe 任务。
- 同时发送冲突控制通知，提供：
  - `cancel_current_operation`
  - `cancel_and_retry_operation(targetOperation=...)`
- `cancel_and_retry_operation` 会先登记 cancel，再创建一个新的重启任务（唯一 dedupe key）。

### 4) 失败通知分型
失败终态回执统一输出失败分类（示例）：
- `timeout`
- `upstream_http_error`
- `db_error`
- `validation_error`
- `cancelled_by_operator`
- `unknown`

原因：
- 让运维可快速判断是重试、降载还是人工介入。

## Risks / Trade-offs
- 风险：阶段通知增多导致群消息噪音。
  - 缓解：限制 progress 事件数量、同类阶段短窗口去重。
- 风险：cancel 请求与任务完成竞态。
  - 缓解：终态写入使用 compare-and-set，确保只落一个终态。
- 风险：直读路径可能绕过部分审计。
  - 缓解：query_status 仍写审计事件，但不创建 operation job。

## Migration Plan
1. 引入 operation action 分流层（sync read vs async job）。
2. 增加 job 生命周期事件与通知发送点。
3. 增加 cancel 数据字段与 worker 协作检查。
4. 回归测试：队列堵塞下 query_status 可立即返回；cancel 可中止并回执。

## Open Questions
- `progress` 默认是否仅推送 2-3 个关键节点（建议是）。
- cancel 是否允许指定 `jobId`（本次先支持“中止当前运行中任务”）。
