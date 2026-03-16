## MODIFIED Requirements
### Requirement: Feishu review interaction SHALL provide stage-guided and user-readable experience
系统 SHALL 提供以审核者为中心的飞书交互体验；在终稿审核场景中，“要求修订”动作 SHALL 支持自由文本修订输入，并在修订失败或中断时提供可恢复操作入口。

#### Scenario: Request revision opens structured form instead of fixed reason-only action
- **WHEN** 周报处于 `final_review` 且审核人点击“要求修订”
- **THEN** 系统展示修订表单并要求填写 `revisionRequest`
- **AND** 表单可选填写 `revisionScope`、`revisionIntent`、`continueFromCheckpoint`
- **AND** 回调 payload 以 `feedback` 结构写入审核指令

#### Scenario: Legacy reason-only revision action remains backward-compatible
- **WHEN** 系统收到历史 `request_revision` 回调且仅包含 `reason`
- **THEN** 系统仍受理该动作并进入修订流程
- **AND** 后端可将 `reason` 兼容映射为修订请求文本

#### Scenario: Revision failure response provides recovery actions
- **WHEN** 修订流程失败或被护栏中断
- **THEN** 系统回执失败分类与失败摘要
- **AND** 回执卡提供“编辑后重试 / 继续执行 / 直接通过并发布”入口

### Requirement: System SHALL auto-trigger recheck after accepted review action callback
系统 SHALL 在审核动作回调成功写入后自动触发对应 recheck 流程，避免人工补执行命令；自动触发任务 SHALL 对审核人可见关键进度与终态。

#### Scenario: Request revision callback auto-triggers visible recheck
- **WHEN** 回调写入 `request_revision` 且动作受理成功
- **THEN** 系统自动入队 `recheck_weekly`
- **AND** 飞书可见该任务的 `queued/started/progress/success|failed|cancelled` 关键状态

#### Scenario: Auto recheck still updates review card after completion
- **WHEN** 自动 recheck 完成并仍处于待审核状态
- **THEN** 系统更新主审核卡内容（而非静默无反馈）
- **AND** 终态回执可区分“修订已应用”与“修订失败需处理”

### Requirement: Weekly pipeline SHALL execute feedback-driven revision loop
系统 SHALL 支持以自由文本为主的回流修订能力；修订执行 SHALL 采用受限 ReAct 循环，并在失败时返回可恢复上下文。

#### Scenario: Revision form feedback is consumed by ReAct planner
- **WHEN** `feedback.revisionRequest` 存在
- **THEN** Planner 以该文本作为主要任务拆解输入
- **AND** 可结合 `revisionScope` 与 `revisionIntent` 提升任务定位准确性

#### Scenario: Continue-from-checkpoint resumes unfinished revision tasks
- **WHEN** 修订请求携带 `continueFromCheckpoint=true`
- **THEN** 系统优先恢复 checkpoint 中未完成任务
- **AND** 已完成任务不重复执行

## ADDED Requirements
### Requirement: Auto recheck SHALL be protected by bounded wall-clock timeout
系统 SHALL 对自动 recheck 子进程执行设置总时长护栏，超过阈值时安全中断并输出可诊断失败分类，避免任务长期 `running` 无终态。

#### Scenario: Auto recheck is terminated when wall-clock timeout is exceeded
- **WHEN** 自动 recheck 运行时间超过配置阈值
- **THEN** 系统终止该任务并标记失败
- **AND** 失败分类包含 `subprocess_timeout`
- **AND** 飞书回执包含可读错误摘要

#### Scenario: Timeout handling remains compatible with manual cancel
- **WHEN** 任务已收到人工中止请求且同时接近超时阈值
- **THEN** 系统仅落一个终态（`cancelled` 或 `failed`）
- **AND** 不产生重复终态通知

### Requirement: Revision feedback contract SHALL be explicit and validated at callback boundary
系统 SHALL 在回调边界校验修订 feedback contract，确保 `revisionRequest` 与可选字段结构合法，非法输入应即时失败并返回可读提示。

#### Scenario: Invalid revision feedback is rejected at callback layer
- **WHEN** 回调提交的 `feedback` 不满足 schema（例如字段类型错误或缺失必要信息）
- **THEN** 系统拒绝受理该动作
- **AND** 返回可读错误提示，且不写入无效审核指令

#### Scenario: Valid revision feedback is persisted for audit and replay
- **WHEN** 回调提交的 `feedback` 通过校验
- **THEN** 系统将其随审核指令持久化
- **AND** 后续 recheck 与审计查询可重放该输入上下文
