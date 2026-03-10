## MODIFIED Requirements
### Requirement: System SHALL support manual operations via Feishu mention and operation card
系统 SHALL 支持在 Feishu 群内通过 @应用机器人获取主动触发操作卡，并通过卡片按钮触发常见运维动作。

#### Scenario: Mention bot returns operation card
- **WHEN** 用户在群内 @应用机器人并触发运维指令
- **THEN** 系统返回包含常见操作按钮的运维卡片
- **AND** 卡片至少支持日报/周报 run、recheck、watchdog、reminder、status 查询

#### Scenario: Operation card click enqueues async job
- **WHEN** 用户点击运维卡片中的某个动作按钮
- **THEN** 系统先返回“已接收”反馈并创建 operation job
- **AND** 由后台 worker 异步执行该任务并回执最终结果

#### Scenario: Manual daily run action is available in operation card
- **WHEN** 用户打开运维操作卡
- **THEN** 卡片包含 `run_daily` 动作入口（生成日报）
- **AND** 该动作沿用“入队异步执行 + 回执”流程
