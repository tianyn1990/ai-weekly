# AI 周报系统设计（v0.2）

## 1. 文档目标与范围
- 目标：定义 AI 日报/周报系统在 **M3.1 已完成** 与 **M3.2/M3.3 规划中** 的完整技术架构。
- 范围：覆盖采集、处理、审核、发布、协同通知、审核意见回流、可观测与运维策略。
- 非目标：不描述前端管理后台 UI 细节；不覆盖分布式部署实现细节（当前暂缓）。

## 2. 当前阶段边界（必须先对齐）
### 2.1 已实现（M1 ~ M3.1）
- 基础 LangGraph 流水线：`collect -> normalize -> dedupe -> classify -> rank -> build_outline -> review_outline -> review_final -> publish_or_wait -> build_report`。
- 周报审核断点：大纲审核 + 终稿审核。
- 超时自动发布：周一 12:30（Asia/Shanghai）未完成审核自动发布。
- pending 复检发布：基于 review snapshot 重算状态并发布，不重跑采集链路。
- watchdog 巡检：批量扫描 pending 周报，支持 dry-run。
- watchdog 可靠性增强：单机 lock、失败重试、summary 落盘。

### 2.2 规划中（M3.2 ~ M5）
- Feishu 协同审核闭环：通知、动作输入、截止提醒。
- 审核意见回流修订：在原内容基础上进行结构化调整（非取消式）。
- 审核指令/历史存储升级：文件 -> DB/API。
- LLM 增强：先总结，再逐步扩展到分类/打标/排序辅助。

## 3. 架构全景
系统分为五层：
1. **Ingestion Layer**：按来源抓取原始条目（RSS/后续扩展 API）。
2. **Processing Layer (LangGraph)**：标准化、去重、分类、排序、大纲/正文生成。
3. **Review Orchestration Layer**：审核状态机、超时发布判定、pending 复检。
4. **Collaboration Layer（规划）**：Feishu 通知、审核动作回写、意见指令回流。
5. **Storage Layer**：本地文件持久化（后续迁移 DB/API）。

## 4. 目录与模块责任
```text
.
├── docs/
├── data/
│   └── sources.yaml
├── outputs/
│   ├── review/
│   ├── published/
│   ├── review-instructions/
│   └── watchdog/
└── src/
    ├── cli.ts                        # 运行入口/调度分发
    ├── core/
    │   ├── types.ts                  # 状态与领域类型
    │   ├── review-artifact.ts        # review 产物 schema
    │   └── scoring.ts                # 排序评分
    ├── pipeline/
    │   ├── graph.ts                  # LangGraph 拓扑
    │   ├── nodes.ts                  # 节点实现
    │   ├── review-policy.ts          # 发布判定纯函数
    │   ├── recheck.ts                # 单报告复检
    │   └── watchdog.ts               # 批量巡检执行器
    ├── review/
    │   └── instruction-store.ts      # 审核指令存储抽象（文件实现）
    ├── report/
    │   └── markdown.ts               # 报告渲染
    ├── sources/
    │   ├── rss-source.ts
    │   └── mock-source.ts
    └── utils/
        ├── time.ts
        └── file-lock.ts
```

## 5. 核心流程设计
### 5.1 日常 run 流程（已实现）
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

关键约束：
- `publish_or_wait` 必须在 `build_report` 前执行，确保文案与状态一致。
- 所有运行先写 `outputs/review`，满足条件才写 `outputs/published`。

### 5.2 pending 复检流程（已实现）
```text
load_review_snapshot
  -> review_outline
  -> review_final
  -> publish_or_wait
  -> build_report
  -> persist_review_and_optional_publish
```

关键约束：
- 复检 **不重跑采集链路**，避免审核版本与发布版本内容漂移。
- snapshot 缺失时终止该报告复检并记录失败。

### 5.3 watchdog 扫描流程（已实现）
```text
acquire lock
  -> scan outputs/review/weekly/*.json
  -> filter pending_review + pending
  -> recheck with retry
  -> optional persist (skip when dry-run)
  -> write summary
  -> release lock
```

关键约束：
- 单机互斥：同一时刻仅允许一个 watchdog 实例执行。
- 失败隔离：单报告失败不阻塞其他报告。
- 可追踪：每次执行写 summary 文件并输出逐条结果。

### 5.4 Feishu 审核协同流程（M3.2 规划）
```text
weekly report generated
  -> send Feishu notify (outline review)
  -> reviewer action callback (approve / request_revision / reject)
  -> persist review instruction
  -> recheck or revise
  -> send Feishu notify (final review / publish result)
```

设计要点：
- 审核通知、动作输入、截止提醒都优先走 Feishu。
- 回调动作统一转为持久化审核指令，复用现有状态机与 recheck/watchdog。
- CLI 审核保留为 fallback（协同链路故障兜底）。

### 5.5 审核意见回流修订流程（M3.3 规划）
```text
request_revision
  -> parse structured directives
  -> apply revision rules
  -> regenerate draft
  -> back to final_review
```

你要求的“回流不等于取消”在此落地：
- `request_revision`：进入修订分支，不终止流程。
- `reject`：终止本轮发布尝试，但保留产物与审计记录。

## 6. 状态机模型
### 6.1 审核状态
- `reviewStatus`: `not_required | pending_review | approved | timeout_published`
- `reviewStage`: `outline_review | final_review | none`
- `publishStatus`: `pending | published`

### 6.2 关键事件
- `approve_outline`
- `approve_final`
- `request_revision`
- `reject`
- `deadline_reached`
- `watchdog_recheck`

### 6.3 关键状态转移（简化）
- `pending_review + outline_review + approve_outline -> pending_review + final_review`
- `pending_review + final_review + approve_final -> approved + published`
- `pending_review + any + deadline_reached -> timeout_published + published`
- `pending_review + final_review + request_revision -> pending_review + final_review(修订后)`
- `pending_review + any + reject -> pending_review + pending(结束本次发布尝试)`

## 7. 数据模型与持久化契约
### 7.1 Review Artifact（已实现）
位置：`outputs/review/{mode}/{reportDate}.json`

核心字段：
- 运行维度：`runId`, `generatedAt`, `reportDate`, `mode`
- 审核维度：`reviewStatus`, `reviewStage`, `reviewDeadlineAt`, `outlineApproved`, `finalApproved`
- 发布维度：`publishStatus`, `shouldPublish`, `publishReason`, `publishedAt`
- 内容快照：`snapshot`（recheck/watchdog 重建报告用）

### 7.2 审核指令（已实现 + 待扩展）
位置：`outputs/review-instructions/{mode}/{reportDate}.json`

当前字段：
- `stage`, `approved`, `decidedAt`, `operator`, `reason`

M3.2 扩展：
- `source`: `cli | feishu_callback`
- `action`: `approve_outline | approve_final | request_revision | reject`
- `traceId` / `messageId`（便于追踪 Feishu 回调）

### 7.3 审核意见回流指令（M3.3 规划）
建议新增 `feedbackDirectives`：
- `candidate_additions`: 新增候选条目
- `candidate_removals`: 删除候选条目
- `new_topics`: 新增主题词
- `new_search_terms`: 新增搜索词
- `source_weight_adjustments`: 数据源权重调整
- `ranking_weight_adjustments`: 排序权重调整
- `editor_notes`: 人工备注（展示用途）

### 7.4 Watchdog Summary（已实现）
位置：`outputs/watchdog/weekly/<timestamp>.json`

核心字段：
- `processed`, `published`, `skipped`, `failed`
- `items[]`: `reportDate`, `status`, `attempts`, `reason`
- 执行上下文：`dryRun`, `retries`, `lockFile`, `startedAt`, `finishedAt`

## 8. 策略层设计（回流如何生效）
为避免“自由文本难执行”，回流策略统一结构化并分三层：
1. **条目层**：新增、删除、置顶、降权。
2. **检索层**：主题词/搜索词/来源启停与权重调整。
3. **输出层**：章节结构、重点推荐数量、语气风格控制。

执行原则：
- 先应用条目层，再应用检索层，最后渲染输出层。
- 所有自动调整必须写入变更日志，保证可追溯。

## 9. 可观测性、容错与告警
- 节点指标：每节点输入量/输出量/耗时。
- 容错策略：`fail-soft`，单来源失败不阻断全流程。
- 重试策略：watchdog 单条目重试（可配置次数与间隔）。
- 告警策略（当前）：failed>0 输出 alert 日志 + summary。
- 告警策略（M3.2）：接入 Feishu 通知与聚合告警。

## 10. 安全与配置
### 10.1 当前配置
- 时区：`Asia/Shanghai`
- 审核截止：周一 12:30
- watchdog：`--watch-lock-file`、`--watch-max-retries`、`--watch-retry-delay-ms`

### 10.2 Feishu 接入配置（M3.2）
- `FEISHU_WEBHOOK_URL`
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET`（如需）
- `FEISHU_SIGNING_SECRET`（回调验签）

安全约束：
- 回调必须做签名校验与幂等处理。
- 敏感配置走环境变量，不写入仓库。

## 11. 部署与运行策略
- 当前部署基线：**单机定时任务**。
- 互斥策略：单机 lock 文件已满足当前形态。
- 分布式互斥：仅在多实例部署时启动（当前明确暂缓）。

## 12. 分阶段执行计划（冻结）
1. **M3.2（协同）**：Feishu 通知 + 审核动作回写 + 截止提醒。
2. **M3.3（修订）**：审核意见回流执行（新增/删除候选、主题词/搜索词、权重调整）+ 打回再审核。
3. **M4（存储）**：审核指令与历史产物迁移 DB/API，补审计与并发控制。
4. **M5（智能）**：LLM 总结节点优先，逐步扩展到分类/打标/排序辅助。
5. **暂缓项**：分布式互斥（多实例部署时再做）。

## 13. 里程碑后的质量门禁
- 无来源断言容忍度：0。
- 周报有效条目：>=20。
- 重复率：<10%。
- 审核链路可追溯：每个审核动作可追到来源（CLI/Feishu）与时间。
- 自动发布可验证：超时发布与人工通过发布的状态、文案、落盘一致。
