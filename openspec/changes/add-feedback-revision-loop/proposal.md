# Change: 增加审核意见回流修订与打回重跑约束（M3.3）

## Why
M3.2 已完成 Feishu 协同入口（通知、回调、提醒、fallback），但 `request_revision` 与 `reject` 仍停留在“记录动作”层，没有形成可执行的修订闭环。当前需要把审核意见转成可执行指令，确保人工反馈可以沉淀为产出质量与后续周期配置的持续改进。

## What Changes
- 增加审核意见回流指令模型（结构化、可校验、可审计），覆盖以下能力：
  - 候选条目新增/删除
  - 主题词与搜索词新增
  - 来源启停调整
  - 来源权重调整
  - 排序权重调整
  - editor notes（仅记录，不自动执行）
- 新增“回流执行器（feedback executor）”，在已有待审核快照基础上执行修订并重建终稿。
- 打通 `request_revision -> revised -> final_review` 状态流转，兼容 recheck/watchdog 路径。
- 落地全局配置写入：来源启停、来源权重、排序权重变更写入全局配置，并在后续 run 生效。
- 强化 `reject` 语义：同一 reportDate 被 reject 后，当前 run 不得继续推进发布，必须新建 run 才能重新进入发布流程。
- 增加审计日志：记录回流指令、执行结果与关键差异摘要，便于追溯。

## Impact
- Affected specs: `ai-reporting-pipeline`
- Affected code:
  - `src/core/types.ts`
  - `src/review/instruction-store.ts`
  - `src/pipeline/recheck.ts`
  - `src/pipeline/graph.ts`
  - `src/pipeline/nodes.ts`
  - `src/pipeline/watchdog.ts`
  - `src/report/markdown.ts`
  - `src/config/*`（若新增全局配置存储模块）
  - `tests/*`
  - `README.md`
  - `docs/architecture.md`
  - `docs/learning-workflow.md`
