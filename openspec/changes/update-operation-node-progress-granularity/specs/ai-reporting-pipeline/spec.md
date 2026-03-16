## MODIFIED Requirements
### Requirement: System SHALL support manual operations via Feishu mention and operation card
系统 SHALL 支持在 Feishu 群内通过 @应用机器人获取主动触发操作卡，并通过卡片按钮触发常见运维动作；其中读类状态查询 SHALL 走直读路径，不得被异步队列阻塞，并应返回运行中任务的关键进度上下文。

#### Scenario: Mention bot returns operation card
- **WHEN** 用户在群内 @应用机器人并触发运维指令
- **THEN** 系统返回包含常见操作按钮的运维卡片
- **AND** 卡片至少支持日报/周报 run、recheck、watchdog、reminder、status 查询与中止入口

#### Scenario: Execution actions are enqueued asynchronously
- **WHEN** 用户点击运维卡片中的执行类动作（run/recheck/watchdog/reminder）
- **THEN** 系统先返回“已接收”反馈并创建 operation job
- **AND** 由后台 worker 异步执行该任务并回执最终结果

#### Scenario: Query status is served synchronously with running-progress context
- **WHEN** 用户点击 `query_status` 动作
- **THEN** 系统在回调处理链路内直接读取并返回当前状态
- **AND** 不创建 operation job
- **AND** 即使当前队列有长任务运行，状态查询仍可立即响应
- **AND** 若存在运行中任务，返回内容包含当前阶段/节点、运行耗时与最近错误摘要

#### Scenario: Manual daily run action is available in operation card
- **WHEN** 用户打开运维操作卡
- **THEN** 卡片包含 `run_daily` 动作入口（生成日报）
- **AND** 该动作沿用“入队异步执行 + 回执”流程

### Requirement: Operation jobs SHALL provide staged progress, failure notification, and cancel control
系统 SHALL 为运维执行类动作提供可观测的阶段通知、明确的失败通知与可中止控制，确保长任务可追踪、可止损；进度通知 SHALL 支持可配置粒度，并以单任务进度卡承载高频更新。

#### Scenario: Accepted execution action emits queued and started notifications
- **WHEN** 用户点击执行类运维动作且受理成功
- **THEN** 系统先回执 `queued`（已受理入队）
- **AND** worker 开始执行时发送 `started` 通知

#### Scenario: Off level emits lifecycle-only notifications
- **WHEN** `OP_PROGRESS_NOTIFY_LEVEL=off`
- **THEN** 系统仅发送生命周期关键通知（queued/started/终态）
- **AND** 不发送节点级 `progress` 通知

#### Scenario: Milestone level emits bounded key-node progress updates
- **WHEN** `OP_PROGRESS_NOTIFY_LEVEL=milestone` 且执行类任务跨越关键节点
- **THEN** 系统在关键节点发送 `progress` 更新
- **AND** 更新数量受控，避免群内刷屏

#### Scenario: Verbose level emits pipeline node start/end progress for run jobs
- **WHEN** `OP_PROGRESS_NOTIFY_LEVEL=verbose` 且执行 `run_daily` 或 `run_weekly`
- **THEN** 系统对 pipeline 节点输出 `start/end` 进度事件
- **AND** 节点至少覆盖 collect、normalize、dedupe、llm_classify_score、rank、llm_summarize、build_report、publish_or_wait

#### Scenario: Progress updates are upserted to a single live card per job
- **WHEN** 同一 `jobId` 在执行过程中产生多个进度事件
- **THEN** 系统优先 PATCH 同一张进度卡
- **AND** 不为每个进度事件重复发送新卡片

#### Scenario: Progress notifications are throttled and deduplicated
- **WHEN** 同一阶段或同一节点短时间重复上报
- **THEN** 系统按去重键与节流窗口合并通知
- **AND** 单任务更新次数超过上限后仅保留终态通知

#### Scenario: Failed operation emits reasoned failure notification
- **WHEN** 执行类任务失败
- **THEN** 系统发送 `failed` 通知
- **AND** 通知包含失败分类与简要原因（如 timeout/http/db/validation/cancelled/unknown）

#### Scenario: Operator can cancel running operation job from card
- **WHEN** 用户点击“中止本次运行”且存在运行中 operation job
- **THEN** 系统记录 cancel 请求并尽快终止当前执行步骤
- **AND** 任务终态为 `cancelled` 并发送回执

#### Scenario: Hard cancel stops current running step immediately
- **WHEN** 执行类任务已进入长步骤且收到 cancel 请求
- **THEN** worker 对当前任务子进程执行终止信号（先 `SIGTERM`，超时后 `SIGKILL`）
- **AND** 当前步骤立即停止并回执 `cancelled`
- **AND** 释放同类任务去重占位，允许后续重试入队

#### Scenario: Cancel action is idempotent
- **WHEN** 用户重复点击“中止本次运行”或任务已进入终态
- **THEN** 系统返回幂等提示
- **AND** 不产生重复终态通知

#### Scenario: Duplicate start request while job is running emits conflict control notification
- **WHEN** 用户触发执行类动作且同类任务已处于 `running/pending`
- **THEN** 系统返回“任务已在运行中”提示
- **AND** 发送冲突控制通知，包含“中止当前任务”与“中止并重新开始”操作入口
- **AND** 该能力对 `run_daily` 与 `run_weekly` 均生效
