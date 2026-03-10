# Change: 新增 GitHub Search 数据源并扩展精选 RSS 来源

## Why
当前数据源以 RSS 为主，缺少 GitHub 热门开源项目的一手信号，导致开源方向内容更多来自媒体转述，时效性与工程可落地信息不足。

在调研与接口实测后，确认：
- GitHub Search API 可稳定返回仓库结构化信息，适合补齐“热门开源项目”采集能力；
- InfoQ AI/ML 与 Google AI Blog RSS 可直接被现有 RSS 采集链路消费；
- 部分历史来源（如个别站点）在当前网络环境下存在稳定性问题，不宜默认启用。

## What Changes
- 新增 `github_search` 数据源类型，支持通过 `GITHUB_TOKEN` 鉴权并调用 GitHub Search API。
- 为 `github_search` 增加适配字段（如 `query/sort/order/perPage`），并保持 `rss` 配置向后兼容。
- 在采集层新增 GitHub collector，并接入现有 fail-soft 警告机制（单源失败不阻断主流程）。
- 扩展默认来源配置：新增经实测稳定的高质量 RSS 来源（InfoQ AI/ML、Google AI Blog）。
- 扩展 `source:diagnose` 能力，支持混合来源诊断并对 GitHub token/限流给出可读提示。

## Impact
- Affected specs:
  - `ai-reporting-pipeline`
- Affected code（预期）：
  - `src/core/types.ts`
  - `src/config/source-config.ts`
  - `src/sources/rss-source.ts`
  - `src/sources/github-source.ts`（新增）
  - `src/pipeline/nodes.ts`
  - `scripts/source-diagnose.sh`
  - `data/sources.yaml`
  - `.env.local.example`
- Affected docs（预期）：
  - `docs/PRD.md`
  - `docs/architecture.md`
  - `docs/learning-workflow.md`
  - `README.md`
  - 对应学习会话文档
