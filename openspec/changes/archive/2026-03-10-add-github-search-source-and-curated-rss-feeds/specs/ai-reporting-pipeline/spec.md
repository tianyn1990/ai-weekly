## ADDED Requirements
### Requirement: Pipeline SHALL support GitHub Search as a first-party source adapter
系统 SHALL 支持 `github_search` 来源类型，用于采集 GitHub 热门/高价值开源仓库，并将结果统一映射到报告候选条目。

#### Scenario: Collect repositories from GitHub Search with token
- **WHEN** 来源配置包含已启用的 `github_search`，且环境中存在 `GITHUB_TOKEN`
- **THEN** 系统向 GitHub Search API 发起带鉴权的请求并采集仓库条目
- **AND** 每条结果至少包含仓库名、链接、简要描述与更新时间上下文

#### Scenario: Continue run when GitHub source hits transient failure
- **WHEN** GitHub Search 请求发生超时、5xx 或可重试网络错误
- **THEN** 系统记录该来源 warning
- **AND** 系统继续处理其他来源并完成本次报告生成

#### Scenario: Handle rate-limit or auth failure as warning
- **WHEN** GitHub Search 返回限流或鉴权相关错误（如 403/429）
- **THEN** 系统输出可读 warning（包含来源与错误摘要）
- **AND** 不中断主流程

### Requirement: Source configuration SHALL support mixed adapters with backward compatibility
系统 SHALL 支持 `rss` 与 `github_search` 混合来源配置，并保持现有 `rss` 配置文件可直接复用。

#### Scenario: Existing RSS-only configuration remains valid
- **WHEN** 配置文件仅包含 `rss` 来源
- **THEN** 系统行为与升级前保持一致
- **AND** 不要求用户补充 GitHub 相关字段

#### Scenario: Mixed source configuration is loaded and executed
- **WHEN** 配置文件同时包含 `rss` 与 `github_search` 来源
- **THEN** 系统按来源类型分别调用对应采集器
- **AND** 最终聚合结果进入统一后续处理链路

### Requirement: Source diagnose SHALL cover mixed source health checks
系统 SHALL 在 `source:diagnose` 中覆盖混合来源健康检查，并对 GitHub 相关配置缺失或限流风险提供明确提示。

#### Scenario: Diagnose reports github token advisory when missing
- **WHEN** 诊断期间发现启用了 `github_search` 且未配置 `GITHUB_TOKEN`
- **THEN** 系统输出“可运行但限流风险较高”的提示
- **AND** 诊断流程继续执行

#### Scenario: Diagnose surfaces per-source failure details
- **WHEN** 任一 `rss` 或 `github_search` 来源抓取失败
- **THEN** 诊断输出按来源列出失败项与错误摘要
- **AND** 用户可据此快速调整 `data/sources.yaml` 或环境配置
