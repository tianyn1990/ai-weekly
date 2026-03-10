## 1. Implementation
- [x] 1.1 扩展来源类型与配置 schema：支持 `github_search`，并保持 `rss` 配置兼容。
- [x] 1.2 新增 GitHub collector（含超时、重试、限流与 fail-soft warning）。
- [x] 1.3 在 pipeline 的采集节点接入混合来源抓取（rss + github_search）。
- [x] 1.4 扩展默认来源配置，新增经验证稳定的 RSS 源（InfoQ AI/ML、Google AI Blog）。
- [x] 1.5 新增 `GITHUB_TOKEN` 配置读取，并在缺失 token 时输出可读告警（不中断流程）。
- [x] 1.6 扩展 `source:diagnose`，支持混合来源并输出 GitHub 相关诊断信息。
- [x] 1.7 为新增/修改核心逻辑补充中文注释（解释设计原因与容错策略）。

## 2. Testing
- [x] 2.1 新增/更新单元测试：`github_search` 配置校验、成功采集、限流/超时/HTTP 错误回退。
- [x] 2.2 新增/更新单元测试：采集节点在混合来源下的聚合与 warning 行为。
- [x] 2.3 新增/更新脚本测试（或集成验证）：`source:diagnose` 对 github/rss 的诊断输出。
- [x] 2.4 执行 `pnpm test`、`pnpm build` 并记录结果。

## 3. Documentation
- [x] 3.1 更新 `docs/PRD.md`（数据源策略与 GitHub 一手信号覆盖）。
- [x] 3.2 更新 `docs/architecture.md`（采集层扩展为 RSS + GitHub API 适配器）。
- [x] 3.3 更新 `README.md`（`GITHUB_TOKEN` 配置与诊断/运行说明）。
- [x] 3.4 更新 `docs/learning-workflow.md`（学习节奏与会话记录）。
- [x] 3.5 新增学习会话文档并填写“3 分钟复盘模板”。

## 4. OpenSpec Validation
- [x] 4.1 执行 `openspec validate add-github-search-source-and-curated-rss-feeds --strict`。
