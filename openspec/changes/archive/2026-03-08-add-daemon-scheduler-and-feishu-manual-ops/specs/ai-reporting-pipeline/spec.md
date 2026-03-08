## ADDED Requirements

### Requirement: System SHALL support daemon-based continuous automation
系统 SHALL 提供常驻 daemon 运行模式，自动执行报告生成、审核提醒与 watchdog 巡检，无需人工手动触发 CLI。

#### Scenario: Daemon triggers scheduled jobs at configured windows
- **WHEN** daemon 已启动并进入调度循环
- **THEN** 系统在配置时间自动触发 daily/weekly/reminder/watchdog 任务
- **AND** 每个任务执行结果可被记录与查询

#### Scenario: Daemon performs compensation scan after restart
- **WHEN** daemon 重启或从休眠恢复
- **THEN** 系统执行补偿扫描以处理错过的关键时间窗口
- **AND** 不重复执行已完成且无变更价值的任务

### Requirement: System SHALL support manual operations via Feishu mention and operation card
系统 SHALL 支持在 Feishu 群内通过 @应用机器人获取主动触发操作卡，并通过卡片按钮触发常见运维动作。

#### Scenario: Mention bot returns operation card
- **WHEN** 用户在群内 @应用机器人并触发运维指令
- **THEN** 系统返回包含常见操作按钮的运维卡片
- **AND** 卡片至少支持 run/recheck/watchdog/reminder/status 查询

#### Scenario: Operation card click enqueues async job
- **WHEN** 用户点击运维卡片中的某个动作按钮
- **THEN** 系统先返回“已接收”反馈并创建 operation job
- **AND** 由后台 worker 异步执行该任务并回执最终结果

### Requirement: System SHALL auto-trigger recheck after accepted review action callback
系统 SHALL 在审核动作回调成功写入后自动触发对应 recheck 流程，避免人工补执行命令。

#### Scenario: Approve outline callback auto advances to final review
- **WHEN** 回调写入 `approve_outline` 且动作受理成功
- **THEN** 系统自动触发该 reportDate 的 recheck job
- **AND** 周报状态推进到 `final_review`（若无冲突动作）

#### Scenario: Approve final callback auto publishes after recheck
- **WHEN** 回调写入 `approve_final` 且动作受理成功
- **THEN** 系统自动触发 recheck job
- **AND** 在发布条件满足时完成发布并输出发布回执

### Requirement: System SHALL auto-sync report artifacts and review state to Git repository
系统 SHALL 支持把关键报告产物与审核状态文件自动同步到 Git 仓库，以保障远程可读与可审阅。

#### Scenario: Auto commit and push when tracked artifacts changed
- **WHEN** 待审核/已发布/审核指令/runtime config 在受控路径产生变更
- **THEN** 系统自动执行 add/commit/push
- **AND** commit 信息包含 reportDate、runId 或触发来源等可追踪字段

#### Scenario: Skip git sync when no tracked changes
- **WHEN** 受控路径没有文件内容变更
- **THEN** 系统跳过 commit/push
- **AND** 不产生空提交

#### Scenario: Push supports optional proxy environment injection
- **WHEN** 配置 `GIT_PUSH_HTTP_PROXY` 或 `GIT_PUSH_HTTPS_PROXY`
- **THEN** 系统在 push 阶段注入代理环境变量
- **AND** 未配置时保持默认网络行为不变

## MODIFIED Requirements

### Requirement: Weekly pipeline SHALL notify review status via Feishu
系统 SHALL 在周报关键节点向 Feishu 发送通知，包括待审核通知、截止提醒、发布结果回执与主动触发操作回执；通知通道 SHALL 使用飞书应用机器人（app-only）。

#### Scenario: Review callback returns immediate acceptance and async execution notice
- **WHEN** 用户点击审核动作或运维操作卡按钮
- **THEN** 系统立即返回 toast/回执说明“动作已受理并进入后台执行”
- **AND** 后续执行完成后再发送最终状态结果消息

#### Scenario: Mention-driven operation result is reported back to group
- **WHEN** 通过 @机器人触发的后台任务执行完成
- **THEN** 系统向群内发送任务结果回执（success/failed）
- **AND** 回执包含关键上下文（action、reportDate、结果摘要）

### Requirement: Processing pipeline SHALL generate review artifacts with traceable metadata
系统 SHALL 在每次执行后产出待审核报告文件与结构化元数据文件，且关键状态文件可按配置进入 Git 同步路径，便于人工审核与后续发布。

#### Scenario: Review artifacts become remotely reviewable after git sync
- **WHEN** 周报产物写入受控目录并触发自动 git 同步成功
- **THEN** 审核人可通过仓库链接访问对应内容
- **AND** 飞书通知中的可点击链接指向已同步版本
