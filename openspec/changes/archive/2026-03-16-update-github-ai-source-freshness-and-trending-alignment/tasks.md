## 1. Implementation
- [x] 1.1 为 GitHub AI 源实现双查询候选拉取（`pushed` 窗口 + `created` 窗口）并支持配置化窗口参数。
- [x] 1.2 在采集/排序链路增加跨天冷却（cooldown）与“突破冷却”判定逻辑。
- [x] 1.3 将 GitHub 仓库动态以 Trending-like 语义独立分层，避免与新闻条目混淆。
- [x] 1.4 增强 source diagnose 输出，包含 GitHub 查询命中、过滤、入选与告警统计。
- [x] 1.5 为新增策略补齐单元测试与回归测试（含边界场景）。
- [x] 1.6 更新 README 与核心文档，补充配置项、行为解释、排障指南。

## 2. Validation
- [x] 2.1 `pnpm test` 通过。
- [x] 2.2 `pnpm build` 通过。
- [x] 2.3 `openspec validate update-github-ai-source-freshness-and-trending-alignment --strict` 通过。
- [x] 2.4 使用真实源执行一次 `daily`，验证“老项目重复入选”明显下降且 warning 可解释。
