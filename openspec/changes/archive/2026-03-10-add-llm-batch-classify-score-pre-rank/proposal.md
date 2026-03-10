# Change: 引入前置 LLM 批量分类与全量打分节点

## Why
当前分类阶段主要依赖规则匹配，语义泛化能力有限；同时 LLM 打分仅覆盖前 N 条（如 30 条），其余条目完全依赖规则分，导致全量排序一致性不足。

## What Changes
- 在 `dedupe` 之后、`rank` 之前新增前置节点 `llm_classify_score`，对全量条目执行 LLM 分类与打分。
- `llm_classify_score` 采用“批量多条请求”而非单条请求，默认 `batchSize=10`，支持失败自动重试与拆批降级。
- 排序融合统一基于前置节点输出：`fusionWeight` 默认 `0.65`（可配置）。
- `llm_summarize` 取消打分职责，仅保留摘要/速览/导语/翻译/导读等可读性能力。
- 强化提示词与输出契约：引入 few-shot 示例，约束 LLM 严格返回结构化 JSON。
- 新增 run 级元数据，记录分类打分阶段的成功率、回退率、重试与失败分类统计。

## Impact
- Affected specs:
  - `ai-reporting-pipeline`
- Affected code（预期）：
  - `src/pipeline/graph.ts`
  - `src/pipeline/nodes.ts`
  - `src/llm/summary.ts`（去除打分职责）
  - `src/core/types.ts`
  - `src/core/review-artifact.ts`
  - `src/report/markdown.ts`（可观测信息展示）
- Affected tests（预期）：
  - `tests/pipeline-graph-review.test.ts`
  - `tests/llm-summary.test.ts`
  - 新增/扩展 `llm classify-score` 相关测试
- Affected docs（预期）：
  - `docs/PRD.md`
  - `docs/architecture.md`
  - `docs/learning-workflow.md`
  - 对应学习会话文档
