## MODIFIED Requirements
### Requirement: Weekly pipeline SHALL support human review gates before publish
系统 SHALL 在 weekly 模式提供单阶段终稿审核断点（`final_review`），并从持久化审核指令源读取审核动作；持久化源 SHALL 以 DB/API 为主，并维持结构化回流 payload 与 last-write-wins 决策策略。

#### Scenario: Weekly run enters single final review stage
- **WHEN** 生成 weekly 待审核稿
- **THEN** 系统状态进入 `final_review`
- **AND** 不再创建新的 `outline_review` 审核阶段

#### Scenario: Historical outline action remains compatible
- **WHEN** 系统收到历史动作 `approve_outline`
- **THEN** 系统返回兼容提示并引导使用终稿通过动作
- **AND** 不因历史动作导致流程崩溃或状态异常

### Requirement: Feishu review interaction SHALL provide stage-guided and user-readable experience
系统 SHALL 提供以审核者为中心的飞书交互体验；在单阶段审核模型下，主卡 SHALL 聚焦终稿审核动作，并在修订失败或中断时提供可恢复操作入口。

#### Scenario: Final review card shows single-stage actions only
- **WHEN** 周报处于 `final_review` 阶段
- **THEN** 主卡仅展示“终稿通过并发布 / 要求修订 / 拒绝本次”
- **AND** 主卡展示当前状态、下一步建议、截止时间与稿件链接

#### Scenario: Revision failure card provides recovery actions
- **WHEN** 修订流程失败或被护栏中断
- **THEN** 系统回执失败原因分类与已完成动作摘要
- **AND** 卡片提供“编辑后重试 / 继续执行 / 直接通过审核发布”入口

### Requirement: System SHALL auto-trigger recheck after accepted review action callback
系统 SHALL 在审核动作回调成功写入后自动触发对应 recheck 流程，避免人工补执行命令。

#### Scenario: Request revision callback auto-triggers revision recheck
- **WHEN** 回调写入 `request_revision` 且动作受理成功
- **THEN** 系统自动入队并执行修订流程
- **AND** 修订完成后状态仍回到 `final_review`

#### Scenario: Approve final callback auto-publishes after recheck
- **WHEN** 回调写入 `approve_final` 且动作受理成功
- **THEN** 系统自动触发 recheck job
- **AND** 在发布条件满足时完成发布并输出发布回执

### Requirement: Weekly pipeline SHALL execute feedback-driven revision loop
系统 SHALL 支持以“自由文本修订意见”为主输入的回流修订能力；修订执行 SHALL 采用受限 ReAct 循环（LLM 规划 + 工具执行 + 校验），并在完成后重新进入终稿审核。

#### Scenario: Free-text revision request is decomposed into multiple executable tasks
- **WHEN** 审核人提交一段包含多条诉求的修订意见
- **THEN** 系统将意见拆分为多个可执行任务
- **AND** 每个任务可映射到明确目标与操作类型

#### Scenario: Revision execution keeps report structure auditable
- **WHEN** 系统执行修订任务
- **THEN** 系统基于结构化快照执行 patch 与重建
- **AND** 输出 before/after 差异与审计日志
- **AND** 不通过“整篇 Markdown 直接重写”方式完成修订

## ADDED Requirements
### Requirement: Revision ReAct agent SHALL run within configurable bounded budget
系统 SHALL 为修订 ReAct 节点提供可配置运行护栏，至少包含最大步数、总流程超时、最大 LLM 调用次数与最大工具错误次数，超限后安全中断并保留可恢复上下文。

#### Scenario: Agent stops when wall-clock timeout is reached
- **WHEN** 修订 ReAct 流程运行时长超过 `REVISION_AGENT_MAX_WALL_CLOCK_MS`
- **THEN** 系统中断本次修订执行
- **AND** 返回 `wall_clock_timeout` 失败分类
- **AND** 默认总流程超时为 600000ms（10 分钟）

#### Scenario: Agent stops when step budget is exhausted
- **WHEN** ReAct 执行步数达到 `REVISION_AGENT_MAX_STEPS`
- **THEN** 系统中断执行并返回 `step_limit_reached`
- **AND** 默认最大步数为 20（可配置）

### Requirement: Revision planner SHALL produce strict JSON plan with retry and validation
修订 Planner SHALL 以严格 JSON contract 输出任务计划，禁止 markdown/code fence/解释文本；当发生超时、限流、5xx、可修复 JSON 失败时 SHALL 执行重试与退避，重试失败后返回可读失败原因。

#### Scenario: Planner output passes JSON schema and maps to executable tasks
- **WHEN** Planner 成功返回修订计划
- **THEN** 计划可通过 `JSON.parse` 与 schema 校验
- **AND** 每个任务包含目标定位、操作类型、参数与置信度

#### Scenario: Planner retries on transient provider failures
- **WHEN** Planner 调用出现 timeout/429/5xx 或可修复 JSON 失败
- **THEN** 系统执行重试与退避
- **AND** 若最终失败返回 `planning_failed` 及原因摘要

### Requirement: Revision workflow SHALL support recoverable failure handling and operator override
系统 SHALL 在修订失败或部分失败时提供可恢复机制与人工覆盖路径，确保流程不中断且可继续推进。

#### Scenario: Operator can edit prompt and retry failed revision
- **WHEN** 修订执行失败且用户选择“编辑后重试”
- **THEN** 系统允许用户修改意见文本并重新发起修订
- **AND** 新请求沿用同一报告上下文进行执行

#### Scenario: Operator can continue from checkpoint
- **WHEN** 修订在中途因护栏或临时错误中断
- **THEN** 系统允许从最近 checkpoint 继续执行未完成任务
- **AND** 已成功任务不重复执行

#### Scenario: Operator can bypass revision and directly approve publish
- **WHEN** 修订失败但审核人确认可直接发布
- **THEN** 系统允许执行“终稿通过并发布”动作
- **AND** 审计日志记录该人工覆盖决策与失败上下文
