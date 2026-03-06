## MODIFIED Requirements
### Requirement: Weekly pipeline SHALL support human review gates before publish
系统 SHALL 在 weekly 模式提供审核断点，至少包含大纲审核与终稿审核两个阶段，并从持久化审核指令源读取审核动作；审核指令源 SHALL 支持 Feishu 审核动作回写，CLI 参数仅作为兼容兜底输入。

#### Scenario: Review action is written from Feishu callback
- **WHEN** 审核人在 Feishu 审核卡片中执行审核动作
- **THEN** 系统将该动作写入持久化审核指令源
- **AND** 后续 recheck/watchdog 读取该动作并执行状态流转

#### Scenario: Approve outline action advances review stage
- **WHEN** 审核人在 Feishu 提交 `approve_outline`
- **THEN** 系统将审核阶段从 `outline_review` 推进到 `final_review`

#### Scenario: Approve final action publishes approved version
- **WHEN** 审核人在 Feishu 提交 `approve_final`
- **THEN** 系统将周报状态更新为 `approved`
- **AND** 系统发布审核通过版本

#### Scenario: CLI fallback is used when Feishu callback is unavailable
- **WHEN** Feishu 回调链路不可用或回写失败
- **THEN** 系统允许通过 CLI 参数作为审核动作兜底输入
- **AND** 不影响周一 12:30 超时发布规则

#### Scenario: Group members can review and latest decision wins
- **WHEN** 群内多个成员对同一 reportDate 的同一 stage 提交审核动作
- **THEN** 系统接受群内任意成员动作
- **AND** 以最新 `decidedAt` 对应的动作作为有效决策（last-write-wins）

## ADDED Requirements
### Requirement: Weekly pipeline SHALL notify review status via Feishu
系统 SHALL 在周报关键节点向 Feishu 发送通知，包括待审核通知、截止提醒和发布结果回执。

#### Scenario: Weekly report sends review notification and deadline reminder
- **WHEN** 周一 09:00 生成周报待审核版本
- **THEN** 系统向 Feishu 发送待审核通知
- **AND** 系统在周一 11:30（Asia/Shanghai）发送一次截止前提醒通知

#### Scenario: Weekly report sends publish result callback
- **WHEN** 周报进入 `approved` 或 `timeout_published`
- **THEN** 系统向 Feishu 发送发布结果回执
- **AND** 回执包含 reportDate、reviewStatus、publishReason

#### Scenario: M3.2 callback endpoint uses local service plus tunnel
- **WHEN** 系统处于 M3.2 阶段并启用 Feishu 回调
- **THEN** 回调入口 SHALL 由本地 HTTP 服务提供并通过隧道代理暴露公网地址
- **AND** 回调请求仍需通过签名或令牌校验后才写入审核指令
