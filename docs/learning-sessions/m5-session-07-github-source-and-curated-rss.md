# M5 学习复盘 07：GitHub Search 一手采集 + 混合来源诊断增强

## 1. 本次实现了什么
- 采集层新增 `github_search` 来源类型，支持通过 GitHub Search API 获取热门开源仓库。
- 来源配置从单一 `rss` 扩展为 `rss + github_search` 混合模式，历史 RSS 配置保持兼容。
- `collect_items` 节点改为并行聚合 RSS 与 GitHub 采集结果，统一走 fail-soft warning 语义。
- `source:diagnose` 增强：当启用 `github_search` 但未配置 `GITHUB_TOKEN` 时，输出限流风险 advisory。
- 默认来源新增已验证稳定的 RSS：InfoQ AI/ML、Google AI Blog。

## 2. 流程图（本次增量）
```text
collect_items
  -> load sources.yaml (rss + github_search)
  -> parallel collect
      - collectRssItems(...)
      - collectGithubSearchItems(...)
  -> merge items + warnings
  -> normalize -> dedupe -> ...

source:diagnose
  -> 读取来源配置
  -> 若启用 github_search 且无 GITHUB_TOKEN，先输出 advisory
  -> 跑真实采集链路并汇总 failed sources
```

## 3. 源码导读（建议顺序）
1. `src/core/types.ts`
- `SourceType` 从 `rss` 扩展到 `rss | github_search`。
- 新增 `GithubSearchSourceConfig`，明确 query/sort/order/perPage 配置契约。

2. `src/config/source-config.ts`
- 用 `discriminatedUnion` 做来源配置校验。
- 对 `github_search` 注入默认值（`sort=updated`、`order=desc`、`perPage=10`）。

3. `src/sources/github-source.ts`
- 统一封装 GitHub API 调用、超时与重试策略。
- 限流（403 + `x-ratelimit-remaining=0`）按 warning 暴露且不阻断主流程。
- 缺少 `GITHUB_TOKEN` 时输出风险提示，保障运维可观测。

4. `src/pipeline/nodes.ts`
- `collectItemsNode` 并行调用 RSS/GitHub 采集器并聚合结果。

5. `scripts/source-diagnose.sh`
- 增加 github_search + token 缺失前置提示，减少误判排障。

## 4. 运行验证
- `pnpm test`：通过（30 files / 163 tests）。
- `pnpm build`：通过。
- 新增测试覆盖：
  - `tests/source-config.test.ts`：混合来源配置校验与默认值注入。
  - `tests/github-source.test.ts`：鉴权、重试、限流 warning。
  - `tests/source-collect-node.test.ts`：`collectItemsNode` 混合来源聚合行为。

## 5. 设计取舍
- 为什么新增 `github_search` 而不是依赖第三方 Trending RSS：
  - 一手 API 可观测性更好，字段稳定，便于后续扩展权重与筛选规则。
- 为什么 `GITHUB_TOKEN` 设计成“可选但强建议”：
  - 保证新环境可直接跑通，同时明确长期运行应配置 token 提升稳定性。
- 为什么保持 fail-soft：
  - 采集链路核心目标是“尽量产出”，不能因为单源波动阻断日报/周报主流程。

## 6. 3 分钟复盘模板（已填写）
```text
【1】本轮目标（30s）
- 我本轮要验证的能力点是：补齐 GitHub 热门开源一手采集能力，并保持现有 RSS 流程兼容。
- 我完成后的可见结果是：sources 支持 github_search，collect 节点能混合采集，诊断脚本能识别 token 风险。

【2】关键实现（60s）
- 我改了哪 3 个核心文件：
  1) src/core/types.ts + src/config/source-config.ts
  2) src/sources/github-source.ts
  3) src/pipeline/nodes.ts + scripts/source-diagnose.sh
- 每个文件“为什么要改”：
  - types/config：建立新来源类型契约并保证配置可校验。
  - github-source：实现可控 API 采集与容错。
  - nodes/diagnose：打通生产链路与运维诊断闭环。

【3】运行验证（45s）
- 我执行的命令：
  - pnpm test
  - pnpm build
- 结果是否符合预期：符合。
- 有无 warning/边界场景：
  - 无 token 时会有 advisory，属于预期提醒，不影响主流程。

【4】设计取舍（30s）
- 我放弃了哪个方案，原因是：放弃“直接使用第三方 GitHub Trending RSS 作为主源”，因为稳定性与可控性不足。
- 当前实现的风险点是：匿名 GitHub 配额仍可能在高频运行时触发限流。

【5】下一步（15s）
- 我下一轮最小可执行目标是：结合真实运行数据优化 github_search query 与 source 权重，降低噪声条目占比。
```
