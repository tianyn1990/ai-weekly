# M5 学习复盘 08：单阶段终稿审核 + 受限 ReAct 修订回路

## 1. 本次实现了什么
- 周报审核状态机由“双阶段（outline + final）”收敛为“单阶段 `final_review`”。
- 保留 `approve_outline` 历史兼容，不再作为真实审核门，只返回兼容提示并继续停留在终稿审核。
- 新增 `revision-agent`：支持自由文本修订请求，按“Planner -> 白名单工具执行 -> 校验/审计”循环落地。
- 新增 checkpoint 续跑能力：当步骤/时间/错误预算超限时，落盘未完成任务，下次可 `continueFromCheckpoint` 继续执行。
- ReAct 失败时 fail-soft 回退到既有 `feedback-executor`，保证主流程可继续。

## 2. 流程图（本次增量）
```text
weekly review flow
  -> review_outline (compat only)
  -> review_final (single gate)
     -> approve_final => publish
     -> request_revision => revision-agent
         -> planner(llm)
         -> restricted tools
         -> checkpoint(optional)
         -> fallback executor(if needed)
         -> back to final_review
```

## 3. 源码导读（建议顺序）
1. `src/pipeline/review-policy.ts`
- 发布判定改为 `finalApproved` 即可发布。
- `resolvePendingStage` 单阶段下统一返回 `final_review/none`。

2. `src/pipeline/nodes.ts`
- `createInitialState` weekly 默认 `reviewStage=final_review`、`outlineApproved=true`。
- `reviewOutlineNode` 保留为兼容节点，不再阻塞流程。
- `reviewFinalNode` 接入 `executeRevisionWithAgent`，并保留 fail-soft fallback。

3. `src/review/revision-agent.ts`
- ReAct 执行主循环与白名单工具。
- Planner 严格 JSON contract + 重试退避。
- checkpoint 读写与失败分类。

4. `src/review/feedback-schema.ts`
- 新增自由文本修订字段归一化：
  - `revisionRequest`
  - `revisionScope`
  - `revisionIntent`
  - `continueFromCheckpoint`

5. `src/review/feishu.ts`
- 主卡动作统一到终稿审核按钮集合。
- 修订失败回执补充“编辑后重试/直接发布”引导。

## 4. 运行验证
- `pnpm test`：通过（31 files / 168 tests）。
- `pnpm build`：通过。
- 新增测试：`tests/revision-agent.test.ts`
  - 自由文本新增候选
  - 自由文本删除条目
  - 步数超限 + checkpoint
  - checkpoint 续跑

## 5. 设计取舍
- 为什么不是“LLM 直接重写整篇 Markdown”：
  - 可控性和可审计性不足，易破坏证据链。
- 为什么保留 `review_outline` 节点：
  - 历史回调和历史 artifact 仍可能引用该阶段，直接删除会带来兼容风险。
- 为什么采用 fail-soft：
  - 修订能力增强不能反向拖垮审核主链路。

## 6. 3 分钟复盘模板（已填写）
```text
【1】本轮目标（30s）
- 我本轮要验证的能力点是：把周报审核收敛为单阶段，并让自由文本修订真正可执行。
- 我完成后的可见结果是：final_review 成为唯一审核门，request_revision 可走 ReAct 执行并支持续跑。

【2】关键实现（60s）
- 我改了哪 3 个核心文件：
  1) src/pipeline/review-policy.ts + src/pipeline/nodes.ts
  2) src/review/revision-agent.ts
  3) src/review/feedback-schema.ts + src/review/feishu.ts
- 每个文件“为什么要改”：
  - pipeline：把状态机从双阶段切到单阶段并保持兼容。
  - revision-agent：承接自然语言修订，提供多步可控执行。
  - schema/feishu：让自由文本字段可落地，并让交互入口与回执符合新流程。

【3】运行验证（45s）
- 我执行的命令：
  - pnpm test
  - pnpm build
- 结果是否符合预期：符合。
- 有无 warning/边界场景：
  - ReAct 超预算会中断并写 checkpoint，属于预期保护行为。

【4】设计取舍（30s）
- 我放弃了哪个方案，原因是：放弃整文重写方案，避免结构漂移与证据失配。
- 当前实现的风险点是：Planner 输出质量受模型波动影响，需要靠重试与回退兜底。

【5】下一步（15s）
- 我下一轮最小可执行目标是：在飞书“要求修订”入口补齐更友好的表单与失败恢复交互（编辑后重试/继续执行）。
```
