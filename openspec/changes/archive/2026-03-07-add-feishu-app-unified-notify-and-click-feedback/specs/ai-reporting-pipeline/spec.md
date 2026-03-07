## ADDED Requirements
### Requirement: Feishu callback SHALL provide explicit click feedback and status echo
系统 SHALL 在处理飞书卡片点击动作后向点击人提供明确反馈，并向群内输出当前状态回执，避免“点击后无感知”。

#### Scenario: Return success feedback when action is accepted
- **WHEN** 回调请求通过鉴权且审核动作成功写入持久化存储
- **THEN** 系统返回飞书可识别的成功反馈
- **AND** 反馈内容包含 reportDate 与动作类型

#### Scenario: Return failure feedback when action processing fails
- **WHEN** 回调请求鉴权失败或动作写入失败
- **THEN** 系统返回飞书可识别的失败反馈
- **AND** 反馈内容包含失败原因摘要

#### Scenario: Send status echo message to group after click handling
- **WHEN** 系统完成一次点击动作处理（成功或失败）
- **THEN** 系统向飞书群发送状态回执消息
- **AND** 回执至少包含 reportDate、action、operator、result、reviewStage、reviewStatus

#### Scenario: Persist callback handling audit after click action
- **WHEN** 系统处理一次飞书卡片点击动作
- **THEN** 系统记录结构化审计事件
- **AND** 审计事件至少包含 action、result、notifyResult、reportDate

## MODIFIED Requirements
### Requirement: Weekly pipeline SHALL notify review status via Feishu
系统 SHALL 在周报关键节点向 Feishu 发送通知，包括待审核通知、截止提醒和发布结果回执；通知通道 SHALL 使用飞书应用机器人（app-only）。

#### Scenario: App bot sends review notification and deadline reminder
- **WHEN** 周一 09:00 生成周报待审核版本
- **THEN** 系统通过飞书应用机器人发送待审核通知
- **AND** 系统在周一 11:30（Asia/Shanghai）发送一次截止前提醒通知

#### Scenario: App bot sends publish result callback
- **WHEN** 周报进入 `approved` 或 `timeout_published`
- **THEN** 系统通过飞书应用机器人发送发布结果回执
- **AND** 回执包含 reportDate、reviewStatus、publishReason

#### Scenario: Notification includes clickable report URL when public base is configured
- **WHEN** 系统配置 `REPORT_PUBLIC_BASE_URL`
- **THEN** 待审核与发布通知附加 `reviewUrl/publishedUrl` 字段
- **AND** URL 基于报告产物路径拼接后可直接访问

#### Scenario: M3.2 callback endpoint uses local service plus tunnel
- **WHEN** 系统启用 Feishu 回调
- **THEN** 回调入口 SHALL 由本地 HTTP 服务提供并通过隧道代理暴露公网地址
- **AND** 回调请求仍需通过签名或令牌校验后才写入审核指令
