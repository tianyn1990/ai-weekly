## ADDED Requirements
### Requirement: Pipeline SHALL enforce provider-safe global LLM concurrency
系统 SHALL 在所有 LLM 节点执行期间施加全局并发上限，默认值为 3（可配置），并确保任意节点的本地并发不超过全局上限，以降低 provider 限流与失败抖动。

#### Scenario: Node concurrency is capped by global limit
- **WHEN** 某 LLM 节点配置并发大于全局并发上限
- **THEN** 系统实际并发取 `min(节点并发, 全局并发)`
- **AND** 运行元数据中可看到生效并发值

#### Scenario: Multiple LLM steps do not exceed global concurrency budget
- **WHEN** 同一 run 内存在多个 LLM 子步骤连续执行
- **THEN** 系统仍遵守全局并发预算
- **AND** 不出现因并发叠加导致的无限放大请求

### Requirement: Pipeline SHALL support LLM-assisted tagging and ranking fusion with safe fallback
系统 SHALL 在规则排序之后引入 LLM item 级标签与评分辅助，并使用可配置融合策略生成最终排序；当 LLM 输出异常或置信度不足时，系统 SHALL 回退规则 baseline 且不阻断主流程。

#### Scenario: Item-wise LLM assist returns structured tags and scores
- **WHEN** 系统执行 LLM assist 阶段
- **THEN** 每条候选输出结构化字段（domainTag、intentTag、actionability、confidence、llmScore）
- **AND** 输出可映射到对应 itemId

#### Scenario: Final ranking score is fused from rule and LLM scores
- **WHEN** item 同时具备规则分与有效 LLM 分
- **THEN** 系统按配置权重计算融合分并重排
- **AND** 产物中保留 score breakdown 便于审计

#### Scenario: Low-confidence or invalid LLM output falls back to rule baseline
- **WHEN** LLM 返回格式错误、校验失败或 confidence 低于阈值
- **THEN** 该条目使用规则分作为最终分
- **AND** 系统记录回退原因但继续完成 run

### Requirement: Pipeline SHALL provide lead summary for report readability with non-blocking fallback
系统 SHALL 为每期报告生成“本期导语”区块（2-3 句），用于概括重点趋势；导语生成失败时 SHALL 回退到模板导语，不得阻断报告生成。

#### Scenario: Lead summary is generated from top signals
- **WHEN** 流水线进入报告渲染前阶段
- **THEN** 系统基于速览与高分条目生成导语
- **AND** 导语可在报告顶部稳定展示

#### Scenario: Lead generation failure uses template fallback
- **WHEN** 导语生成调用失败或输出不合法
- **THEN** 系统自动使用模板导语
- **AND** 报告仍按原流程输出

### Requirement: Pipeline SHALL provide Chinese title translation for English headlines
系统 SHALL 对英文标题提供中文翻译字段，并在报告中优先展示中文标题（附原标题）；翻译失败时 SHALL 回退原标题。

#### Scenario: English headline is rendered with Chinese title and original title
- **WHEN** 条目标题判定为英文或中英混合且翻译成功
- **THEN** 报告显示“中文标题（Original Title）”
- **AND** 保留原始链接与证据追溯能力

#### Scenario: Translation failure falls back to original title
- **WHEN** 标题翻译失败或结果不合法
- **THEN** 报告直接展示原标题
- **AND** 不影响排序、审核与发布流程

## MODIFIED Requirements
### Requirement: Processing pipeline SHALL generate review artifacts with traceable metadata
系统 SHALL 在每次执行后产出待审核报告文件与结构化元数据文件，且关键状态文件可按配置进入 Git 同步路径，便于人工审核与后续发布；当启用 LLM 能力时，产物 SHALL 记录总结与排序辅助的执行元数据、融合结果与回退状态。

#### Scenario: Review artifact records LLM assist metadata and score breakdown
- **WHEN** 本次 run 启用了 LLM 总结或排序辅助能力
- **THEN** 结构化产物包含对应执行元信息（provider/model/promptVersion/并发/回退统计）
- **AND** 条目可追溯规则分、LLM 分与融合后最终分

#### Scenario: Recheck path remains compatible with optional LLM assist fields
- **WHEN** recheck 读取历史 artifact 且部分新字段缺失
- **THEN** 系统使用兼容逻辑继续运行
- **AND** 不因字段版本差异导致流程失败
