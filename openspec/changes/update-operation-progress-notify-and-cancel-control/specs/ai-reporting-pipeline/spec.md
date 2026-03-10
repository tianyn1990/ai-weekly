## MODIFIED Requirements
### Requirement: System SHALL support manual operations via Feishu mention and operation card
系统 SHALL 支持在 Feishu 群内通过 @应用机器人获取主动触发操作卡，并通过卡片按钮触发常见运维动作；其中读类状态查询 SHALL 走直读路径，不得被异步队列阻塞。

#### Scenario: Mention bot returns operation card
- **WHEN** 用户在群内 @应用机器人并触发运维指令
- **THEN** 系统返回包含常见操作按钮的运维卡片
- **AND** 卡片至少支持日报/周报 run、recheck、watchdog、reminder、status 查询与中止入口

#### Scenario: Execution actions are enqueued asynchronously
- **WHEN** 用户点击运维卡片中的执行类动作（run/recheck/watchdog/reminder）
- **THEN** 系统先返回“已接收”反馈并创建 operation job
- **AND** 由后台 worker 异步执行该任务并回执最终结果

#### Scenario: Query status is served synchronously without queueing
- **WHEN** 用户点击 `query_status` 动作
- **THEN** 系统在回调处理链路内直接读取并返回当前状态
- **AND** 不创建 operation job
- **AND** 即使当前队列有长任务运行，状态查询仍可立即响应

#### Scenario: Manual daily run action is available in operation card
- **WHEN** 用户打开运维操作卡
- **THEN** 卡片包含 `run_daily` 动作入口（生成日报）
- **AND** 该动作沿用“入队异步执行 + 回执”流程

## ADDED Requirements
### Requirement: Operation jobs SHALL provide staged progress, failure notification, and cancel control
系统 SHALL 为运维执行类动作提供可观测的阶段通知、明确的失败通知与可中止控制，确保长任务可追踪、可止损。

#### Scenario: Accepted execution action emits queued and started notifications
- **WHEN** 用户点击执行类运维动作且受理成功
- **THEN** 系统先回执 `queued`（已受理入队）
- **AND** worker 开始执行时发送 `started` 通知

#### Scenario: Long-running operation emits bounded progress updates
- **WHEN** 执行类任务跨越多个关键阶段
- **THEN** 系统在关键阶段发送 `progress` 通知
- **AND** 通知数量受控，避免群内刷屏

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
