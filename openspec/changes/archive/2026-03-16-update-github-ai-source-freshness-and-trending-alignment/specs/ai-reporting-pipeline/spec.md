## ADDED Requirements
### Requirement: GitHub AI source SHALL use freshness-bounded dual-query candidate strategy
系统 SHALL 对 GitHub AI 数据源采用“双查询并集”候选策略，以平衡近期活跃项目与近期新项目，并避免单一 `updated` 排序带来的偏置。

#### Scenario: Build candidate pool with pushed-window and created-window
- **WHEN** 系统执行 GitHub AI 数据源采集
- **THEN** 系统同时执行基于 `pushed` 时间窗口的活跃查询与基于 `created` 时间窗口的新仓查询
- **AND** 系统对两路结果并集去重后进入后续处理

#### Scenario: Keep fail-soft when one query path fails
- **WHEN** 双查询中任一路发生超时或 HTTP 异常
- **THEN** 系统继续使用可用查询结果完成本次采集
- **AND** 系统在 warnings 中记录失败路径与错误摘要

### Requirement: GitHub repository entries SHALL support cross-day cooldown with breakout policy
系统 SHALL 对 GitHub 仓库条目实施跨天冷却策略，降低同一仓库短周期重复曝光；在显著动态信号出现时，系统 SHALL 允许突破冷却。

#### Scenario: Suppress repeated repository within cooldown window
- **WHEN** 某仓库在冷却窗口内已被日报或周报入选
- **THEN** 本次运行默认不再将该仓库纳入重点入选列表
- **AND** 系统记录过滤原因为 cooldown 命中

#### Scenario: Allow breakout when significant update signal is detected
- **WHEN** 冷却窗口内的仓库命中显著动态信号（如 release 或高强度活跃信号）
- **THEN** 系统允许该仓库突破冷却并参与本次排序
- **AND** 系统记录突破原因，便于后续审计

### Requirement: Report output SHALL separate GitHub dynamics with Trending-like semantics
系统 SHALL 在输出语义上将 GitHub 仓库动态与新闻型来源区分，采用 Trending-like 视角表达“项目热度动态”，避免语义混淆。

#### Scenario: Daily report distinguishes repository dynamics from news stream
- **WHEN** 日报包含 GitHub 仓库条目
- **THEN** 报告在结构或标记上明确其为“项目动态/热度动态”而非新闻首发
- **AND** 用户可从条目中识别其来源与动态类型

#### Scenario: Weekly report keeps explainable mixed-view output
- **WHEN** 周报输出跨来源条目
- **THEN** GitHub 仓库条目保留 Trending-like 语义标识
- **AND** 不影响既有审核、发布与回执流程

### Requirement: Source diagnostics SHALL expose GitHub filtering and ranking observability
系统 SHALL 对 GitHub 采集与筛选链路提供结构化可观测性，便于解释“某条为何入选或被过滤”。

#### Scenario: Diagnose command outputs GitHub query and filter stats
- **WHEN** 用户执行 source diagnose
- **THEN** 输出中包含 GitHub 查询命中数、去重数、cooldown 过滤数、突破冷却数与最终入选数
- **AND** 输出当前关键参数（窗口大小、阈值）

#### Scenario: Run artifact records GitHub selection diagnostics
- **WHEN** 系统完成一次 daily 或 weekly 运行
- **THEN** 结构化产物包含 GitHub 选择诊断信息
- **AND** 可用于复盘该周期候选与入选差异
