# Change: 增加 M5.1 LLM 逐条总结节点（MiniMax 优先）

## Why
当前报告已具备稳定的采集、审核、发布与协同闭环，但“重点摘要”仍主要依赖规则文本拼接，可读性与信息压缩质量存在上限。项目进入 M5 阶段后，需要先在不破坏主流程稳定性的前提下，引入 LLM 总结增强能力，并满足团队“工程实践优先、覆盖优先、可回退、可审计”的要求。

## What Changes
- 在 pipeline 中新增 `llm_summarize` 节点，位置位于 `publish_or_wait -> build_report` 之间。
- 总结策略采用“逐条总结 + 聚合重点”：
  - 先对每条候选内容独立生成结构化摘要（不将全部候选一次性输入单个 prompt）。
  - 再从逐条摘要中聚合生成“快速重点”，条目数自适应 `4-12` 条。
- 报告模式覆盖 `daily` 与 `weekly`，两者均启用 LLM 总结增强。
- 供应商优先接入 `MiniMax`，并建立 provider 抽象，后续可扩展 OpenAI/Anthropic。
- 增加严格回退策略：
  - LLM 调用失败、超时、响应解析失败、证据校验失败时，自动回退到规则摘要。
  - 回退不得阻断审核、发布、watchdog、daemon 调度。
- 增加 LLM 执行审计：记录 provider/model/promptVersion/耗时/失败原因/回退原因。
- 增加飞书告警：当单次 run 发生 LLM 降级时，按 run 维度合并发送 1 条告警（避免刷屏）。

## Impact
- Affected specs: `ai-reporting-pipeline`
- Affected code (planned):
  - `src/pipeline/graph.ts`
  - `src/pipeline/nodes.ts`
  - `src/pipeline/recheck.ts`
  - `src/core/types.ts`
  - `src/core/review-artifact.ts`
  - `src/report/markdown.ts`
  - `src/review/feishu.ts`
  - `src/audit/*`
  - `src/cli.ts`
  - `tests/*`
  - `README.md`
  - `docs/PRD.md`
  - `docs/architecture.md`
  - `docs/learning-workflow.md`
