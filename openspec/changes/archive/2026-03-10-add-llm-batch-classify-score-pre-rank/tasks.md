## 1. Implementation
- [x] 1.1 在 pipeline 中新增 `llm_classify_score` 节点，并接入 `dedupe -> llm_classify_score -> rank`。
- [x] 1.2 实现批量 classify+score 调用（默认 batchSize=10，timeout=60000ms，fusionWeight=0.65）。
- [x] 1.3 实现失败自动重试与拆批降级（批次重试 -> 二分拆批 -> 单条回退）。
- [x] 1.4 实现 few-shot 提示词与严格 JSON 输出校验。
- [x] 1.5 将 `llm_summarize` 的打分/融合职责下移（或移除），仅保留摘要相关能力。
- [x] 1.6 写入 `llmClassifyScoreMeta` 并在 warning 中输出可读统计。

## 2. Testing
- [x] 2.1 新增/更新 classify-score 节点单元测试（批量成功、格式错误、重试拆批、置信度回退）。
- [x] 2.2 新增/更新 ranking 融合测试（全量条目覆盖）。
- [x] 2.3 更新摘要节点测试，确认去打分后行为正确。
- [x] 2.4 执行 `pnpm test` 与 `pnpm build`。

## 3. Documentation
- [x] 3.1 更新 `docs/PRD.md`（全量 LLM 分类与打分策略）。
- [x] 3.2 更新 `docs/architecture.md`（新节点时序、容错、配置）。
- [x] 3.3 更新 `docs/learning-workflow.md`（学习交付节奏同步）。
- [x] 3.4 新增学习会话文档并填写 3 分钟复盘模板。

## 4. OpenSpec Validation
- [x] 4.1 执行 `openspec validate add-llm-batch-classify-score-pre-rank --strict`。
