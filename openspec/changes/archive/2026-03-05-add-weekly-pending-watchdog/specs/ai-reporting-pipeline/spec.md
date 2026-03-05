## ADDED Requirements
### Requirement: Weekly pipeline SHALL provide watchdog scan for pending reports
系统 SHALL 提供 watchdog 扫描能力，用于批量检测并处理 pending 周报，以支持定时任务自动触发复检发布。

#### Scenario: Watchdog publishes timed-out pending weekly report
- **WHEN** watchdog 扫描到 `pending_review` 且已超过周一 12:30（Asia/Shanghai）的周报
- **THEN** 系统执行复检并发布该周报
- **AND** 发布状态更新为 `published`
- **AND** 审核状态更新为 `timeout_published`

#### Scenario: Watchdog skips pending weekly report before deadline
- **WHEN** watchdog 扫描到 `pending_review` 但尚未超过周一 12:30（Asia/Shanghai）的周报
- **THEN** 系统不发布该周报
- **AND** 在执行摘要中将该报告标记为 `skipped`

#### Scenario: Watchdog dry-run does not mutate artifacts
- **WHEN** 用户以 dry-run 模式执行 watchdog
- **THEN** 系统仅输出待处理报告列表与摘要
- **AND** 不修改任何 review 或 published 产物
