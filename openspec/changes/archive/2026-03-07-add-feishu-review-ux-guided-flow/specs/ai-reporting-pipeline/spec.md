## ADDED Requirements
### Requirement: Feishu review interaction SHALL provide stage-guided and user-readable experience
系统 SHALL 提供以审核者为中心的飞书交互体验，确保用户可快速理解当前阶段、下一步动作与流程结果。

#### Scenario: Outline stage card shows only relevant actions and guidance
- **WHEN** 周报处于 `outline_review` 阶段
- **THEN** 主卡仅展示大纲阶段相关动作
- **AND** 主卡明确展示“当前状态、下一步建议、截止时间、查看待审核稿链接”

#### Scenario: Final stage card shows only final-review actions
- **WHEN** 周报处于 `final_review` 阶段
- **THEN** 主卡仅展示终稿阶段相关动作
- **AND** 不展示与当前阶段无关的按钮

#### Scenario: Action receipt uses concise business wording
- **WHEN** 用户在飞书点击审核动作且系统处理完成
- **THEN** toast 与群内回执使用业务化短句描述结果
- **AND** 默认不展示 traceId/messageId 等技术字段

#### Scenario: Duplicate callback should not spam group receipts
- **WHEN** 同一审核事件被重复回调且命中幂等判重
- **THEN** 系统返回“重复已忽略”反馈
- **AND** 群内不重复发送同类动作回执

## MODIFIED Requirements
### Requirement: Weekly pipeline SHALL notify review status via Feishu
系统 SHALL 在周报关键节点向 Feishu 发送通知，包括待审核通知、截止提醒和发布结果回执，并以“单轮单主卡”作为主要审核入口。

#### Scenario: Weekly report maintains a single main review card per run
- **WHEN** 某 `reportDate + runId` 首次进入待审核
- **THEN** 系统创建主审核卡
- **AND** 后续阶段变化优先更新该主卡，而非重复创建多张操作卡

#### Scenario: System falls back to send a new card when update fails
- **WHEN** 主卡更新失败（例如 message_id 失效）
- **THEN** 系统降级发送新主卡
- **AND** 回执中提示已创建新的审核入口

#### Scenario: Notification displays user-friendly report links
- **WHEN** 系统已配置 `REPORT_PUBLIC_BASE_URL`
- **THEN** 通知中显示“查看待审核稿 / 查看已发布稿”可点击链接
- **AND** 链接指向对应 reportDate 的产物路径
