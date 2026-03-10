# M5 学习复盘 06：全量标题翻译前置 + 中文质量修复链 + 英文保留策略

## 1. 本次实现了什么
- 在前置 `llm_classify_score` 节点新增 `titleZh` 输出，确保标题翻译能力覆盖全量条目，而不是仅覆盖摘要节点前 N 条。
- 在 `llm_summarize` 节点新增中文质量闭环：
  - 检测 `summary/recommendation` 是否为非中文输出。
  - 先走既有重试，再触发中文修复调用。
  - 若修复失败，保留英文原文（不强制写模板中文）。
- 新增可观测字段 `zhQualityStats`，记录检测与修复效果，便于排障与调参。

## 2. 流程图（本次增量）
```text
llm_classify_score (all items)
  -> category + llmScore + titleZh
  -> rank fusion

llm_summarize (top-N items)
  -> summary/recommendation generation
  -> non-zh detect
    -> retry
    -> zh repair
    -> if still failed: keep English original
```

## 3. 源码导读（建议顺序）
1. `src/llm/classify-score.ts`
- `classifyScoreResultItemSchema`：新增 `titleZh`。
- `normalizeBatchResults`：保留低置信度回退，但允许标题翻译结果单独落地。
- `normalizeTranslatedTitle`：只接受含中文的翻译结果，避免英文改写误覆盖。

2. `src/llm/summary.ts`
- `summarizeItemWithRetry`：新增“非中文检测 -> 修复 -> 英文保留”链路。
- `rewriteSummaryToChinese`：中文修复调用入口。
- `computeZhQualityStats`：聚合 run 级中文质量统计。

3. `src/core/types.ts` + `src/core/review-artifact.ts`
- 新增 `LlmZhQualityStats` 与 `llmSummaryMeta.zhQualityStats` 落盘 schema。

## 4. 运行验证
- `pnpm build`：通过。
- `pnpm test`：通过（27 files / 156 tests）。
- 新增测试覆盖：
  - `tests/llm-classify-score.test.ts`：标题翻译回写与非中文 titleZh 忽略。
  - `tests/llm-summary.test.ts`：非中文摘要修复成功、修复失败后英文保留。

## 5. 设计取舍
- 为什么把标题翻译放在前置节点：
  - 前置节点覆盖全量条目，天然解决“只翻译前 N 条”的覆盖盲区。
- 为什么修复失败保留英文：
  - 翻译属于可读性增强，不应为追求中文统一而引入不准确内容。
- 为什么不新增 few-shot：
  - 维持当前 prompt 体积稳定，优先通过后处理质量闸门提升结果可控性。

## 6. 3 分钟复盘模板（已填写）
```text
【1】本轮目标（30s）
- 我本轮要验证的能力点是：把标题翻译覆盖从“摘要前 N 条”扩展到“全量条目”，并降低英文摘要直接落盘比例。
- 我完成后的可见结果是：titleZh 在前置节点输出，summary 出现非中文时会自动进入修复链，失败时保留英文原文。

【2】关键实现（60s）
- 我改了哪 3 个核心文件：
  1) src/llm/classify-score.ts
  2) src/llm/summary.ts
  3) src/core/types.ts + src/core/review-artifact.ts
- 每个文件“为什么要改”：
  - classify-score：把翻译能力前置到全量路径。
  - summary：构建中文质量修复闭环并保留语义准确性。
  - types/schema：沉淀统计信息，支持运行可观测。

【3】运行验证（45s）
- 我执行的命令：
  - pnpm build
  - pnpm test
- 结果是否符合预期：符合。
- 有无 warning/边界场景：
  - 非中文摘要修复失败时会保留英文，并在元数据中可见 englishRetainedCount。

【4】设计取舍（30s）
- 我放弃了哪个方案，原因是：放弃“修复失败后强制模板中文”，因为可能损失原文语义准确性。
- 当前实现的风险点是：中文检测阈值仍需结合真实样本继续调优。

【5】下一步（15s）
- 我下一轮最小可执行目标是：统计真实 daily/weekly 的中文修复成功率，并调整检测阈值与修复提示词。
```
