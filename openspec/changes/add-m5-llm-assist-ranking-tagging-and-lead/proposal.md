# Change: 合并实现 M5.2a + M5.2b（LLM 辅助排序/打标 + 报告导语与标题翻译）

## Why
M5.1 已完成“逐条总结 + 速览聚合”，但在真实运行中仍存在三类可优化空间：
1. 排序结果仍以规则分主导，规则权重尚未充分调优，导致“重要性排序”与人工直觉偶有偏差。
2. 报告可读性仍偏工程日志风格，缺少“本期导语”来帮助审核人与读者快速建立上下文。
3. 原始标题包含英文时，中文阅读门槛较高，影响审核效率与信息吸收速度。

同时，MiniMax 接口并发上限在历史实测中存在稳定性边界，需要把并发治理纳入同一阶段改造，而不是分散在后续修补中。

## What Changes
本 change 合并 M5.2a + M5.2b，一次性完成以下能力：

- 新增 LLM 辅助“标签 + 排序修正”能力（M5.2a）：
  - 在规则 baseline 之后，引入 LLM item-wise 结构化输出：`domainTag`、`intentTag`、`actionability`、`confidence`、`llmScore`。
  - 使用“规则分 + LLM 分”的融合策略生成最终排序分，默认提高 LLM 权重（可配置）。
  - 保留严格回退：LLM 失败时条目级回退规则分，run 级稳定性不受影响。

- 新增报告导语与英文标题翻译增强（M5.2b）：
  - 生成“本期导语（lead）”区块，基于速览与 Top 条目做 2-3 句总结。
  - 对英文标题生成中文标题（`titleZh`），报告显示为“中文标题（原标题）”。
  - 翻译失败自动回退原标题，不阻断主流程。

- 新增 provider 并发治理与限流护栏：
  - 增加“全局 LLM 最大并发”配置，默认 `3`（可配置）。
  - 节点局部并发不得突破全局上限，避免多任务叠加触发 MiniMax 不稳定。

- 扩展审计与告警：
  - 记录标签/排序修正/导语/翻译的执行元数据与回退原因。
  - run 维度继续保持飞书合并告警（每 run 至多 1 条）。

## Impact
- Affected specs: `ai-reporting-pipeline`
- Affected code (planned):
  - `src/pipeline/graph.ts`
  - `src/pipeline/nodes.ts`
  - `src/llm/summary.ts`（或拆分 `src/llm/assist.ts`）
  - `src/core/types.ts`
  - `src/core/scoring.ts`
  - `src/report/markdown.ts`
  - `src/core/review-artifact.ts`
  - `src/cli.ts`
  - `src/review/feishu.ts`
  - `tests/*`
  - `docs/PRD.md`
  - `docs/architecture.md`
  - `docs/learning-workflow.md`
