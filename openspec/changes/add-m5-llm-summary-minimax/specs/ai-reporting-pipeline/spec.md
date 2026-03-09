## ADDED Requirements
### Requirement: Pipeline SHALL support item-wise LLM summarization for both daily and weekly reports
系统 SHALL 在 `daily` 与 `weekly` 两种模式下启用 LLM 总结节点，并采用“逐条总结 + 聚合重点”策略，禁止将全部候选内容一次性作为单个 prompt 输入。

#### Scenario: Item-wise summarization is executed instead of one-shot full-batch prompt
- **WHEN** 流水线进入 LLM 总结阶段且存在候选条目
- **THEN** 系统按条目粒度生成结构化摘要结果（可并发但逻辑独立）
- **AND** 不将全量候选正文拼接为单个超长 prompt 做一次性总结

#### Scenario: Quick digest count is adaptive within 4-12
- **WHEN** 系统基于逐条摘要生成顶部快速重点
- **THEN** 输出条目数在 `4-12` 区间内自适应
- **AND** 条目数量随候选规模变化而调整

#### Scenario: Daily mode also receives LLM summary enhancement
- **WHEN** 用户执行 `daily` 报告流程
- **THEN** 系统同样执行 LLM 总结节点
- **AND** 在报告中输出快速重点与结构化摘要（或回退结果）

### Requirement: LLM summary provider SHALL use MiniMax first with strict fallback safety
系统 SHALL 优先支持 MiniMax 作为 M5.1 的首发 provider，并在调用失败、超时、解析失败或证据校验失败时自动回退到规则摘要，且不得阻断审核与发布主流程。

#### Scenario: MiniMax summary succeeds
- **WHEN** MiniMax 配置完整且调用成功
- **THEN** 报告优先使用 LLM 生成的摘要内容
- **AND** 审计记录包含 provider/model/promptVersion/耗时等元信息

#### Scenario: LLM failure triggers non-blocking fallback
- **WHEN** MiniMax 调用异常、超时、响应不合法或证据校验失败
- **THEN** 系统自动回退到规则摘要并继续完成 run/recheck/watchdog 后续流程
- **AND** 不因 LLM 失败导致 pending/review/publish 状态机中断

### Requirement: LLM output SHALL be evidence-bound and auditable
系统 SHALL 对 LLM 输出执行结构化校验与证据绑定校验，确保摘要结论可追溯到本次输入条目，并将关键执行状态写入审计存储。

#### Scenario: Evidence validation rejects unsupported claims
- **WHEN** 某条 LLM 摘要引用的 evidenceItemId 不存在于本次 `rankedItems`
- **THEN** 该次 LLM 输出判定为无效并触发回退
- **AND** 审计中记录失败类型为证据校验失败

#### Scenario: Audit trail records full LLM summary lifecycle
- **WHEN** 一次 LLM 总结执行完成（成功或失败）
- **THEN** 系统写入 started/completed/fallback 审计事件
- **AND** 事件可按 runId/reportDate 追溯

### Requirement: System SHALL send one merged Feishu alert for LLM fallback per run
系统 SHALL 在单次 run 出现 LLM 降级时发送飞书告警，但按 run 维度合并为 1 条，避免重复刷屏。

#### Scenario: Multiple fallback errors in one run produce one merged alert
- **WHEN** 同一 run 内出现多次 LLM 失败或回退事件
- **THEN** 系统只发送 1 条合并告警到飞书
- **AND** 告警包含 runId/reportDate/降级原因摘要

#### Scenario: No alert when LLM completes successfully
- **WHEN** 同一 run 的 LLM 总结链路未触发回退
- **THEN** 系统不发送降级告警
- **AND** 飞书仅保留常规审核/发布通知

## MODIFIED Requirements
### Requirement: Processing pipeline SHALL generate review artifacts with traceable metadata
系统 SHALL 在每次执行后产出待审核报告文件与结构化元数据文件，且关键状态文件可按配置进入 Git 同步路径，便于人工审核与后续发布；当启用 LLM 总结时，产物 SHALL 记录 LLM 执行元数据与回退状态。

#### Scenario: Review artifact includes LLM summary metadata when enabled
- **WHEN** 本次 run 启用了 LLM 总结能力
- **THEN** 结构化产物包含 LLM 执行元信息（provider/model/promptVersion/是否回退）
- **AND** 该信息可被后续 recheck 与审计流程读取

#### Scenario: Review artifacts become remotely reviewable after git sync
- **WHEN** 周报产物写入受控目录并触发自动 git 同步成功
- **THEN** 审核人可通过仓库链接访问对应内容
- **AND** 飞书通知中的可点击链接指向已同步版本
