## ADDED Requirements

### Requirement: Weekly pipeline SHALL support human review gates before publish
系统 SHALL 在 weekly 模式提供审核断点，至少包含大纲审核与终稿审核两个阶段，并记录审核状态。

#### Scenario: Weekly report enters review state
- **WHEN** weekly 流程生成周报草稿
- **THEN** 系统状态进入 `pending_review`
- **AND** 输出产物中包含当前审核阶段与审核截止时间

#### Scenario: Weekly report is approved before deadline
- **WHEN** 审核人员在截止时间前完成终稿审核
- **THEN** 系统将状态更新为 `approved`
- **AND** 系统发布审核通过版本

### Requirement: Weekly pipeline SHALL auto-publish timeout review version at deadline
系统 SHALL 在周一 12:30（Asia/Shanghai）未完成审核时自动发布当前待审核版本，并标记为超时发布。

#### Scenario: Weekly review times out
- **WHEN** 当前时间超过周一 12:30（Asia/Shanghai）且状态仍未 `approved`
- **THEN** 系统发布当前版本
- **AND** 系统状态标记为 `timeout_published`
- **AND** 产物中记录触发时间与发布原因
