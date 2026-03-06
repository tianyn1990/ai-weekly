## ADDED Requirements
### Requirement: Weekly pipeline SHALL execute feedback-driven revision loop
系统 SHALL 支持审核意见回流修订能力，在保留原有待审核快照基础上执行结构化调整，并在修订完成后重新进入终稿审核。

#### Scenario: Execute structured revision directives after request_revision
- **WHEN** 审核人提交 `request_revision` 且包含结构化回流指令
- **THEN** 系统基于当前待审核快照执行候选增删与规则调整
- **AND** 系统输出修订审计摘要
- **AND** 报告状态进入 `final_review`

#### Scenario: Persist global tuning from revision directives
- **WHEN** 回流指令包含来源启停、来源权重或排序权重调整
- **THEN** 系统将该调整写入全局配置存储
- **AND** 后续周期 run 读取并生效

#### Scenario: Keep editor notes as non-executable audit metadata
- **WHEN** 回流指令包含 `editor_notes`
- **THEN** 系统记录该备注到审计日志
- **AND** 不将其作为自动执行动作

### Requirement: Reject action SHALL terminate current run publication attempt
系统 SHALL 在收到 `reject` 动作后终止当前 run 的发布尝试，并要求新建 run 才能重新进入发布流程。

#### Scenario: Recheck/watchdog must not publish rejected run
- **WHEN** 某 reportDate 的当前 run 已被标记为 `rejected`
- **THEN** recheck 与 watchdog 不得继续推进该 run 到 published
- **AND** 系统输出明确的终止原因

#### Scenario: New run can re-enter review flow after reject
- **WHEN** 用户为同一 reportDate 触发新 run（runId 不同）
- **THEN** 系统允许新 run 正常进入审核与发布流程
- **AND** 旧 run 保持可追溯且不被覆盖

## MODIFIED Requirements
### Requirement: Weekly pipeline SHALL support human review gates before publish
系统 SHALL 在 weekly 模式提供审核断点，至少包含大纲审核与终稿审核两个阶段，并从持久化审核指令源读取审核动作；审核指令源 SHALL 支持结构化回流 payload，并维持 last-write-wins 决策策略。

#### Scenario: Latest action with decidedAt wins for same stage
- **WHEN** 同一 reportDate 同一 stage 收到多条审核动作
- **THEN** 系统以最新 `decidedAt` 对应动作作为有效决策
- **AND** 旧动作保留在审计记录中

#### Scenario: Instruction source remains compatible with CLI fallback
- **WHEN** Feishu 回调不可用或动作写入失败
- **THEN** 系统允许 CLI 参数作为兼容兜底
- **AND** 不破坏既有超时自动发布策略
