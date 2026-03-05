# ai-reporting-pipeline Specification

## Purpose
定义 AI 日报/周报流水线的可执行行为基线，明确从采集、处理、审核到发布的状态流转，并约束超时自动发布与失败容错策略，确保系统可验证、可追踪、可持续迭代。
## Requirements
### Requirement: Pipeline CLI SHALL support daily/weekly report generation
系统 SHALL 提供统一 CLI 入口，用于触发 `daily` 或 `weekly` 模式的报告生成，并支持 `mock` 数据模式用于学习与调试。

#### Scenario: Run weekly report in mock mode
- **WHEN** 用户执行 `pnpm run:weekly:mock`
- **THEN** 系统完成一次 `weekly` 流程执行并输出报告文件
- **AND** 处理链路包含 collect、normalize、dedupe、classify、rank、build_report 节点

#### Scenario: Run daily report in live mode
- **WHEN** 用户执行 `pnpm run:daily`
- **THEN** 系统按已启用来源抓取并生成 `daily` 报告
- **AND** 即使部分来源失败，流程仍可结束并产出结果

### Requirement: Processing pipeline SHALL generate review artifacts with traceable metadata
系统 SHALL 在每次执行后产出待审核报告文件与结构化元数据文件，便于人工审核与后续发布。

#### Scenario: Write markdown and json artifacts
- **WHEN** 一次报告流程执行完成
- **THEN** 系统在 `outputs/review/{mode}/` 写入 `YYYY-MM-DD.md`
- **AND** 系统在同目录写入 `YYYY-MM-DD.json`
- **AND** JSON 至少包含 runId、mode、metrics、highlights、warnings

### Requirement: Weekly review report SHALL include review deadline policy
系统 SHALL 在周报待审核文稿中体现人工审核窗口和自动发布兜底规则。

#### Scenario: Weekly report includes timeout publish rule
- **WHEN** 生成 `weekly` 模式的待审核文稿
- **THEN** 文稿包含周一 12:30（北京时间）审核截止信息
- **AND** 文稿明确截止前未审核将自动发布当前版本

### Requirement: Pipeline SHALL record warnings for source failures
系统 SHALL 对来源抓取失败进行 warning 记录，而不是直接中断整个流程。

#### Scenario: One source feed is unavailable
- **WHEN** 某来源返回 HTTP 异常或解析异常
- **THEN** 系统将失败信息写入 `warnings`
- **AND** 系统继续处理其他来源并输出最终报告

### Requirement: Classification SHALL include dedicated agent category
系统 SHALL 在分类阶段提供独立 `agent` 分类，用于承载 Agent 工程实践相关内容，并与 `tooling` 分类分离。

#### Scenario: Agent-related content is classified into agent
- **WHEN** 条目标题或摘要包含 `agent` 或 `agentic` 关键词
- **THEN** 条目分类结果为 `agent`
- **AND** 分类统计中包含 `agent` 维度

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

### Requirement: Weekly pipeline SHALL auto-publish timeout review version at deadline
系统 SHALL 在周一 12:30（Asia/Shanghai）未完成审核时自动发布当前待审核版本，并标记为超时发布。

#### Scenario: Weekly review times out
- **WHEN** 当前时间超过周一 12:30（Asia/Shanghai）且状态仍未 `approved`
- **THEN** 系统发布当前版本
- **AND** 系统状态标记为 `timeout_published`
- **AND** 产物中记录触发时间与发布原因

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

