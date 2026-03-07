## ADDED Requirements
### Requirement: Review instruction persistence SHALL be database-backed and append-only
系统 SHALL 将审核动作持久化到数据库事件表，并采用 append-only 语义保存完整动作历史，确保可追溯与可重放。

#### Scenario: Persist review action with full audit metadata
- **WHEN** Feishu 回调或 CLI/API 提交一条审核动作
- **THEN** 系统将动作写入数据库事件表并生成唯一记录
- **AND** 记录至少包含 mode、reportDate、stage、action、decidedAt、source、operator、traceId

#### Scenario: Resolve latest effective action by last-write-wins
- **WHEN** 同一 reportDate 同一 stage 存在多条审核动作
- **THEN** 系统按 decidedAt 最新优先选择有效动作
- **AND** 当 decidedAt 相同，系统按写入序最新记录作为有效动作

### Requirement: Runtime configuration SHALL be versioned with optimistic concurrency control
系统 SHALL 使用版本化存储维护 runtime 配置，并在更新时执行乐观并发控制，避免并发写入覆盖。

#### Scenario: Update runtime config with expected version
- **WHEN** 客户端携带 expectedVersion 提交配置变更
- **AND** expectedVersion 与当前版本一致
- **THEN** 系统创建新版本配置并返回最新 version

#### Scenario: Reject stale runtime config update
- **WHEN** 客户端提交的 expectedVersion 落后于当前版本
- **THEN** 系统返回冲突错误（409）
- **AND** 不写入新版本配置

### Requirement: System SHALL expose minimum review and audit APIs
系统 SHALL 提供最小 API 能力以支持审核协同与运维排查，至少包括审核动作写入/查询、runtime 配置读写、审计事件查询。

#### Scenario: Query latest instruction via API
- **WHEN** 调用方请求某 reportDate 某 stage 的最新审核动作
- **THEN** 系统返回最新有效动作或 null
- **AND** 支持基于 reviewStartedAt 过滤历史动作

#### Scenario: Query audit events by trace identifier
- **WHEN** 调用方按 traceId 查询审计事件
- **THEN** 系统返回该 trace 下的事件列表
- **AND** 事件按时间倒序返回

### Requirement: System SHALL support file-to-database migration with compatibility fallback
系统 SHALL 提供从文件存储迁移到数据库的能力，并在迁移期支持 DB 优先 + 文件 fallback，保证流程可用性。

#### Scenario: Import legacy review instructions from file storage
- **WHEN** 执行迁移命令导入历史审核指令
- **THEN** 系统将可解析记录导入数据库
- **AND** 输出导入统计（成功/失败/跳过）

#### Scenario: Fallback to file storage when database read path is unavailable
- **WHEN** 系统启用 fallback 且数据库读取短时不可用
- **THEN** 系统可从文件路径读取审核信息完成关键流程
- **AND** 系统输出降级告警用于后续排查

## MODIFIED Requirements
### Requirement: Weekly pipeline SHALL support human review gates before publish
系统 SHALL 在 weekly 模式提供审核断点，至少包含大纲审核与终稿审核两个阶段，并从持久化审核指令源读取审核动作；M4 阶段持久化源 SHALL 以 DB/API 为主，并维持结构化回流 payload 与 last-write-wins 决策策略。

#### Scenario: Read latest review action from DB/API in recheck path
- **WHEN** recheck 或 watchdog 需要判定某 reportDate 的审核状态
- **THEN** 系统优先从 DB/API 读取最新有效审核动作
- **AND** 若启用 fallback 且 DB 不可用，可回退到文件路径读取

#### Scenario: Instruction source remains compatible with CLI fallback
- **WHEN** 外部回调不可用或 API 写入失败
- **THEN** 系统允许 CLI 参数作为兼容兜底
- **AND** 不破坏既有超时自动发布策略
