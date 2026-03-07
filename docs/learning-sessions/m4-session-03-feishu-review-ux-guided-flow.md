# M4 学习复盘 03：Feishu 审核交互重构（阶段主卡 + 单卡更新 + 去噪回执）

## 1. 本次实现了什么
- 审核通知从“多条信息堆叠”重构为“单主卡引导式交互”。
- 主卡支持按阶段动态渲染：
  - `outline_review`：仅显示大纲相关动作。
  - `final_review`：仅显示终稿相关动作。
  - `published/rejected`：显示结束态，不再提供可执行动作。
- 新增主卡 upsert 机制：同一 `reportDate + runId` 优先更新卡片，失败自动降级新发。
- 回调交互去噪：
  - 点击端即时 toast（success/error）。
  - 重复回调返回“已忽略重复提交”，不重复群发回执。
- 通知文案改为用户视角：突出“当前状态 + 下一步 + 可点击链接”。

## 2. 流程图（M4.2）
```text
pending review (run/recheck/watchdog)
  -> upsert 主审核卡（同 run PATCH，失败则新发）
  -> 审核人点击卡片动作
  -> callback 鉴权 + payload 适配 + 幂等判重
  -> 写入审核指令
  -> 回调 toast 反馈
  -> 群内动作回执（仅非重复）
  -> recheck 后再次 upsert 主卡到下一阶段
```

## 3. 源码导读（建议阅读顺序）
1. `src/review/feishu.ts`
- 看 `notifyReviewPending` 与 `buildReviewMainCard`：理解阶段化文案与动作集合。
- 看 `upsertMainReviewCard`：理解“更新优先 + 新发降级”的入口稳定性策略。
- 看 `startFeishuReviewCallbackServer`：理解“幂等去重 + toast + 回执解耦”。

2. `src/cli.ts`
- 看 `notifyReviewPendingIfNeeded`：理解为何 run/recheck/watchdog 都会触发主卡更新。
- 看 `createFeishuNotifier`：理解 app-only 通道配置注入点。

3. `src/review/instruction-store.ts`
- 看 `findDuplicateInstruction`：理解 traceId/messageId 组合去重策略。

4. `tests/feishu.test.ts`
- 看“阶段按钮”“主卡更新失败降级”“重复回调不重复回执”等用例，理解行为边界。

## 4. 验证结果
- `pnpm test tests/feishu.test.ts`：通过（16 tests）。
- `pnpm test`：通过（16 files / 69 tests）。
- `pnpm build`：通过。
- `openspec validate add-feishu-review-ux-guided-flow --strict`：通过。
- `openspec validate --specs --strict`：通过。

## 5. 3 分钟复盘模板（M4.2 版本）
```text
【1】本轮目标（30s）
- 我本轮要验证的能力点是：飞书审核交互是否能让审核人快速知道“当前状态 + 下一步动作”。
- 我完成后的可见结果是：同一轮仅一个主审核卡，阶段切换时卡片更新，点击后有即时反馈且群内不刷屏。

【2】关键实现（60s）
- 我改了哪 3 个核心文件：
  1) `src/review/feishu.ts`
  2) `src/cli.ts`
  3) `tests/feishu.test.ts`
- 每个文件“为什么要改”：
  - `feishu.ts`：落地主卡 upsert、阶段化按钮、业务化回执与重复回调去噪。
  - `cli.ts`：让 run/recheck/watchdog 都能驱动主卡状态同步，避免卡片状态滞后。
  - `feishu.test.ts`：覆盖阶段化按钮、更新失败降级、重复回调幂等等关键路径。

【3】运行验证（45s）
- 我执行的命令：
  - `pnpm test tests/feishu.test.ts`
  - `pnpm test`
  - `pnpm build`
  - `openspec validate add-feishu-review-ux-guided-flow --strict`
- 结果是否符合预期：符合，核心行为与回归测试均通过。
- 有无 warning/边界场景：
  - 有，主卡更新失败时会自动新发并覆盖 messageId。
  - 有，重复回调只做 toast 提示，不重复群发回执。

【4】设计取舍（30s）
- 我放弃了哪个方案，原因是：放弃“每个阶段都新发卡片”，因为噪音高且入口混乱。
- 当前实现的风险点是：主卡记录落盘与飞书 message 生命周期可能不一致；已通过“更新失败自动新发”降低不可用风险。

【5】下一步（15s）
- 我下一轮最小可执行目标是：进入 M5，先在报告生成链路接入 LLM 总结节点，并保持规则链路可回退。
```
