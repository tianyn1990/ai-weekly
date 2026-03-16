## Context
当前 GitHub 数据源聚合逻辑主要依赖 `topic:ai ... sort=updated`，能稳定抓到热门仓库，但会把“代码活跃”近似成“新闻新鲜度”，造成用户感知偏差。

目标是在不引入高维护成本抓取链路的前提下：
- 保留 AI 开源热点视角；
- 降低旧项目重复曝光；
- 让“为何入选”可解释、可排障。

## Goals / Non-Goals
- Goals:
  - 仅采集 AI 领域仓库动态。
  - 提高“今日看点”的时效一致性。
  - 维持 fail-soft 与可观测性。
- Non-Goals:
  - 不实现通用 GitHub 全量索引。
  - 不引入复杂离线数据仓库。
  - 不在本变更中重写全链路评分体系。

## Decisions
- Decision 1: 双查询并集替代单查询
  - Query A（活跃）: `topic:ai archived:false stars:>=X pushed:>=N天前`
  - Query B（新仓）: `topic:ai archived:false stars:>=Y created:>=M天前`
  - 理由：分别覆盖“持续活跃”与“近期新秀”，减少单一 updated 偏置。

- Decision 2: 引入跨天冷却 + 突破冷却
  - 冷却键：`repo full_name`
  - 冷却期内默认不重复入选。
  - 若命中显著动态信号（release/活跃增量阈值），可突破冷却。
  - 理由：降低重复噪音，同时保留真正重要更新。

- Decision 3: Trending-like 语义独立分层
  - GitHub 动态在输出中作为独立层管理，不与新闻源直接等价。
  - 理由：减少“仓库更新被误读为行业新闻”的语义冲突。

- Decision 4: 诊断输出结构化
  - 在 source diagnose 与 run meta 中记录：查询参数、命中数、过滤原因分布、最终入选数。
  - 理由：出现争议条目时可快速解释“为什么上榜”。

## Risks / Trade-offs
- 风险：窗口过窄导致候选不足。
  - Mitigation：参数配置化并提供默认值与回退阈值。

- 风险：突破冷却判定过松导致重复回流。
  - Mitigation：先采用保守阈值，结合诊断数据迭代。

- 风险：新增规则提升理解成本。
  - Mitigation：在 README 与 PRD/architecture 中提供“规则解释 + 示例”。

## Migration Plan
1. 先上线双查询与诊断，不立即开启激进过滤阈值。
2. 逐步开启冷却与突破策略，观察 3~5 次真实 daily/weekly 结果。
3. 根据 warning 与用户反馈微调窗口和阈值。

## Open Questions
- release 信号是否仅使用 GitHub API 轻量检查，还是后续引入更完整 release feed？
- cooldown 默认 10 天或 14 天，是否按日报/周报分开配置？
