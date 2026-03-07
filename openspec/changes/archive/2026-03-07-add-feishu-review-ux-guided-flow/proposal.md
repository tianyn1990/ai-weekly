# Change: 飞书审核协同交互重构（M4.2）

## Why
当前飞书审核链路在“功能可用”层面已打通，但在“使用体验”层面存在明显问题：
- 审核消息由系统字段驱动，阅读门槛高，用户无法快速理解“当前状态 + 下一步动作”。
- 卡片按钮在不同阶段同时展示，缺少阶段约束，易误操作。
- 回执消息偏技术化，且重复回调会造成群内噪音，影响协作效率。
- 通知中的本地文件路径不可直接访问，虽已支持 URL 拼接，但未形成统一的引导文案规范。

该问题会直接影响审核效率、误操作率与团队对系统状态的信任度，因此需要做一轮以审核者为中心的交互重构。

## What Changes
- 新增“阶段引导式审核卡片”规范：
  - 按 `outline_review` / `final_review` / 结束态展示不同文案与动作集合。
  - 明确展示“当前状态、下一步建议、截止时间、可点击报告链接”。
- 新增“单轮单主卡”策略：
  - 同一 `reportDate + runId` 仅保留 1 条主审核卡作为操作入口。
  - 阶段变化优先更新主卡内容，避免重复发卡刷屏。
- 重构回执文案：
  - toast 与群内回执都改为用户可读短句。
  - 默认隐藏技术字段（traceId/messageId），仅在 debug 模式展示。
- 增强去噪与幂等体验：
  - 重复回调不重复群发回执，改为“已处理/忽略重复提交”反馈。
- 统一可点击链接表达：
  - 通知内用“查看待审核稿 / 查看已发布稿”替代路径式字段堆叠。

## Impact
- Affected specs:
  - `ai-reporting-pipeline`
- Affected code:
  - `src/review/feishu.ts`
  - `src/tools/feishu-ops.ts`（卡片模板）
  - `src/cli.ts`
  - `src/review/instruction-store.ts`（幂等行为协同）
  - `tests/feishu.test.ts`
  - `tests/review-instruction*.test.ts`
  - `README.md`
  - `docs/PRD.md`
  - `docs/architecture.md`
  - `docs/learning-workflow.md`
