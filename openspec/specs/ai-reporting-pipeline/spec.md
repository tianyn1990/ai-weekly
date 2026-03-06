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
系统 SHALL 在 weekly 模式提供审核断点，至少包含大纲审核与终稿审核两个阶段，并从持久化审核指令源读取审核动作；审核指令源 SHALL 支持结构化回流 payload，并维持 last-write-wins 决策策略。

#### Scenario: Latest action with decidedAt wins for same stage
- **WHEN** 同一 reportDate 同一 stage 收到多条审核动作
- **THEN** 系统以最新 `decidedAt` 对应动作作为有效决策
- **AND** 旧动作保留在审计记录中

#### Scenario: Instruction source remains compatible with CLI fallback
- **WHEN** Feishu 回调不可用或动作写入失败
- **THEN** 系统允许 CLI 参数作为兼容兜底
- **AND** 不破坏既有超时自动发布策略

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
系统 SHALL 提供 watchdog 扫描能力，用于批量检测并处理 pending 周报，以支持定时任务自动触发复检发布；watchdog 执行过程 SHALL 具备单实例互斥、失败重试与结构化摘要输出。

#### Scenario: Watchdog exits when lock is already held
- **WHEN** watchdog 启动时发现 lock 文件已存在
- **THEN** 当前实例不执行扫描与复检
- **AND** 输出锁冲突提示并安全退出

#### Scenario: Watchdog retries transient recheck failure
- **WHEN** 某待处理周报在首次复检时发生可重试错误
- **THEN** watchdog 在配置次数内执行重试
- **AND** 若重试成功则该报告继续按成功路径统计

#### Scenario: Watchdog writes structured summary for monitoring
- **WHEN** watchdog 一次执行完成
- **THEN** 系统在 `outputs/watchdog/weekly/` 写入结构化 summary 文件
- **AND** summary 至少包含 processed、published、skipped、failed 与逐条结果

### Requirement: Weekly pipeline SHALL notify review status via Feishu
系统 SHALL 在周报关键节点向 Feishu 发送通知，包括待审核通知、截止提醒和发布结果回执。

#### Scenario: Weekly report sends review notification and deadline reminder
- **WHEN** 周一 09:00 生成周报待审核版本
- **THEN** 系统向 Feishu 发送待审核通知
- **AND** 系统在周一 11:30（Asia/Shanghai）发送一次截止前提醒通知

#### Scenario: Weekly report sends publish result callback
- **WHEN** 周报进入 `approved` 或 `timeout_published`
- **THEN** 系统向 Feishu 发送发布结果回执
- **AND** 回执包含 reportDate、reviewStatus、publishReason

#### Scenario: M3.2 callback endpoint uses local service plus tunnel
- **WHEN** 系统处于 M3.2 阶段并启用 Feishu 回调
- **THEN** 回调入口 SHALL 由本地 HTTP 服务提供并通过隧道代理暴露公网地址
- **AND** 回调请求仍需通过签名或令牌校验后才写入审核指令

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

