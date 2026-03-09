# Change: M5.3 LLM 稳定性与可观测性加固 + 分类导读可读性增强

## Why
M5.2 已完成 LLM 辅助排序/打标、导语、标题中文化等能力，但在真实数据运行中仍有三类问题需要系统性收口：

1. **稳定性抖动**：`missing_content` 在部分时段会集中出现，虽然已有回退和串行补偿，但仍存在批量条目回退比例偏高的场景。
2. **基线不一致**：OpenSpec/代码默认值/文档推荐值在全局并发上存在历史差异（3 vs 2），影响运维预期一致性。
3. **可读性可解释不足**：当前已有“本期导语”，但“分类正文”缺少每类的阅读指引，用户在进入正文时仍需自行理解“本类为什么值得看”。

因此需要在 M5.3 做一轮“稳定性 + 可观测 + 可读性”的合并收口，确保真实运行时可预测、可诊断、可持续优化。

## What Changes
本次 change 覆盖 M5.3a + M5.3b + M5.3c：

- **M5.3a（稳定性）**
  - 在现有重试机制基础上增加“短窗口自适应降载”：当 `missing_content` 在连续窗口达到阈值时，自动临时降并发并优先重试失败条目。
  - 增加自动恢复机制：当窗口成功率恢复后，逐步恢复到配置并发。
  - 继续保持 non-blocking：即便自适应策略失败，也不得阻断审核/发布主流程。

- **M5.3b（可观测与基线对齐）**
  - 统一全局 LLM 并发默认值为 `2`（可配置），并强制节点并发不超过全局并发。
  - 扩展 `llmSummaryMeta` 与 warning 信息：记录自适应降载触发、恢复、窗口失败率、失败分类与重试统计。
  - 提供运维诊断入口（基于现有产物/日志）：便于快速判断失败主因属于超时、空响应、解析失败或质量闸门失败。

- **M5.3c（分类导读）**
  - 在报告中为主要分类生成“分类导读（1 句）”，帮助读者先理解该分类的关注重点再进入正文。
  - 导读生成采用 LLM + 模板回退，失败时自动使用模板文案，不阻断报告生成。

## Impact
- Affected specs:
  - `openspec/specs/ai-reporting-pipeline/spec.md`

- Affected code（计划）:
  - `src/llm/summary.ts`
  - `src/pipeline/nodes.ts`
  - `src/core/types.ts`
  - `src/core/review-artifact.ts`
  - `src/report/markdown.ts`
  - `src/cli.ts`
  - `src/tools/*`（若新增/扩展诊断命令）
  - `tests/llm-summary.test.ts`
  - `tests/markdown-review.test.ts`
  - `tests/*`（新增诊断与回归测试）

- Affected docs（实施阶段同步）:
  - `docs/PRD.md`
  - `docs/architecture.md`
  - `docs/learning-workflow.md`
  - `docs/learning-sessions/m5-session-03-*.md`
