# Change: 新增 agent 分类并同步分类规范

## Why
当前分类规则将 `agent` 相关内容归入 `tooling`，不利于团队单独追踪 Agent 工程实践。需要新增独立 `agent` 分类，提升报告可读性与分析颗粒度。

## What Changes
- 在分类规则中新增 `agent` 分类，并将 `agent/agentic` 关键词优先归入该分类。
- 同步更新架构文档中的分类说明。
- 更新 OpenSpec 的 `ai-reporting-pipeline` spec，明确流程支持 `agent` 分类。

## Impact
- Affected specs:
  - `ai-reporting-pipeline`
- Affected code:
  - `src/core/types.ts`
  - `src/core/utils.ts`
  - `src/pipeline/nodes.ts`
  - `docs/architecture.md`
