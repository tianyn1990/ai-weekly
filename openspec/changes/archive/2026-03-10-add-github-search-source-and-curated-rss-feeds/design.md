## Context
当前采集层只支持 `rss` 类型来源。要补齐“GitHub 热门开源项目”能力，必须引入 API 型来源。

实测结论：
- GitHub Search API：可达且返回结构化字段完整；未鉴权场景限流额度较低。
- InfoQ AI/ML 与 Google AI Blog：RSS 入口可被现有解析器直接消费。
- 部分历史来源在当前网络/站点策略下不稳定，不应默认开启。

## Goals / Non-Goals
### Goals
- 引入 `github_search` 来源类型，并通过 `GITHUB_TOKEN` 提升稳定性与限流预算。
- 在不破坏现有流程的前提下，实现 `rss + github_search` 混合采集。
- 保持 fail-soft 语义：单来源失败仅产出 warning，不中断整期报告。
- 把新增能力纳入 `source:diagnose` 运维路径。

### Non-Goals
- 本次不引入网页 HTML 抓取器（仅支持 RSS 与 GitHub API）。
- 本次不接入更多需要解析 sitemap/html 的官网来源。
- 本次不调整 LLM 节点逻辑与排序策略。

## Decisions
### Decision 1: 新增 `github_search` 作为独立来源类型
- 原因：GitHub 热门仓库不应依赖第三方 RSS 镜像，API 可观测性更好。
- 配置字段（草案）：
  - `id/name/type/language/weight/enabled`
  - `query`（必填，GitHub Search 查询语句）
  - `sort`（可选，默认 `updated`）
  - `order`（可选，默认 `desc`）
  - `perPage`（可选，默认 10，建议 <= 30）

### Decision 2: `GITHUB_TOKEN` 为可选但强建议
- 有 token：请求头注入 `Authorization: Bearer ...`，提高稳定性与限流预算。
- 无 token：仍可执行；若命中限流或 403/429，记录 warning 并继续流程。
- 原因：兼顾首次接入便捷性与长期稳定性。

### Decision 3: 统一 fail-soft 与可观测
- GitHub collector 与 RSS collector 统一返回 `{items, warnings}`。
- 所有失败均归入 warning（包含简洁错误类别：timeout/http/rate_limit/parse）。
- 原因：维持现有“主流程不中断”设计原则。

### Decision 4: 默认来源只增补“已实测稳定”项
- 新增：InfoQ AI/ML、Google AI Blog。
- GitHub 热门：通过 `github_search` 提供一手仓库信号。
- 不在本次默认启用：实测不稳定或非标准 feed 的来源。

## Data Mapping
`github_search` -> `RawItem` 映射：
- `title` = `full_name`
- `link` = `html_url`
- `contentSnippet` = `description + stars + language + updatedAt`（拼接简要上下文）
- `publishedAt` = `pushed_at`（缺失时回退 `updated_at`）

## Risks / Trade-offs
- 风险：GitHub Search 限流触发导致部分周期无 GitHub 条目。
  - 缓解：支持 token、重试与清晰 warning；不阻断主流程。
- 风险：query 配置过宽引入噪音。
  - 缓解：先采用 curated query，后续结合诊断与人工反馈迭代。
- 风险：新增来源导致总条目增加，可能放大后续 LLM 调用压力。
  - 缓解：由现有 `sourceLimit`、排序与 LLM 并发闸门共同约束。

## Validation Strategy
- 单元测试：
  - 配置校验（rss/github_search union）
  - GitHub collector 成功与失败分支（timeout/429/403/5xx）
  - 混合来源聚合与 warning 输出
- 集成验证：
  - `pnpm run source:diagnose` 输出可读诊断
  - `pnpm run:daily` / `pnpm run:weekly` 在 mixed source 下完成产物输出
