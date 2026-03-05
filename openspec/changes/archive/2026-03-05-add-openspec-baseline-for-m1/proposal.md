# Change: 补齐 M1 的 OpenSpec 基线并切换为 spec-driven 维护

## Why
当前工程已完成 M1 框架与首个 LangGraph 流程，但这些能力尚未纳入 OpenSpec 规范，后续迭代缺少统一的 spec 基线与变更轨迹。

## What Changes
- 新增 `ai-reporting-pipeline` capability 的基线 spec，覆盖当前 M1 已实现行为。
- 新增 `project-document-governance` capability 的基线 spec，约束 PRD/架构/学习文档唯一来源与同步更新规则。
- 将本次 backfill change 完成归档，使后续迭代直接在 OpenSpec 流程中开展。

## Impact
- Affected specs:
  - `ai-reporting-pipeline`
  - `project-document-governance`
- Affected code:
  - `src/cli.ts`
  - `src/pipeline/graph.ts`
  - `src/pipeline/nodes.ts`
  - `src/report/markdown.ts`
  - `AGENTS.md`
  - `docs/PRD.md`
  - `docs/architecture.md`
  - `docs/learning-workflow.md`
