## Context
工程已经具备可运行的 M1 骨架（日报/周报流程、LangGraph 节点、Markdown 输出），但缺失 OpenSpec 变更记录，导致后续迭代难以审计需求与行为边界。

## Goals / Non-Goals
- Goals:
  - 为 M1 已实现行为建立可验证的 OpenSpec 基线。
  - 将文档治理规则纳入 spec，避免并行版本文档再次出现。
  - 完成一次端到端 change + archive，建立后续流程模板。
- Non-Goals:
  - 不在本次 change 中新增产品功能。
  - 不调整现有流水线算法或调度策略实现细节。

## Decisions
- Decision: 使用“backfill baseline”方式描述当前已实现行为，而非回滚重做。
  - Why: 保持代码与规范一致，避免额外返工。
- Decision: 拆分两个 capability。
  - `ai-reporting-pipeline` 负责运行行为与产出。
  - `project-document-governance` 负责文档唯一来源和同步维护规则。

## Risks / Trade-offs
- 风险：基线 requirement 若描述过粗，后续变更边界仍不清晰。
  - Mitigation：每条 requirement 强制包含 Scenario，使用 SHALL 语义。
- 取舍：先覆盖关键行为，不一次性写入所有低层实现细节。

## Migration Plan
1. 创建 change 文档与 spec deltas。
2. strict 校验通过后归档。
3. 以后所有能力变更必须新增 change 并更新相关 spec。

## Open Questions
- 无。
