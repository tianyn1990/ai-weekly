# Change: 飞书修订表单化与自动 recheck 可见性补齐

## Why
当前“要求修订”虽然已能触发后端 `request_revision -> auto recheck -> ReAct` 链路，但飞书主卡仍是固定按钮 reason（如“终稿需调整”），缺少自由文本修订输入，导致修订意图表达能力不足。

同时，审核动作触发的自动 recheck 任务来源为 `feishu_callback_auto`，现网通知策略默认不发送运行态进度回执，用户在飞书侧只能看到“已执行要求修订”，难以判断是否已入队、执行到哪一步、是否失败或卡住。

## What Changes
- 飞书审核卡中的“要求修订”从固定 reason 按钮升级为“修订表单入口”：
  - 必填：`revisionRequest`（自由文本）
  - 可选：`revisionScope`、`revisionIntent`、`continueFromCheckpoint`
- 回调处理支持并优先消费 `feedback` 结构化字段，保持对历史 reason-only 按钮的兼容。
- 自动 recheck 可观测性补齐：
  - `feishu_callback_auto` 任务也输出 `queued/started/progress/success/failed/cancelled` 生命周期可见回执（以单任务进度卡更新为主，文本回执为辅）。
- 修订失败恢复入口补齐：
  - 在失败/中断场景提供“编辑后重试 / 继续执行 / 直接通过并发布”动作卡。
- 增加自动 recheck 卡住防护（wall-clock timeout），避免长期 `running` 无终态。

## Impact
- Affected specs:
  - `ai-reporting-pipeline`
- Affected code (planned):
  - `src/review/feishu.ts`
  - `src/review/feedback-schema.ts`
  - `src/cli.ts`
  - `src/daemon/worker.ts`
  - `src/daemon/operation-job-store.ts`（若需补充状态快照字段）
  - `tests/feishu.test.ts`
  - `tests/operation-worker.test.ts`
  - `tests/revision-agent.test.ts`
- Docs to update during implementation:
  - `docs/PRD.md`
  - `docs/architecture.md`
  - `docs/learning-workflow.md`
  - `docs/learning-sessions/*`（新增会话并填写 3 分钟复盘）

## Risks
- 表单与恢复入口会增加飞书卡片复杂度，需控制默认路径清晰度。
- 自动 recheck 通知增强后可能增加消息频率，需通过单卡 upsert + 节流治理噪音。
- 超时中断策略需要避免误判正常长耗时任务。
