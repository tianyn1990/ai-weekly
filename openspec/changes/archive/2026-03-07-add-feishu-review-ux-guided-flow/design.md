## Context
M4.1 已完成飞书 app-only 通知与点击反馈闭环，但当前交互仍偏系统内部模型，缺乏审核者视角的任务引导。用户主要痛点：
1. 不清楚当前处于哪个审核阶段；
2. 不知道“现在应该点哪个按钮”；
3. 回执文本技术细节过多、业务语义不足；
4. 消息数量偏多，难以判断哪条是最新有效入口。

本次设计目标是在不改变审核状态机语义的前提下，重构消息组织与卡片文案，实现“低认知负担 + 强引导 + 低噪音”。

## Goals / Non-Goals
- Goals:
  - 审核者 10 秒内可判断“当前状态 + 下一步动作”。
  - 同一轮审核只保留一个主操作入口（主卡）。
  - 回执信息业务化表达，减少技术字段暴露。
  - 保持现有状态机语义：last-write-wins、reject 终止当前 run、recheck/watchdog 规则不变。
- Non-Goals:
  - 本阶段不改审核权限模型（仍为群内任意成员可操作）。
  - 本阶段不引入飞书后台管理 UI。
  - 本阶段不引入分布式通知调度系统。

## Key Decisions
- Decision 1: 使用“阶段引导式卡片模板”。
  - outline 阶段仅暴露大纲相关动作；final 阶段仅暴露终稿相关动作。
  - 每张卡包含：状态标签、下一步建议、截止时间、核心链接。

- Decision 2: 使用“单轮单主卡”与“卡片更新优先”策略。
  - `reportDate + runId` 作为主卡逻辑键。
  - 阶段推进时优先更新主卡；更新失败再降级发送新卡并标注替换提示。

- Decision 3: 回执采用双层反馈但简化文案。
  - 点击人即时 toast：短句描述处理结果。
  - 群内回执：事件摘要 + 当前阶段/是否完成。
  - 默认不展示 traceId/messageId；新增 debug 开关按需展开。

- Decision 4: 重复回调不重复广播。
  - 命中幂等判重后，返回“重复已忽略”toast。
  - 群内不追加同类回执，降低噪音。

- Decision 5: 链接展示从“路径字段”改为“动作型文案”。
  - 当存在 `REPORT_PUBLIC_BASE_URL` 时展示：`查看待审核稿` / `查看已发布稿`。
  - 本地路径保留在 debug 信息中。

## Interaction Contract
### 主卡结构（示意）
- 标题：`AI 周报审核任务（YYYY-MM-DD）`
- 状态块：`当前状态：待大纲审核 | 待终稿审核 | 已发布 | 已拒绝`
- 行动块：
  - `下一步：请先阅读重点摘要，再执行对应审核动作`
- 链接块：
  - `查看待审核稿`（reviewUrl）
  - `查看已发布稿`（publishedUrl，可选）
- 按钮块（阶段化）

### 回执文案（示意）
- 成功：`王小明 已通过大纲，系统进入终稿审核。`
- 终稿通过：`王小明 已通过终稿，本期周报已发布。`
- 修订：`王小明 提交了修订请求，请处理后重新终稿审核。`
- 重复：`该动作已处理，忽略重复提交。`

## Message Flow
```text
weekly run pending
  -> upsert 主审核卡（outline 模板）
  -> user click action
  -> callback auth + dedupe
  -> append instruction
  -> toast(result)
  -> 群回执（非重复）
  -> recheck
  -> upsert 主审核卡（final / completed 模板）
```

## Failure Handling
- 主卡更新失败：降级发送新卡，并在回执中说明“已创建新入口”。
- URL 不可用：主卡仍可发送，但链接区块显示“未配置公开地址”。
- 回执发送失败：不影响动作写入；记录 `notifyResult=failed` 审计。

## Risks / Trade-offs
- 卡片更新逻辑增加状态管理复杂度。
  - Mitigation: 先以文件/DB 记录主卡 message_id，保持可恢复。
- 文案简化可能影响排障信息获取。
  - Mitigation: 提供 debug 开关，在故障排查时输出技术字段。

## Migration Plan
1. 保持当前 API 契约不变，先替换卡片模板与回执文案。
2. 增加主卡记录存储（message_id + reportDate + runId + stage）。
3. 在 pending 通知、recheck、publish 通知路径统一走 `upsertMainReviewCard`。
4. 完成联调后更新文档与学习材料。

## Open Questions
- 是否需要在飞书卡片内提供“查看修订差异”入口（后续可选增强）。
