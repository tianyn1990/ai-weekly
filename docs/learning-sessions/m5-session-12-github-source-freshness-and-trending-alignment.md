# M5 学习复盘 12：GitHub 新鲜度治理（dual-query + cooldown + Trending-like 语义）

## 1. 本次实现了什么
- GitHub 数据源从单查询升级为 dual-query：同一 source 并行执行 `active_window(pushed)` 与 `new_repo_window(created)`，并集去重后进入候选池。
- 新增跨天 cooldown：基于审计事件 `github_hot_selected` 抑制短窗口内同仓库重复曝光。
- 新增 breakout 放行：当仓库满足高强度动态阈值（stars + recent update）时，可在 cooldown 窗口内突破。
- 报告渲染新增语义标识：GitHub 仓库条目统一标注“项目热度动态（Trending-like）”。
- 新增 `githubSelectionMeta` 诊断元信息：记录查询命中、merge、cooldown 抑制、breakout 放行和入选统计，并在 `source:diagnose` 输出。

## 2. 流程图（本次增量）
```text
collect_items
  -> load github selection history (audit_events: github_hot_selected)
  -> github_search dual-query
     -> active_window (pushed)
     -> new_repo_window (created)
  -> merge by repo full_name
  -> apply cooldown suppression
     -> if high-intensity signal then breakout allow
  -> emit githubSelectionMeta

rank_items
  -> pick highlights
  -> append github_hot_selected audit events
  -> update githubSelectionMeta.selectedRepoCount

build_report
  -> render github entries with Trending-like label

source:diagnose
  -> print githubSelectionMeta stats for explainability
```

## 3. 源码导读（建议顺序）
1. `src/sources/github-source.ts`
- dual-query 计划生成（active/new）。
- 冷却判定与 breakout 判定。
- 结构化诊断元信息聚合（queryStats + suppression stats）。

2. `src/pipeline/nodes.ts`
- `collectItemsNode`：加载历史入选并传入 GitHub 采集器。
- `rankItemsNode`：回写 `github_hot_selected` 审计事件。
- `githubSelectionMeta` 在状态中的贯通。

3. `src/report/markdown.ts`
- GitHub 条目的 Trending-like 语义标注策略。

4. `scripts/source-diagnose.sh`
- 读取 review artifact 的 `githubSelectionMeta`，输出可排障统计。

## 4. 运行验证
- `pnpm test tests/github-source.test.ts`：通过。
- `pnpm test tests/source-config.test.ts tests/source-collect-node.test.ts`：通过。
- `pnpm test tests/markdown-review.test.ts`：通过。
- `pnpm test`：通过（33 files / 211 tests）。
- `pnpm build`：通过。

## 5. 设计取舍
- 为什么不直接抓 GitHub Trending HTML：
  - 页面结构不稳定、字段不可控、topic 过滤能力弱；维护成本高于 Search API。
- 为什么 dual-query 比单 `sort=updated` 更稳：
  - 单查询容易偏向“老项目小更新”；双查询同时覆盖“近期活跃”和“近期新仓”。
- 为什么 cooldown 放在采集后而不是最终发布后：
  - 在候选阶段先抑制重复，可减少后续评分与 LLM 处理噪音，降低无效计算。
- 当前风险点：
  - breakout 阈值设置不当会导致“重复放行”或“误抑制”；需结合真实运行继续调参。

## 6. 3 分钟复盘模板（已填写）
```text
【1】本轮目标（30s）
- 我本轮要验证的能力点是：让 GitHub 源既能保留热点价值，又不再把“老项目小更新”频繁当成新消息。
- 我完成后的可见结果是：日报/周报里 GitHub 条目重复率下降，且有可解释的过滤统计。

【2】关键实现（60s）
- 我改了哪 3 个核心文件：
  1) src/sources/github-source.ts
  2) src/pipeline/nodes.ts
  3) src/report/markdown.ts
- 每个文件“为什么要改”：
  - github-source：实现 dual-query + cooldown + breakout 主逻辑。
  - nodes：接入历史审计与运行期统计，确保策略可落地且可追溯。
  - markdown：明确“项目热度动态”语义，避免与新闻流混淆。

【3】运行验证（45s）
- 我执行的命令：
  - pnpm test tests/github-source.test.ts
  - pnpm test tests/source-config.test.ts tests/source-collect-node.test.ts
  - pnpm test tests/markdown-review.test.ts
  - pnpm test
  - pnpm build
- 结果是否符合预期：符合。
- 有无 warning/边界场景：
  - 若历史审计读取异常，会走 warning 降级，不阻断主流程。

【4】设计取舍（30s）
- 我放弃了哪个方案，原因是：放弃“直接抓 Trending 页面”，因为长期稳定性与可维护性不足。
- 当前实现的风险点是：breakout 依赖 stars/更新时间，尚未引入 release 维度，后续可补强。

【5】下一步（15s）
- 我下一轮最小可执行目标是：补充 release 信号作为 breakout 条件之一，并给出更细粒度统计。
```
