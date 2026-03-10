# M5 学习复盘 04：前置批量分类/全量打分 + 摘要节点去打分

## 1. 本次实现了什么
- 在 `dedupe` 与 `rank` 之间新增 `llm_classify_score` 节点：
  - 批量请求 MiniMax 执行分类与打分（默认 `batchSize=10`）。
  - 失败容错采用分层策略：批次重试 -> 二分拆批 -> 单条回退规则结果。
  - 支持低置信度回退，保障流程稳定。
- 将排序融合职责前置到 `rank`：
  - 按 `ruleScoreNormalized` 与 `llmScore` 融合得到 `finalScore`。
  - 输出 `scoreBreakdown`，保证每条排序可追溯。
- `llm_summarize` 去打分职责：
  - 仅负责摘要、导语、分类导读、标题翻译。
  - 不再改写 score 与排序顺序。

## 2. 流程图（M5.2 收敛后）
```text
collect
  -> normalize
  -> dedupe
  -> llm_classify_score
      -> batch classify+score
      -> retry / split-degrade / single fallback
  -> rank (rule + llm fusion)
  -> publish_or_wait
  -> llm_summarize (summary/lead/category lead/titleZh)
  -> build_report
```

## 3. 源码导读（建议顺序）
1. `src/llm/classify-score.ts`
- `buildLlmClassifyScore`：前置批量分类打分入口。
- `classifyBatchWithResilience`：批次容错主链路（重试/拆批/单条回退）。
- `parseJsonFromModelText`：对 fenced/escaped JSON 做兼容解析。

2. `src/pipeline/nodes.ts`
- `llmClassifyScoreNode`：规则 baseline + LLM 前置增强。
- `applyLlmFusionBeforeRank`：融合分计算与重排。
- `llmSummarizeNode`：仅回写翻译标题，不改写 score。

3. `src/core/types.ts` + `src/core/review-artifact.ts`
- 新增 `llmClassifyScoreMeta`、失败分类与重试统计结构。
- 产物 schema 与 recheck 读取路径兼容历史缺失字段。

## 4. 运行验证
- `pnpm build`：通过。
- `pnpm test`：通过（27 files / 151 tests）。
- `openspec validate add-llm-batch-classify-score-pre-rank --strict`：通过。

## 5. 设计取舍
- 为什么采用“批量 + 拆批降级”：
  - 与单条调用相比，批量能显著降低请求数。
  - 与全局单次失败即回退相比，拆批可提升成功率并减少整批损失。
- 为什么把打分从 summarize 节点前移：
  - 排序属于核心决策逻辑，应在 `rank` 阶段确定，避免后置节点二次改写导致可解释性下降。
- 为什么保留 summarize 的翻译能力：
  - 这是可读性增强，不改变排序决策，可独立回退。

## 6. 3 分钟复盘模板（已填写）
```text
【1】本轮目标（30s）
- 我本轮要验证的能力点是：把 LLM 打分职责从 summarize 解耦，改为前置批量 classify+score，并保持排序可追溯。
- 我完成后的可见结果是：产物新增 llmClassifyScoreMeta，排序由 pre-rank 融合驱动，summary 不再改 score。

【2】关键实现（60s）
- 我改了哪 3 个核心文件：
  1) src/llm/classify-score.ts
  2) src/pipeline/nodes.ts
  3) src/core/types.ts + src/core/review-artifact.ts
- 每个文件“为什么要改”：
  - classify-score.ts：承接批量调用与容错收敛。
  - nodes.ts：明确节点职责边界，保证 rank 的单一决策点。
  - types/artifact：让诊断信息可落盘、可回放、可比较。

【3】运行验证（45s）
- 我执行的命令：
  - pnpm build
  - pnpm test
  - openspec validate add-llm-batch-classify-score-pre-rank --strict
- 结果是否符合预期：符合。
- 有无 warning/边界场景：
  - 有批次失败时会出现局部回退 warning，但流程不阻断。

【4】设计取舍（30s）
- 我放弃了哪个方案，原因是：放弃“在 summarize 节点继续融合打分”，因为职责耦合过高且难排障。
- 当前实现的风险点是：批量输出格式仍依赖 provider 稳定性，需要持续优化 prompt 与解析兼容。

【5】下一步（15s）
- 我下一轮最小可执行目标是：观察真实数据下 batch fallback 比例，并据此迭代 prompt 与 batchSize。
```
