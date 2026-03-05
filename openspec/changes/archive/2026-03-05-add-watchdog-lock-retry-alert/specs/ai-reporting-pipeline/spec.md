## MODIFIED Requirements
### Requirement: Weekly pipeline SHALL provide watchdog scan for pending reports
系统 SHALL 提供 watchdog 扫描能力，用于批量检测并处理 pending 周报，以支持定时任务自动触发复检发布；watchdog 执行过程 SHALL 具备单实例互斥、失败重试与结构化摘要输出。

#### Scenario: Watchdog exits when lock is already held
- **WHEN** watchdog 启动时发现 lock 文件已存在
- **THEN** 当前实例不执行扫描与复检
- **AND** 输出锁冲突提示并安全退出

#### Scenario: Watchdog retries transient recheck failure
- **WHEN** 某待处理周报在首次复检时发生可重试错误
- **THEN** watchdog 在配置次数内执行重试
- **AND** 若重试成功则该报告继续按成功路径统计

#### Scenario: Watchdog writes structured summary for monitoring
- **WHEN** watchdog 一次执行完成
- **THEN** 系统在 `outputs/watchdog/weekly/` 写入结构化 summary 文件
- **AND** summary 至少包含 processed、published、skipped、failed 与逐条结果
