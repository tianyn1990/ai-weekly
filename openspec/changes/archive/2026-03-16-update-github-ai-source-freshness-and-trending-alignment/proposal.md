# Change: 优化 GitHub AI 数据源新鲜度并引入 Trending-like 热度能力

## Why
当前 GitHub 数据源使用 `search/repositories + sort=updated`，会把“老项目的小更新”持续当作当天重点，导致日报/周报出现“看起来是旧消息”的内容，影响可读性与时效认知。

同时，用户希望保留“热门开源项目”视角，但需要更加贴近 Trending 的热点语义，并且明确限定在 AI 领域。

## What Changes
- 调整 GitHub AI 源的候选拉取策略，从单查询改为双查询并集：
  - 近期活跃仓库窗口（基于 `pushed`）。
  - 近期新仓库窗口（基于 `created`）。
- 引入跨天冷却（cooldown）机制，降低同一仓库在短周期内重复入选概率。
- 定义“突破冷却”条件：当仓库出现显著新动态（如 release 或高强度活跃信号）时允许再次入选。
- 引入 Trending-like 输出语义：把 GitHub 仓库动态作为独立视角管理，避免与新闻源语义混淆。
- 增强 source diagnose 与运行期观测，输出 GitHub 采集统计与过滤原因，支持快速排查“为什么这条会上榜”。
- 保持 fail-soft：GitHub 拉取失败或部分查询失败时，主流程继续并输出 warning。

## Impact
- Affected specs:
  - `ai-reporting-pipeline`
- Affected code (planned):
  - `src/sources/github-source.ts`
  - `src/pipeline/nodes.ts`
  - `src/report/markdown.ts`
  - `scripts/source-diagnose.sh`
  - `tests/source-collect-node.test.ts`
  - `tests/*`（新增 GitHub 新鲜度、冷却、诊断相关单测）
- 兼容性影响：
  - 产物结构将新增 GitHub 动态相关元信息（向后兼容读取）。
  - 排名结果会变化（预期行为变更）。
