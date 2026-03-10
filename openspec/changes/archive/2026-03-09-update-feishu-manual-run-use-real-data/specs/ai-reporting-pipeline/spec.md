## MODIFIED Requirements
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

#### Scenario: Manual run action uses real data by default
- **WHEN** 用户在运维卡点击 `run_weekly`（生成周报）
- **THEN** 后台任务使用真实数据源采集（`mock=false`）执行流程
- **AND** 若需 mock 演练，应通过 CLI `--mock` 显式触发
