## Context
M5.1~M5.3 已引入 LLM 摘要与排序辅助，但仍存在两个结构性问题：
1) 分类阶段主要依赖规则；2) LLM 打分仅覆盖前 N 条，无法全量统一。

用户明确要求：
- 分类改为基于 LLM；
- 打分前置并覆盖全量；
- 批量调用、失败自动重试；
- `llm_summarize` 去打分；
- 参数可配置：`fusionWeight=0.65`、`timeout=60s`、`batchSize=10`；
- 使用 few-shot 提升输出结构稳定性。

## Goals / Non-Goals
### Goals
- 前置 LLM 节点统一输出全量 `category + llmScore + confidence`。
- 通过批量与重试机制降低调用次数与失败放大。
- 保留规则兜底，确保流程非阻断。
- 将摘要节点与打分节点职责分离，降低耦合与调试成本。

### Non-Goals
- 本次不改动 Feishu 审核状态机与发布策略。
- 本次不引入多 provider 路由策略。
- 本次不改变现有 category 枚举集合（继续使用既有 7 类 + other）。

## Decisions
### Decision 1: 新增 `llm_classify_score` 前置节点
- 位置：`dedupe -> llm_classify_score -> rank`。
- 理由：分类与打分属于排序前信息，应在 `rank` 前稳定产出。

### Decision 2: 批量调用而非单条调用
- 默认 `batchSize=10`（可配置）。
- 理由：减少请求次数、降低整体时延与失败面。

### Decision 3: 失败自动重试 + 拆批降级
- 批次失败先重试 1 次；仍失败则二分拆批直至单条。
- 单条仍失败或低置信度时回退规则分类与规则分。
- 理由：在 provider 波动下保持主流程稳定。

### Decision 4: `llm_summarize` 去打分
- `llm_summarize` 仅负责摘要类输出，不再承担评分融合职责。
- 理由：避免“前置评分 + 后置评分”双轨冲突。

### Decision 5: few-shot + 严格 JSON 输出契约
- 为分类打分提示词提供正例/反例片段，强调 JSON-only 返回。
- 理由：降低解析失败与字段漂移概率。

## Data Contract
新增/扩展结构化字段（命名示意）：
- item 级：`category`、`llmScore`、`confidence`、`scoreBreakdown`。
- run 级：`llmClassifyScoreMeta`，至少包括：
  - `inputCount`、`processedCount`、`fallbackCount`
  - `batchSize`、`effectiveConcurrency`、`timeoutMs`
  - `retryCount`、`splitRetryCount`
  - `failureStats`（timeout/http/missing_content/invalid_json/quality/other）

## Config
新增配置（默认值）：
- `LLM_CLASSIFY_SCORE_ENABLED=true`
- `LLM_CLASSIFY_SCORE_BATCH_SIZE=10`
- `LLM_CLASSIFY_SCORE_TIMEOUT_MS=60000`
- `LLM_CLASSIFY_SCORE_MAX_CONCURRENCY=2`（仍受全局并发上限裁剪）
- `LLM_RANK_FUSION_WEIGHT=0.65`
- `LLM_CLASSIFY_SCORE_MIN_CONFIDENCE=0.6`

## Risks / Trade-offs
- 风险：批量请求过大导致 timeout 增加。
  - 缓解：默认 batch=10 + 超时可配 + 拆批重试。
- 风险：LLM 分类与历史规则分类分布差异较大。
  - 缓解：保留回退与可观测统计，支持灰度验证。
- 风险：新节点增加复杂度。
  - 缓解：职责分离后总体可维护性更高，且可单独观测。

## Migration Plan
1. 引入新节点与数据结构，保持向后兼容字段读取。
2. 将 ranking 融合切换到前置节点输出。
3. 关闭 `llm_summarize` 打分路径，保留摘要路径。
4. 更新文档与学习材料，执行全量回归测试。

## Validation Strategy
- 单元测试：批量解析、拆批重试、低置信度回退、融合公式。
- 集成测试：全链路节点顺序与产物字段完整性。
- 稳定性测试：真实数据连续运行观察失败分类与回退比例。
