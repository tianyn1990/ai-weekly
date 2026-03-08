## ADDED Requirements

### Requirement: System SHALL provide macOS bootstrap for first-time setup
系统 SHALL 提供 macOS 首次初始化命令，用于在新电脑上自动检查与补齐本地运行所需条件，输出可执行的修复建议，降低接入门槛与人工遗漏风险。

#### Scenario: Bootstrap validates local prerequisites and reports actionable result
- **WHEN** 用户执行 `setup:macos` 初始化命令
- **THEN** 系统检查 Node/pnpm/cloudflared/sqlite3 与关键环境变量
- **AND** 系统以结构化方式输出 pass/fail 项与对应修复命令

#### Scenario: Bootstrap prepares local cloudflared runtime config from template
- **WHEN** 本地缺失 `~/.cloudflared/config.yml` 或配置不完整
- **THEN** 系统基于仓库模板生成或更新本机配置文件
- **AND** 系统不将 credentials 与敏感值写入仓库

#### Scenario: Bootstrap warns single-active-host constraint
- **WHEN** 用户准备在新电脑启用长期运行模式
- **THEN** 系统提示当前阶段为单机活跃模型
- **AND** 明确告知多机同时运行可能造成重复调度与重复通知

### Requirement: System SHALL provide one-command service lifecycle management on macOS
系统 SHALL 提供一键化服务生命周期管理能力，以托管 daemon 与 Named Tunnel 双服务，避免手工开启多个终端。

#### Scenario: Up command starts daemon and named tunnel idempotently
- **WHEN** 用户执行 `up` 命令
- **THEN** 系统安装或更新 launchd 服务定义并启动 daemon 与 tunnel
- **AND** 重复执行 `up` 不会重复注册或破坏已有健康服务

#### Scenario: Status command reports service and health summary
- **WHEN** 用户执行 `status` 命令
- **THEN** 系统输出 daemon/tunnel 的运行状态摘要
- **AND** 同时输出本地 `/health` 与公网 callback health 检查结果

#### Scenario: Down and restart commands manage both services consistently
- **WHEN** 用户执行 `down` 或 `restart` 命令
- **THEN** 系统对 daemon 与 tunnel 双服务执行一致的停止或重启操作
- **AND** 操作结果可在后续 `status` 中验证

### Requirement: Stable callback endpoint mode SHALL be explicit and preferred for long-running usage
系统 SHALL 将 Named Tunnel 固定域名模式定义为长期运行推荐模式，并保留 Quick Tunnel 作为临时调试模式且显式提示其 URL 非稳定特性。

#### Scenario: Stable mode keeps callback URL unchanged after process restart
- **WHEN** 用户使用 Named Tunnel 固定域名模式并重启本地进程
- **THEN** 回调 URL 保持不变
- **AND** 无需重新修改飞书后台回调地址

#### Scenario: Debug quick tunnel mode warns URL volatility
- **WHEN** 用户执行 Quick Tunnel 调试命令（如 `feishu:tunnel`）
- **THEN** 系统提示该模式 URL 可能变化，仅适用于临时联调
- **AND** 引导用户使用 stable 模式作为日常运行方式
