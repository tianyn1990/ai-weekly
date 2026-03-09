## ADDED Requirements
### Requirement: Pipeline SHALL apply adaptive load shedding for clustered missing_content failures
系统 SHALL 在 LLM item-wise 执行过程中监控短窗口失败模式；当 `missing_content` 失败出现簇状增长时，系统 SHALL 自动触发临时降载并优先重试失败条目，以降低失败扩散。

#### Scenario: Clustered missing_content failures trigger temporary degrade mode
- **WHEN** 短窗口内 `missing_content` 失败占比或连续失败次数达到阈值
- **THEN** 系统进入临时降载模式（降低并发预算）
- **AND** 对失败条目优先执行补偿重试

#### Scenario: Adaptive degrade mode recovers after stability returns
- **WHEN** 降载模式下短窗口成功率恢复到阈值以上
- **THEN** 系统自动恢复到配置并发预算
- **AND** 记录本次恢复事件用于后续诊断

#### Scenario: Adaptive strategy failure still keeps pipeline non-blocking
- **WHEN** 自适应降载与补偿重试后仍存在不可恢复错误
- **THEN** 系统继续执行既有回退策略（条目级或全局回退）
- **AND** 不阻断审核与发布主流程

### Requirement: Pipeline SHALL expose run-level LLM diagnostics for operations
系统 SHALL 为每次 run 输出可操作的 LLM 诊断信息，至少覆盖失败分类、重试统计、生效并发、自适应降载触发/恢复信息，便于快速定位问题主因。

#### Scenario: Diagnostics are persisted in artifact metadata
- **WHEN** run 完成并写入结构化产物
- **THEN** `llmSummaryMeta` 包含失败分类、重试统计与自适应降载统计
- **AND** 历史产物缺失新字段时读取路径保持兼容

#### Scenario: Diagnostics are visible in warning output
- **WHEN** LLM 过程中出现失败、重试或降载
- **THEN** warning 输出包含可读的分类统计与降载摘要
- **AND** 运维可以据此判断主要问题类型（timeout/http/missing_content/parse/quality）

### Requirement: Pipeline SHALL provide category lead summaries for report readability with non-blocking fallback
系统 SHALL 在报告中为主要分类提供“分类导读”区块，帮助用户在进入分类正文前快速理解该类重点；导读生成失败时 SHALL 使用模板导读回退。

#### Scenario: Category lead summary is generated for major categories
- **WHEN** 报告进入渲染阶段且分类正文存在内容
- **THEN** 系统为主要分类生成 1 句导读并展示在对应正文前
- **AND** 导读内容与该分类 Top 条目主题一致

#### Scenario: Category lead summary falls back to template on failure
- **WHEN** 分类导读生成失败或输出不合法
- **THEN** 系统使用模板导读文案
- **AND** 报告仍按原流程产出且不阻断审核/发布

## MODIFIED Requirements
### Requirement: Processing pipeline SHALL generate review artifacts with traceable metadata
系统 SHALL 在每次执行后产出待审核报告文件与结构化元数据文件，且关键状态文件可按配置进入 Git 同步路径，便于人工审核与后续发布；当启用 LLM 能力时，产物 SHALL 记录总结与排序辅助的执行元数据、融合结果、回退状态，以及自适应降载诊断信息。

#### Scenario: Review artifact records LLM assist metadata and score breakdown
- **WHEN** 本次 run 启用了 LLM 总结或排序辅助能力
- **THEN** 结构化产物包含对应执行元信息（provider/model/promptVersion/并发/回退统计）
- **AND** 条目可追溯规则分、LLM 分与融合后最终分

#### Scenario: Review artifact records adaptive-degrade diagnostics
- **WHEN** 本次 run 触发了自适应降载或恢复
- **THEN** 结构化产物记录降载触发计数、恢复计数、窗口统计与生效并发
- **AND** warning 中包含与该统计对应的可读摘要

#### Scenario: Recheck path remains compatible with optional LLM assist fields
- **WHEN** recheck 读取历史 artifact 且部分新字段缺失
- **THEN** 系统使用兼容逻辑继续运行
- **AND** 不因字段版本差异导致流程失败

### Requirement: Pipeline SHALL enforce provider-safe global LLM concurrency
系统 SHALL 在所有 LLM 节点执行期间施加全局并发上限，默认值为 2（可配置），并确保任意节点的本地并发不超过全局上限，以降低 provider 限流与失败抖动。

#### Scenario: Node concurrency is capped by global limit
- **WHEN** 某 LLM 节点配置并发大于全局并发上限
- **THEN** 系统实际并发取 `min(节点并发, 全局并发)`
- **AND** 运行元数据中可看到生效并发值

#### Scenario: Global default concurrency applies when config is missing
- **WHEN** 未显式配置全局并发上限
- **THEN** 系统采用默认值 `2`
- **AND** 节点并发仍受该默认值约束

#### Scenario: Multiple LLM steps do not exceed global concurrency budget
- **WHEN** 同一 run 内存在多个 LLM 子步骤连续执行
- **THEN** 系统仍遵守全局并发预算
- **AND** 不出现因并发叠加导致的无限放大请求
