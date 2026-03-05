# AI 周报系统设计（v0.1）

## 1. 设计目标
- 支持日报/周报自动生产，并为人工审核预留稳定入口。
- 使用 LangGraph 构建可观测、可重试、可扩展的处理流水线。
- 保证内容可追溯（evidence-first），避免无来源断言。
- 保持学习友好：模块清晰、节点职责明确、可单步调试。

## 2. 架构总览
系统分为四层：
1. **Ingestion Layer**：定时拉取 RSS/社区数据，输出 `RawItem`。
2. **Processing Layer (LangGraph)**：标准化、去重、分类、排序、生成摘要。
3. **Review & Publish Layer**：生成待审核 Markdown，管理自动发布策略。
4. **Storage Layer**：本地文件持久化（后续可升级 SQLite/Postgres）。

## 3. 目录结构
```text
.
├── docs/
├── data/
│   └── sources.yaml
├── outputs/
│   ├── review/
│   └── published/
└── src/
    ├── cli.ts
    ├── config/
    │   └── source-config.ts
    ├── core/
    │   ├── scoring.ts
    │   ├── types.ts
    │   └── utils.ts
    ├── pipeline/
    │   ├── graph.ts
    │   └── nodes.ts
    ├── report/
    │   └── markdown.ts
    ├── sources/
    │   ├── mock-source.ts
    │   └── rss-source.ts
    └── utils/
        └── time.ts
```

## 4. LangGraph 工作流（首版）
```text
START
  -> collect_items
  -> normalize_items
  -> dedupe_items
  -> classify_items
  -> rank_items
  -> build_outline
  -> review_outline
  -> review_final
  -> publish_or_wait
  -> build_report
  -> END
```

### 4.1 Node 职责
- `collect_items`：按来源抓取原始条目；支持 `mock/live` 两种模式。
- `normalize_items`：统一字段、规范时间、补齐 source 元信息。
- `dedupe_items`：URL + title fingerprint 去重。
- `classify_items`：按关键词映射分类（tooling/agent/open-source/research/news/tutorial）。
- `rank_items`：按重要性、影响范围、创新性打分并分级（high/medium/low）。
- `build_outline`：生成周报大纲草稿，供大纲审核使用。
- `review_outline`：处理大纲审核状态，写入审核截止时间和审核阶段。
- `build_report`：生成 Markdown（含重点推荐、分组内容、来源链接、审核状态）。
- `review_final`：处理终稿审核状态。
- `publish_or_wait`：统一判定发布行为（人工审核通过/超时自动发布/继续等待）。

## 5. 状态模型（Graph State）
核心状态字段：
- `runId`：一次流水线执行 ID。
- `mode`：`daily | weekly`。
- `timezone`：默认 `Asia/Shanghai`。
- `rawItems`：采集原始条目。
- `items`：标准化后的条目。
- `rankedItems`：排序后的条目。
- `highlights`：重点推荐条目。
- `outlineMarkdown`：大纲审核文本。
- `reportMarkdown`：最终文稿。
- `reviewStatus`：审核状态（not_required/pending_review/approved/timeout_published）。
- `reviewStage`：审核阶段（outline_review/final_review/none）。
- `reviewDeadlineAt`：审核截止时间（周一 12:30，北京时间）。
- `publishStatus`：发布状态（pending/published）。
- `metrics`：采集数、去重后数、分类分布、耗时。

## 6. 发布与审核策略
- 日报：每天 09:00 生成待发布版本。
- 周报：每周一 09:00 生成待审核版本。
- 审核断点：
  - 大纲审核：`review_outline`
  - 终稿审核：`review_final`
- 周报自动发布规则：
  - 审核截止：周一 12:30（北京时间）。
  - 截止前无人审：自动发布当前版本。
- 当前审核输入方式：CLI 参数（`--approve-outline`、`--approve-final`），后续可替换为持久化审核指令。
- 所有报告先写入 `outputs/review/`，发布后写入 `outputs/published/`。

## 7. 数据源策略（首批）
建议首批固定 8-10 个来源（后续再扩展）：
- OpenAI News
- LangChain Blog
- Hugging Face Blog
- MarkTechPost
- VentureBeat AI
- ZDNet AI
- HNRSS (AI keyword)
- 量子位（中文）

> 首版以 RSS 可接入来源为主，降低集成成本。

## 8. 可观测性与容错
- 每个节点记录输入量、输出量、耗时。
- 采集失败不阻塞全局（fail-soft），失败源写入 warning。
- 支持激进重试（默认 3 次，指数退避）。
- 输出执行摘要 JSON，便于后续接入 Dashboard。

## 9. 质量保障
- 硬性约束：无来源断言 = 0。
- 去重目标：重复率 < 10%。
- 条目下限：周报 >= 20。
- 报告结构固定：
  1. 审核信息（状态、阶段、截止时间、发布原因）
  2. 审核大纲（weekly）
  3. 重点推荐
  4. 分类正文
  5. 运行指标

## 10. 后续演进路线
- v0.3：将审核动作从 CLI 参数升级为持久化审核系统（文件/DB/API）。
- v0.4：增加月报/季报聚合与趋势分析。
- v0.5：引入向量检索与跨周期主题记忆。
