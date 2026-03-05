## MODIFIED Requirements
### Requirement: Weekly pipeline SHALL support human review gates before publish
系统 SHALL 在 weekly 模式提供审核断点，至少包含大纲审核与终稿审核两个阶段，并从持久化审核指令源读取审核动作；仅当未命中持久化指令时，才允许使用 CLI 参数作为兼容兜底输入。

#### Scenario: Weekly report applies persisted outline decision
- **WHEN** 指令源存在 `weekly + reportDate + outline_review` 的通过指令
- **THEN** 系统将大纲阶段标记为已通过
- **AND** 流程进入终稿审核阶段

#### Scenario: Weekly report uses CLI fallback when no persisted instruction exists
- **WHEN** 指令源未命中对应阶段审核指令
- **AND** 运行参数显式提供审核通过标记
- **THEN** 系统使用该参数作为该阶段审核结果
- **AND** 保持与现有 mock 学习命令兼容

## ADDED Requirements
### Requirement: Weekly pipeline SHALL support pending report recheck publish
系统 SHALL 支持对已生成的 pending 周报执行复检发布，不重新采集或重排内容，仅刷新审核状态、发布状态和最终产物。

#### Scenario: Pending weekly report is manually approved before deadline during recheck
- **WHEN** 待审核周报存在且指令源显示终稿已通过
- **AND** 当前时间未超过周一 12:30（Asia/Shanghai）
- **THEN** 系统将周报状态更新为 `approved`
- **AND** 系统发布该周报的已审核版本

#### Scenario: Pending weekly report is auto-published at deadline during recheck
- **WHEN** 待审核周报存在且当前时间超过周一 12:30（Asia/Shanghai）
- **AND** 指令源中终稿仍未通过
- **THEN** 系统将周报状态更新为 `timeout_published`
- **AND** 系统发布该周报当前版本并记录超时原因
