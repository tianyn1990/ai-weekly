## Context
M4.4 后系统已具备稳定运行能力（daemon、Feishu 审核、DB/API、自动同步）。M5.1 目标是在不破坏现有确定性流程的前提下，为日报/周报引入 LLM 总结增强，提高可读性与信息密度。

本阶段约束：
- 稳定性优先：LLM 失败不得阻断主流程。
- 证据优先：所有摘要必须可追溯到输入条目。
- 渐进演进：先做总结增强，不在本阶段改分类/排序决策主导权。

## Goals / Non-Goals
- Goals:
  - 新增 `llm_summarize` 节点，支持 daily/weekly。
  - 采用“逐条总结 + 聚合重点”策略，避免全量单 prompt 的上下文退化。
  - 快速重点输出条数自适应在 `4-12` 条。
  - MiniMax 作为首发 provider。
  - 失败自动回退到规则摘要，并发出 run 级合并告警（飞书 1 条）。
  - 全链路可审计（开始、成功、失败、回退）。
- Non-Goals:
  - 本阶段不把分类/打标/排序改为 LLM 主导。
  - 本阶段不引入多 provider 生产级切换策略（先实现 MiniMax，接口预留）。
  - 本阶段不改动审核状态机语义。

## Decisions
### 1) 节点位置与执行边界
- Decision: `llm_summarize` 放在 `publish_or_wait` 之后、`build_report` 之前。
- Why:
  - 此时审核与发布状态已确定，LLM 只影响展示文本，不影响发布判定。
  - 易于回退，不会污染 review policy 的确定性。

### 2) 总结策略采用两段式
- Decision:
  - 第一步：对每条候选条目执行独立摘要（可并发、可限流）。
  - 第二步：基于逐条摘要聚合生成“快速重点”。
- Why:
  - 避免把所有候选塞进单 prompt 导致 token 过长、重点漂移、幻觉风险上升。
  - 逐条摘要可更好绑定证据（itemId/link），可审计性更强。

### 3) 快速重点数量自适应
- Decision: 快速重点条数在 `4-12` 区间内自适应。
- Suggested policy:
  - 候选 <= 8: 输出 4-6 条
  - 候选 9-20: 输出 6-9 条
  - 候选 > 20: 输出 8-12 条
- Why:
  - 保持阅读负担稳定，同时对大样本保留足够覆盖。

### 4) Provider 抽象 + MiniMax 首发
- Decision:
  - 定义统一 LLM 接口（例如 `summarizeItem` / `composeDigest`）。
  - 本阶段仅提供 MiniMax 实现并上线。
- Why:
  - 满足当前账户与成本偏好（用户已购 MiniMax coding plan）。
  - 为后续 OpenAI/Anthropic 扩展留接口，避免二次重构。

### 5) 回退与告警策略
- Decision:
  - 任一 LLM 子步骤失败时，节点切换到规则摘要。
  - 单次 run 内合并告警：飞书只发 1 条“LLM 已降级，当前使用规则摘要”。
- Why:
  - 主链路不可被模型稳定性拖垮。
  - 告警要有感知但不刷屏。

### 6) 证据约束与安全约束
- Decision:
  - LLM 输出必须结构化（JSON Schema）并通过校验。
  - 每条摘要必须包含 `evidenceItemIds`，且必须在本次 `rankedItems` 中存在。
  - 对来源内容启用 prompt injection 防护指令（把内容视为不可信文本）。
- Why:
  - 保证“无无源断言”，满足 PRD 验收要求。

## Data Contract (M5.1)
建议新增状态字段（命名可在实现阶段微调）：
- `itemSummaries`: 每条候选的结构化摘要数组
- `quickDigest`: 顶部快速重点数组（4-12）
- `llmSummaryMeta`: provider/model/promptVersion/latency/fallbackReason
- `llmFallbackTriggered`: 是否触发回退

建议新增审计事件：
- `llm_summary_started`
- `llm_summary_completed`
- `llm_summary_fallback`

## Flow
1. `rank_items` 产出 `rankedItems/highlights`
2. `review_*` 与 `publish_or_wait` 完成状态判定
3. `llm_summarize`：
   - 逐条摘要（并发受限）
   - 证据校验
   - 聚合快速重点（4-12）
   - 失败则回退规则摘要并打审计
4. `build_report` 渲染：优先使用 LLM 摘要；回退时输出规则摘要并标记“已降级”
5. `persistOutputs` 后按 run 维度触发一次飞书降级告警（如发生）

## Risks / Trade-offs
- 成本与时延增加：逐条总结会增加调用次数。
  - Mitigation: 并发上限、输入裁剪、超时控制、可开关。
- 供应商稳定性波动：MiniMax 可能出现瞬时失败。
  - Mitigation: 自动回退 + 单次告警 + 审计记录。
- 输出质量波动：不同日期样本差异较大。
  - Mitigation: 固定输出 schema + 约束 prompt + 回归测试基线。

## Migration Plan
1. 引入 LLM 配置与 provider 抽象（MiniMax 实现）。
2. 新增 `llm_summarize` 节点并接入 graph/recheck。
3. 扩展 report 渲染与 artifact 落盘 schema。
4. 增加审计与飞书合并告警。
5. 补齐单测/集成测试并更新文档与学习材料。

## Open Questions
- 无。关键产品决策已确认：
  - provider = MiniMax
  - 快速重点 = 4-12 条（自适应）
  - daily 也启用
  - 失败接受回退，同时飞书合并告警一次
