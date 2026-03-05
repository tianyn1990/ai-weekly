# Change: 增加持久化审核指令源与 pending 周报复检发布能力

## Why
当前周报审核动作通过 CLI flags 注入（`--approve-outline` / `--approve-final`），适合本地演练但不适合真实团队协作与定时守护。缺少持久化审核指令后，流程无法由多人异步操作，也无法在后续轮询任务中复用已提交审核结果。

## What Changes
- 增加“审核指令存储抽象层”，首个实现采用文件存储（可演进到 DB/API）。
- 周报流程读取持久化审核指令，替代直接依赖 CLI flags 作为主要输入。
- 增加 pending 周报复检发布入口：不重新采集内容，仅对已生成周报执行“审核状态刷新 + 发布判定 + 产物更新”。
- 保留现有 CLI flags 作为兼容兜底（仅在未命中持久化指令时生效），避免中断现有学习脚本。
- 补充单测与文档，确保状态流转可验证、可追溯。

## Impact
- Affected specs: `ai-reporting-pipeline`
- Affected code:
  - `src/cli.ts`
  - `src/core/types.ts`
  - `src/pipeline/graph.ts`
  - `src/pipeline/nodes.ts`
  - `src/pipeline/review-policy.ts`
  - `src/report/markdown.ts`
  - `tests/*`
  - `docs/architecture.md`
  - `docs/learning-workflow.md`
  - `README.md`
