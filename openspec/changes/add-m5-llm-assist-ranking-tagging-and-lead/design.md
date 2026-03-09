## Context
当前系统在 M5.1 已具备“LLM 总结增强 + 失败回退 + 合并告警”。M5.2 目标是继续提升“排序质量 + 可读性”，但必须遵守既有稳定性原则：
- LLM 不得成为单点阻塞。
- 规则 baseline 可独立运行。
- 输出必须结构化、可审计、可回放。

本次将原计划的 M5.2a（标签/排序辅助）与 M5.2b（导语/翻译）合并，以减少跨阶段接口变更与重复测试成本。

## Goals / Non-Goals
- Goals:
  - 引入 LLM item 级标签与评分，参与最终排序融合。
  - 增加报告导语（lead）与英文标题中文化展示。
  - 新增全局并发治理：默认上限 3，可配置。
  - 保持条目级回退与 run 级合并告警，不破坏发布状态机。
- Non-Goals:
  - 本阶段不替换采集、去重、审核状态机。
  - 本阶段不做多 provider 生产切换编排（仍以 MiniMax 为主）。
  - 本阶段不做 embedding 相似度去重或全文语义检索改造。

## Decisions
### 1) 统一采用 item-wise LLM 调用，不做全量 one-shot
- Decision: 标签、评分、翻译均按条目独立调用（可并发受控），导语使用聚合调用。
- Why: 保持可追溯性，降低超长上下文失败率，便于条目级 fallback。

### 2) 增加全局并发闸门（默认 3）
- Decision:
  - 增加 `LLM_GLOBAL_MAX_CONCURRENCY`（默认 `3`）。
  - 节点配置并发取 `min(nodeConcurrency, globalConcurrency)`。
- Why:
  - 结合历史联调数据，MiniMax 在并发 >3 时失败率明显上升。
  - 全局闸门可避免多个 LLM 子任务叠加击穿 provider 限制。

### 3) 排序采用“规则 baseline + LLM 融合”
- Decision:
  - 保留规则分 `ruleScore`。
  - 新增 LLM 分 `llmScore`（0-100）和 `confidence`（0-1）。
  - 默认融合权重偏向 LLM：`final = (1-w)*ruleNorm + w*llmNorm`，默认 `w=0.65`（可配置）。
  - 低置信度或格式异常时回退规则分。
- Why:
  - 用户明确希望提高 LLM 评分影响力。
  - 仍保留规则 baseline，确保可解释与安全兜底。

### 4) LLM 评分提示词引入 rubric
- Decision:
  - 在 prompt 内显式给出评分 rubric（工程价值、时效性、可执行性、影响范围）。
  - 要求输出分项理由，便于审计和后续调参。
- Why:
  - 将“评分标准”前移到模型上下文，减少仅靠静态规则的偏差。

### 5) 报告新增导语与标题翻译
- Decision:
  - 新增 `leadSummary`（2-3 句，面向读者的本期导读）。
  - 新增 `titleZh` 字段；对英文标题优先展示“中文标题（原标题）”。
- Why:
  - 导语提升阅读入口体验。
  - 标题中文化提升审核效率，降低理解门槛。

### 6) 失败与回退策略保持分层
- Decision:
  - item 级失败：仅该条回退规则标签/分数/标题。
  - lead 失败：回退模板导语，不影响报告生成。
  - run 级失败率过高：禁用本轮 LLM 排序修正，保留规则排序。
- Why:
  - 保持主链路稳态，避免“部分能力失败导致全流程退化”。

## Data Contract (M5.2)
建议新增/扩展字段：
- item 级：
  - `domainTag: string`
  - `intentTag: string`
  - `actionability: number`（0-3）
  - `confidence: number`（0-1）
  - `llmScore: number`（0-100）
  - `titleZh?: string`
  - `scoreBreakdown: { ruleScore: number; llmScore?: number; finalScore: number; fusionWeight: number }`
- report 级：
  - `leadSummary?: string`
  - `llmAssistMeta`（provider/model/promptVersion/并发/回退统计）

## Flow
1. `rank_items` 先计算规则分（baseline）。
2. `llm_assist_items`：逐条输出标签/评分/翻译（受全局并发闸门约束）。
3. 融合评分得到 `finalScore`，重排 `rankedItems`。
4. `llm_build_lead`：生成导语（失败回退模板）。
5. `build_report`：渲染导语、中文标题、速览、逐条摘要。
6. 写入审计与回退告警（run 合并 1 条）。

## Risks / Trade-offs
- 风险：LLM 评分权重提高后，排序可能出现短期抖动。
  - Mitigation: 配置化权重 + 置信度门控 + 失败回退 + 审计可追踪。
- 风险：新增字段后 artifact 向后兼容复杂度增加。
  - Mitigation: 字段可选化 + schema 兼容 + recheck 读取容错。
- 风险：调用次数增加导致耗时上涨。
  - Mitigation: 全局并发控制 + 超时 + 条目上限 + 合并告警。

## Migration Plan
1. 先扩展类型与 artifact schema（可选字段，保持兼容）。
2. 接入 `llm_assist_items`（标签/评分/翻译）与融合排序。
3. 接入 `llm_build_lead` 与 markdown 渲染。
4. 增加并发闸门配置与运行时校验。
5. 补齐单测/集成测试、文档、学习会话复盘。

## Open Questions
- 无阻塞问题。
- 具体默认值建议：
  - `LLM_GLOBAL_MAX_CONCURRENCY=3`
  - `LLM_RANK_FUSION_WEIGHT=0.65`
  - `LLM_ASSIST_MIN_CONFIDENCE=0.5`
  - 最终以实现阶段回归数据微调。
