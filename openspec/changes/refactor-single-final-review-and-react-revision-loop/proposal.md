# Change: 单阶段终稿审核与 ReAct 修订回路重构

## Why
当前周报采用 `outline_review + final_review` 双阶段人工审核，但在现网内容形态下“大纲稿”与“终稿”差异有限，双阶段带来额外操作成本与误触概率。
同时，现有 `request_revision` 主要依赖结构化字段，难以承载“多条自然语言修订意见、跨模块调整、复杂改写意图”等真实协作需求，导致修订效率与可用性不足。

## What Changes
- 将周报审核流从双阶段改为单阶段：`final_review`。
- 保留对历史动作与历史产物的兼容读取：旧动作 `approve_outline` 不再推进阶段，而是返回兼容提示并引导使用终稿通过动作。
- 引入受限 ReAct 修订 Agent：
  - 输入以“自由文本修订意见”为主，支持一次输入多条意见。
  - Agent 通过可控工具集执行修订（定位、patch、重排、重建、校验），而非直接整文重写。
  - Agent 循环可配置并带总耗时护栏，默认 `REVISION_AGENT_MAX_WALL_CLOCK_MS=600000`（10 分钟）。
- 修订失败与不确定场景提供清晰回执：
  - 失败原因分型（规划失败、目标不唯一、工具失败、校验失败、超步数/超时等）。
  - 支持“编辑意见后重试”“继续执行未完成任务”“直接通过审核发布”三类后续动作。
- 飞书交互升级：
  - `要求修订` 入口使用“自由文本 + 可选范围/意图”表单。
  - 回执中包含“成功修改摘要 + 失败项原因 + 下一步操作入口”。

## Impact
- Affected specs:
  - `ai-reporting-pipeline`
- Affected code (planned):
  - `src/pipeline/review-policy.ts`
  - `src/pipeline/nodes.ts`
  - `src/review/feishu.ts`
  - `src/review/feedback-schema.ts`
  - `src/review/feedback-executor.ts`
  - `src/cli.ts`
  - `src/daemon/*`
  - `tests/*`（审核流、回调、修订执行、Agent 节点、失败回执）
- Risk:
  - 审核状态机从双阶段改为单阶段，需保证历史 artifact 与历史回调不崩溃。
  - ReAct 修订引入多步调用，需通过步骤上限、总耗时上限、工具白名单与严格校验控制风险。
