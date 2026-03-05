# Change: 增加周报审核断点与超时自动发布流程

## Why
当前 M1 仅能生成待审核文稿，尚未实现审核状态流转与自动发布守护逻辑，无法完整满足“周一 09:00 待审，12:30 未审自动发布”的业务规则。

## What Changes
- 在周报流程中新增审核状态模型与两段 Human-in-the-loop 断点（大纲审核、终稿审核）。
- 新增发布决策逻辑：截止时间前等待人工审核，超时自动发布当前版本。
- 新增发布记录与状态追踪输出，保证可回溯。
- 保持日报路径为无强制审核模式，不引入额外阻塞。

## Impact
- Affected specs:
  - `ai-reporting-pipeline`
- Affected code:
  - `src/core/types.ts`
  - `src/pipeline/graph.ts`
  - `src/pipeline/nodes.ts`
  - `src/cli.ts`
  - `src/report/markdown.ts`
  - `docs/architecture.md`
