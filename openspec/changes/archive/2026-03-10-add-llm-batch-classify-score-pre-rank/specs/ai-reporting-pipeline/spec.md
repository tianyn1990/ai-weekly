## MODIFIED Requirements
### Requirement: Pipeline CLI SHALL support daily/weekly report generation
系统 SHALL 提供统一 CLI 入口，用于触发 `daily` 或 `weekly` 模式的报告生成，并支持 `mock` 数据模式用于学习与调试。

#### Scenario: Run weekly report in mock mode
- **WHEN** 用户执行 `pnpm run:weekly:mock`
- **THEN** 系统完成一次 `weekly` 流程执行并输出报告文件
- **AND** 处理链路包含 collect、normalize、dedupe、llm_classify_score、rank、build_report 节点

#### Scenario: Run daily report in live mode
- **WHEN** 用户执行 `pnpm run:daily`
- **THEN** 系统按已启用来源抓取并生成 `daily` 报告
- **AND** 即使部分来源失败，流程仍可结束并产出结果

### Requirement: Processing pipeline SHALL generate review artifacts with traceable metadata
系统 SHALL 在每次执行后产出待审核报告文件与结构化元数据文件，且关键状态文件可按配置进入 Git 同步路径，便于人工审核与后续发布；当启用 LLM 能力时，产物 SHALL 记录分类打分、总结、融合结果、回退状态与诊断信息。

#### Scenario: Review artifact records classify-score metadata and score breakdown
- **WHEN** 本次 run 启用了前置 LLM 分类打分能力
- **THEN** 结构化产物包含 `llmClassifyScoreMeta`（批次、并发、重试、失败分类、回退统计）
- **AND** 条目可追溯规则分、LLM 分与融合后最终分

#### Scenario: Review artifact remains compatible when classify-score metadata is missing
- **WHEN** recheck 或读取历史 artifact 时缺失 `llmClassifyScoreMeta`
- **THEN** 系统使用兼容逻辑继续运行
- **AND** 不因版本差异中断流程

### Requirement: Classification SHALL include dedicated agent category
系统 SHALL 以前置 LLM 分类为主、规则分类为兜底，输出既有分类集合（含 `agent`），并在低置信度或异常场景回退到规则结果。

#### Scenario: LLM classifies agent-related item as agent
- **WHEN** 前置 LLM 分类阶段识别到 Agent 工程实践相关条目
- **THEN** 条目分类结果为 `agent`
- **AND** 分类统计中包含 `agent` 维度

#### Scenario: Classification falls back to rules on low confidence or failure
- **WHEN** LLM 分类结果低于置信度阈值或发生超时/解析失败
- **THEN** 系统对该条目回退规则分类
- **AND** 记录回退原因且不中断流程

### Requirement: Pipeline SHALL support LLM-assisted tagging and ranking fusion with safe fallback
系统 SHALL 在排序前通过批量 LLM 节点为全量条目提供分类与打分辅助，并使用可配置融合策略生成最终排序；摘要节点 SHALL 不再承担打分职责。当 LLM 输出异常或置信度不足时，系统 SHALL 回退规则 baseline 且不阻断主流程。

#### Scenario: Batch classify-score returns structured results for multiple items
- **WHEN** 系统执行 `llm_classify_score` 阶段
- **THEN** 每个批次返回多条 item 结构化结果（itemId、category、confidence、llmScore、reason）
- **AND** 输出可稳定映射回原条目

#### Scenario: Final ranking score is fused from rule and pre-rank LLM scores
- **WHEN** item 同时具备规则分与有效前置 LLM 分
- **THEN** 系统按配置权重（默认 `fusionWeight=0.65`）计算融合分并重排
- **AND** 该融合结果覆盖全量候选条目

#### Scenario: Summarize node does not perform scoring
- **WHEN** 流水线进入 `llm_summarize` 阶段
- **THEN** 节点仅生成摘要/导语/翻译/导读能力
- **AND** 不再修改条目打分与排序融合结果

## ADDED Requirements
### Requirement: Pipeline SHALL support batch retry and split-degrade for classify-score stability
系统 SHALL 对前置批量分类打分实现分层容错：批次重试、拆批降级、单条回退，保证主流程稳定。

#### Scenario: Batch request retries once before split
- **WHEN** 某批次 classify-score 请求失败
- **THEN** 系统先对该批次重试一次
- **AND** 若重试成功则继续后续流程

#### Scenario: Failed batch degrades by split and eventually falls back per item
- **WHEN** 批次重试后仍失败
- **THEN** 系统执行二分拆批重试
- **AND** 最终对仍失败的单条执行规则回退并继续流程

### Requirement: Pipeline SHALL enforce few-shot constrained JSON output for classify-score
系统 SHALL 在分类打分提示词中使用 few-shot 示例，并要求模型返回 JSON-only 结构化结果，以降低解析失败率。

#### Scenario: Few-shot prompt increases format compliance
- **WHEN** 系统构建 classify-score 请求提示词
- **THEN** 提示词包含正例 few-shot 与字段约束
- **AND** 模型返回结果可通过结构校验

#### Scenario: Invalid format triggers retry path
- **WHEN** 模型返回非 JSON 或字段缺失
- **THEN** 系统按重试/拆批策略处理
- **AND** 不因单批格式异常中断整体运行
