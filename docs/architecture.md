# AI 周报系统设计（v1.0）

## 1. 文档目标与范围
- 目标：定义 AI 日报/周报系统在 **M5.4 已完成** 基线下的完整技术架构。
- 范围：覆盖采集、处理、审核、发布、协同通知、审核意见回流、可观测与运维策略。
- 非目标：不描述前端管理后台 UI 细节；不覆盖分布式部署实现细节（当前暂缓）。

## 2. 当前阶段边界（必须先对齐）
### 2.1 已实现（M1 ~ M3.1）
- 基础 LangGraph 流水线：`collect -> normalize -> dedupe -> llm_classify_score -> rank -> build_outline -> review_outline -> review_final -> publish_or_wait -> llm_summarize -> build_report`。
- 周报审核断点：大纲审核 + 终稿审核。
- 超时自动发布：周一 12:30（Asia/Shanghai）未完成审核自动发布。
- pending 复检发布：基于 review snapshot 重算状态并发布，不重跑采集链路。
- watchdog 巡检：批量扫描 pending 周报，支持 dry-run。
- watchdog 可靠性增强：单机 lock、失败重试、summary 落盘。

### 2.2 已实现（M3.2）
- Feishu 协同通知：待审核通知、发布结果回执。
- Feishu 截止提醒：周一 11:30 单次提醒命令（由 cron 触发）。
- Feishu 动作回写：本地回调服务写入持久化审核指令（2B：本地服务 + 隧道，兼容 query token）。
- Feishu 原生 payload 适配：支持卡片 `action.value/form_value` 映射到统一审核动作模型。
- 审核动作写入审计字段：`source/action/operator/traceId/messageId/feedback`（文件模式）。

### 2.3 已实现（M3.3）
- 审核意见回流修订：`request_revision` 会执行结构化反馈（候选增删、主题词/搜索词、来源启停与权重、排序权重）。
- 全局配置沉淀：回流中的检索/排序调整写入 runtime config，并在后续 run 生效。
- reject 终止约束：被 reject 的当前 run 在 recheck/watchdog 路径下不再发布，必须新建 run 才能再次进入发布流程。

### 2.4 已实现（M4）
- 审核指令存储升级：新增 SQLite 事件表（append-only），支持 `last-write-wins` 查询。
- runtime config 存储升级：新增版本表，支持 `expectedVersion` 乐观并发控制。
- 审计事件存储：新增统一 audit 表，支持 trace/eventType 查询。
- 最小 Review API：支持审核动作写入/查询、pending 查询、runtime 配置读写、审计查询。
- 迁移能力：支持从文件（`review-instructions` + runtime config）导入 DB。
- 兼容策略：DB 优先 + 文件 fallback。

### 2.5 已实现（M4.1）
- 飞书通知通道统一为 app-only：仅应用机器人负责待审核、提醒、发布与动作回执通知。
- 点击反馈闭环：卡片点击后返回 toast（success/error），并向群内发送动作状态回执。
- 状态回显能力：回调可读取最新 review artifact 生成状态回显；读取失败时回退到动作级推断。
- 失败隔离：动作写入成功后，若回执推送失败只记录 warning，不反向污染审核主流程。
- 可点击链接：支持通过 `REPORT_PUBLIC_BASE_URL` 把本地产物路径转换为飞书可点击 URL。

### 2.6 已实现（M4.2）
- 阶段引导式主卡：按 `outline_review/final_review/结束态` 渲染不同状态文案与按钮集合。
- 单轮单主卡：同一 `reportDate + runId` 复用同一消息入口，阶段变化优先 PATCH 更新卡片。
- 更新失败降级：主卡更新失败时自动新发卡片并覆盖记录，保证审核入口可用。
- 回执去噪：动作回执改为业务化短句；重复回调仅返回 toast，不重复群发。
- 兼容 recheck/watchdog：非 run 触发也会更新主卡状态，避免“卡片停留旧阶段”。

### 2.7 已实现（M4.3）
- daemon 常驻模式：单进程统一托管 scheduler、Feishu callback、operation worker。
- 自动调度：daily/weekly/reminder/watchdog 按时间窗口自动入队，并支持重启补偿扫描。
- 主动触发：支持 @应用机器人下发运维操作卡，按钮回调入队异步执行。
- 自动推进：审核动作回调写入成功后自动入队 `recheck_weekly`。
- 自动 Git 同步：支持受控目录自动 add/commit/push，push 阶段支持可选代理注入。
- 任务可观测：新增 `operation_jobs` 队列表并支持 API 查询。

### 2.8 已实现（M4.4）
- 新机初始化引导：新增 `setup:macos`，统一检查依赖、环境变量、tunnel 资产与 cloudflared config。
- 配置自动补齐：当缺失 `~/.cloudflared/config.yml` 且环境参数齐全时，自动生成固定域名配置。
- 一键服务托管：新增 `services:up/down/restart/status/logs`，通过 launchd 托管 daemon + Named Tunnel。
- 联合健康检查：`services:status` 同时输出本地 health 与公网 callback health，降低排障成本。
- 模式边界显式化：保留 `feishu:tunnel` 作为临时调试模式，并在脚本中输出非稳定 URL 提示。

### 2.9 已实现（M5.1）
- 新增 `llm_summarize` 节点，位于 `publish_or_wait -> build_report` 之间。
- 总结策略采用“逐条总结 + 聚合速览”，避免全量单 prompt 导致上下文退化。
- 速览条目数自适应 `4-12`，覆盖 `daily` 与 `weekly`。
- provider 首发 MiniMax，保留 provider 抽象扩展位。
- 失败自动回退规则摘要，不阻断审核/发布状态机。
- 回退告警按 run 合并发送 1 条飞书消息，避免重复噪音。

### 2.10 已实现（M5.2）
- 新增前置 `llm_classify_score` 节点：在 `dedupe` 后、`rank` 前执行批量分类与全量打分。
- 批量容错链路：批次重试 -> 二分拆批 -> 单条回退（不中断主流程）。
- 排序融合改为前置节点驱动：`rank` 阶段按规则分与 `llmScore` 计算融合分（默认 `fusionWeight=0.65`）。
- 新增全量标题翻译增强：`llm_classify_score` 输出 `titleZh`，报告展示优先使用“中文标题（原标题）”。
- 新增报告导语：在报告顶部补充 2-3 句“本期导语”（失败时模板回退）。
- 新增并发闸门：`effectiveConcurrency=min(nodeConcurrency, globalConcurrency)`，默认上限 2。
- `llm_summarize` 去打分职责：仅负责摘要、导语、导读、翻译等可读性增强。
- 新增中文质量闭环：`llm_summarize` 对非中文摘要先重试再执行中文修复；修复失败保留英文原文并记录统计。

### 2.11 已实现（M5.3）
- 新增窗口型自适应降载：短窗口 `missing_content` 比例异常时，自动降载并优先重试失败条目。
- 新增自动恢复：窗口成功率回升后自动恢复并发预算，避免长期低吞吐。
- 新增 run 级诊断元数据：`adaptiveDegradeStats`（trigger/recover/currentMode/windowStats）。
- 新增分类导读：按主要分类生成 1 句导读，失败回退模板文案。

### 2.12 已实现（M5.4）
- 采集层新增 `github_search` 适配器：支持通过 GitHub Search API 拉取热门开源仓库并映射标准候选条目。
- 支持 `rss + github_search` 混合来源配置，兼容历史 RSS-only 配置。
- GitHub 鉴权策略：支持 `GITHUB_TOKEN`（可选），缺失时仍可执行并输出限流风险提示。
- 默认来源扩展：新增 InfoQ AI/ML 与 Google AI Blog RSS；保留不稳定来源默认禁用策略。
- 诊断增强：`source:diagnose` 可识别 `github_search` 启用状态，并在 token 缺失时给出运维建议。

## 3. 架构全景
系统分为八层：
1. **Ingestion Layer**：按来源抓取原始条目（RSS + GitHub Search API 适配器）。
2. **Processing Layer (LangGraph)**：标准化、去重、分类、排序、大纲/正文生成。
3. **Review Orchestration Layer**：审核状态机、超时发布判定、pending 复检。
4. **Collaboration Layer**：Feishu 通知、审核动作回写、审核意见回流修订。
5. **Storage Layer**：SQLite（主）+ 文件（fallback）双轨持久化。
6. **Automation Layer**：daemon scheduler + operation queue + git sync executor。
7. **Service Ops Layer**：macOS bootstrap + launchd service lifecycle（本地运维收敛层）。
8. **Intelligence Layer**：前置批量 classify+score + item-wise summarize + lead/category lead（可回退、可审计）。

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
    ├── daemon/
    │   ├── scheduler.ts              # 调度窗口判定（含补偿扫描）
    │   ├── schedule-marker-store.ts  # 调度 marker 持久化
    │   ├── operation-job-store.ts    # operation_jobs 队列存储
    │   └── worker.ts                 # operation job 执行路由
    ├── git/
    │   └── auto-sync.ts              # 受控目录自动 Git 同步
    ├── audit/
    │   └── audit-store.ts           # 审计事件存储（DB）
    ├── llm/
    │   ├── classify-score.ts        # MiniMax 批量分类/全量打分（重试+拆批降级+回退）
    │   └── summary.ts               # MiniMax 逐条总结/导语/导读/翻译 + 回退与证据校验
    ├── config/
    │   ├── source-config.ts          # 来源配置读取
    │   └── runtime-config.ts         # runtime 配置存储抽象（文件+DB）
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
    │   ├── instruction-store.ts      # 审核指令存储抽象（文件+DB）
    │   ├── api-server.ts             # Review API 服务
    │   ├── feedback-schema.ts        # 回流 payload 归一化与校验
    │   ├── feedback-executor.ts      # request_revision 回流执行器
    │   ├── feishu.ts                 # Feishu 通知与回调服务（2B）
    │   └── reminder-policy.ts        # 周一 11:30 提醒判定策略
    ├── report/
    │   └── markdown.ts               # 报告渲染
    ├── tools/
    │   └── service-ops.ts            # macOS 初始化与服务托管命令
    ├── sources/
    │   ├── github-source.ts
    │   ├── rss-source.ts
    │   └── mock-source.ts
    └── utils/
        ├── time.ts
        └── file-lock.ts
    └── storage/
        ├── sqlite-engine.ts          # SQLite 引擎与 schema 初始化
        └── migrate-file-to-db.ts     # 文件到 DB 迁移
└── infra/
    ├── cloudflared/
    │   └── config.example.yml        # 固定域名 tunnel 配置模板
    └── launchd/
        ├── com.ai-weekly.daemon.plist.tmpl
        └── com.ai-weekly.tunnel.plist.tmpl
```

## 5. 核心流程设计
### 5.1 日常 run 流程（已实现）
```text
START
  -> collect_items
  -> normalize_items
  -> dedupe_items
  -> llm_classify_score
  -> rank_items
  -> build_outline
  -> review_outline
  -> review_final
  -> publish_or_wait
  -> llm_summarize
  -> build_report
  -> END
```

关键约束：
- `publish_or_wait` 必须在 `build_report` 前执行，确保文案与状态一致。
- 所有运行先写 `outputs/review`，满足条件才写 `outputs/published`。
- `llm_classify_score` 负责全量打分与分类；`llm_summarize` 不再改写 score/排序结果。

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

### 5.4 Feishu 审核协同流程（M3.2 + M4.1 已实现）
```text
weekly report generated
  -> upsert Feishu 主审核卡 (app-only)
  -> reviewer action callback (approve / request_revision / reject)
  -> persist review instruction
  -> callback toast feedback (success / error)
  -> group action receipt (non-duplicate only)
  -> recheck
  -> upsert 主卡到下一阶段 (final review / published / rejected)
  -> send publish summary text (optional)
```

设计要点：
- 审核通知、动作输入、截止提醒都由 Feishu app bot 负责。
- 回调动作统一转为持久化审核指令，复用现有状态机与 recheck/watchdog。
- CLI 审核保留为 fallback（协同链路故障兜底）。
- M3.2 回调部署采用 2B：本地服务 + 隧道暴露公网地址，回调写入前执行 token/signature 校验。
- 飞书卡片原生回调先经过 payload adapter，再转换为 `ReviewActionPayload`，保证多种事件结构可复用同一状态机。
- 回调反馈分两层：点击人即时 toast + 群内状态回执，避免“点击后无感知”。
- 回调状态回执字段：`reportDate/action/operator/result/reviewStage/reviewStatus/publishStatus/shouldPublish`。
- 回调幂等采用“双层去重”：先按 `traceId/messageId`，再按语义指纹（同 `reportDate + stage + action` 的短窗口重复点击仅受理一次）。
- 报告链接字段支持双形态：`reviewFile/publishedFile`（本地路径）+ `reviewUrl/publishedUrl`（公网可点击）。

### 5.5 Feishu 交互重构流程（M4.2 已实现）
```text
pending review detected (run/recheck/watchdog)
  -> load main-card record by reportDate
  -> if same runId then PATCH card
  -> else send new card and persist messageId
  -> stage-specific buttons rendered

callback action received
  -> auth verify + payload adapt + idempotency dedupe
  -> append instruction
  -> toast(success/error)
  -> notify group only when non-duplicate
```

设计要点：
- 主卡作为“唯一操作入口”，减少群内卡片刷屏。
- 幂等优先 `traceId`，缺失时退化到 `messageId + stage + action`。
- 重复动作不广播，降低审核群噪音。

### 5.6 审核意见回流修订流程（M3.3 已实现）
```text
request_revision
  -> parse structured directives
  -> execute feedback (candidate add/remove + runtime config merge)
  -> rerank + rebuild outline/report
  -> back to final_review
```

你要求的“回流不等于取消”在此落地：
- `request_revision`：进入修订分支，不终止流程。
- `reject`：终止当前 run 发布尝试，但保留产物与审计记录，新 run 可重新进入审核流。

### 5.7 daemon 自动化与主动触发流程（M4.3 已实现）
```text
daemon start
  -> scheduler tick (daily/weekly/reminder/watchdog enqueue)
  -> callback server (review action / mention / operation action)
  -> operation worker poll
  -> execute queued job
  -> send async result receipt
```

设计要点：
- callback 只做“鉴权 + 入队 + 快速反馈”，长任务由 worker 异步执行，避免飞书回调超时。
- daemon 启动后先执行一次补偿扫描，处理休眠/重启导致的漏触发。
- 主动触发入口为“@机器人 -> 运维操作卡 -> operation_jobs 入队”。
- 运维操作卡按钮覆盖 `run_daily` 与 `run_weekly`，用于日报/周报的手工补跑。
- 运维卡 `run_weekly` 默认使用真实数据链路（`mock=false`），避免和线上行为脱节；mock 仅保留给 CLI 显式演练。
- 审核动作写入后自动入队 `recheck_weekly`，减少人工补命令。
- 自动入队的 `recheck_weekly` 视为系统内部动作，不群发主动触发回执，避免干扰审核对话。

### 5.8 macOS 初始化与服务托管流程（M4.4 已实现）
```text
pnpm run setup:macos
  -> check binary/env/tunnel/config
  -> optional generate ~/.cloudflared/config.yml
  -> print actionable fix hints

pnpm run services:up
  -> render launch agents (daemon + tunnel)
  -> launchctl bootstrap + kickstart
  -> run status health summary
```

设计要点：
- 把“首次接入复杂性”和“日常运维复杂性”分层：`setup` 负责发现问题，`services:*` 负责稳定运行。
- launchd 托管双服务，避免手工开两个终端造成漏启动与回调不可用。
- `status` 的本地 + 公网双健康检查可快速定位“服务在本地正常但外网不可达”问题。
- 继续保留 `feishu:tunnel` 作为临时联调入口，但脚本显式警告 URL 不稳定，避免误用为长期模式。

## 6. 状态机模型
### 6.1 审核状态
- `reviewStatus`: `not_required | pending_review | approved | timeout_published | rejected`
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
- `pending_review + any + reject -> rejected + pending(终止当前 run 发布尝试)`

## 7. 数据模型与持久化契约
### 7.1 Review Artifact（已实现）
位置：`outputs/review/{mode}/{reportDate}.json`

核心字段：
- 运行维度：`runId`, `generatedAt`, `reviewStartedAt`, `reportDate`, `mode`
- 审核维度：`reviewStatus`, `reviewStage`, `reviewDeadlineAt`, `outlineApproved`, `finalApproved`, `rejected`
- 发布维度：`publishStatus`, `shouldPublish`, `publishReason`, `publishedAt`
- 修订审计：`revisionAuditLogs`
- 内容快照：`snapshot`（recheck/watchdog 重建报告用）

### 7.2 审核指令（M4 已升级）
位置：`outputs/review-instructions/{mode}/{reportDate}.json`

当前字段：
- `stage`, `approved`, `decidedAt`, `operator`, `reason`

M3.2 扩展：
- `source`: `cli | feishu_callback`
- `action`: `approve_outline | approve_final | request_revision | reject`
- `traceId` / `messageId`（便于追踪 Feishu 回调）
- `feedback`（结构化回流 payload）

DB 表：`review_instructions`
- 关键列：`mode/report_date/run_id/stage/action/approved/decided_at/source/operator/trace_id/feedback_json`
- 关键索引：`(mode, report_date, stage, decided_at DESC, id DESC)`

回调动作反馈（M4.1）：
- 点击响应体：`{ ok, toast: { type, content }, warning? }`
- 群内回执：由通知器统一发送，记录动作受理结果（`accepted | failed`）与状态回显。
- 重复回调：返回 `duplicated=true` 且提示“以最新状态卡为准”，不重复群发回执。

### 7.3 审核意见回流指令（M3.3 已实现）
`feedback` 字段支持：
- `candidateAdditions`：新增候选条目
- `candidateRemovals`：删除候选条目
- `newTopics`：新增主题词
- `newSearchTerms`：新增搜索词
- `sourceToggles`：来源启停
- `sourceWeightAdjustments`：来源权重调整
- `rankingWeightAdjustments`：排序权重调整（source/freshness/keyword）
- `editorNotes`：人工备注（展示用途）

### 7.4 Watchdog Summary（已实现）
位置：`outputs/watchdog/weekly/<timestamp>.json`

核心字段：
- `processed`, `published`, `skipped`, `failed`
- `items[]`: `reportDate`, `status`, `attempts`, `reason`
- 执行上下文：`dryRun`, `retries`, `lockFile`, `startedAt`, `finishedAt`

### 7.5 Runtime 配置版本化（M4）
DB 表：`runtime_config_versions`
- 关键列：`version/payload_json/updated_at/updated_by/trace_id`
- 语义：append-only 版本记录，不覆盖历史版本。

### 7.6 审计事件（M4）
DB 表：`audit_events`
- 关键列：`event_type/entity_type/entity_id/payload_json/operator/source/trace_id/created_at`
- 查询：支持按 `traceId` 与 `eventType` 检索。

### 7.7 Feishu 主卡记录（M4.2）
位置：`outputs/notifications/feishu/main-cards/weekly/{reportDate}.json`

核心字段：
- `reportDate`, `runId`, `messageId`, `stage`, `updatedAt`

语义约束：
- 若当前 `runId` 与记录一致，优先更新原卡；
- 若 `runId` 不一致或更新失败，则发送新卡并覆盖 `messageId`；
- 该记录仅用于协同入口路由，不参与审核状态判定。

### 7.8 Operation Jobs（M4.3）
DB 表：`operation_jobs`

核心字段：
- `job_type`, `status`, `payload_json`, `dedupe_key`
- `created_by`, `source`, `trace_id`
- `retry_count`, `max_retries`, `last_error`
- `started_at`, `finished_at`, `created_at`, `updated_at`

语义约束：
- `dedupe_key` 在 `pending/running` 状态下唯一，防止重复入队；
- worker 每次只把一条 `pending` 任务推进到 `running`；
- 失败后按 `max_retries` 自动回队，超限标记为 `failed`。

## 8. 策略层设计（回流如何生效）
为避免“自由文本难执行”，回流策略统一结构化并分三层（已落地）：
1. **条目层**：新增、删除、置顶、降权。
2. **检索层**：主题词/搜索词/来源启停与权重调整。
3. **输出层**：章节结构、重点推荐数量、语气风格控制。

执行原则：
- 先应用条目层（增删候选），再应用检索层（来源/权重/关键词），最后渲染输出层。
- 所有自动调整写入 `revisionAuditLogs`，并将 runtime 配置变更落盘。

## 9. 可观测性、容错与告警
- 节点指标：每节点输入量/输出量/耗时。
- 容错策略：`fail-soft`，单来源失败不阻断全流程。
- 重试策略：watchdog 单条目重试（可配置次数与间隔）。
- 告警策略（当前）：failed>0 输出 alert 日志 + summary。
- 告警策略（M3.2）：接入 Feishu 通知与聚合告警。
- 回调可观测（M4.1）：`[feishu-callback] accepted ...` 固定日志 + 通知失败 warning 字段。

## 10. 安全与配置
### 10.1 当前配置
- 时区：`Asia/Shanghai`
- 审核截止：周一 12:30
- watchdog：`--watch-lock-file`、`--watch-max-retries`、`--watch-retry-delay-ms`

### 10.2 Feishu 接入配置（M3.2 + M4.1）
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `REVIEW_CHAT_ID`（必填）
- `REPORT_PUBLIC_BASE_URL`（可选，用于生成可点击报告链接）
- `FEISHU_CALLBACK_HOST` / `FEISHU_CALLBACK_PORT` / `FEISHU_CALLBACK_PATH`
- `FEISHU_CALLBACK_AUTH_TOKEN`（可选）
- `FEISHU_SIGNING_SECRET`（回调验签）
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET`（发送 interactive 卡片与查询群聊）
- `REVIEW_CHAT_ID`（可选，联调发送卡片默认目标）

### 10.3 M4 存储与 API 配置
- `STORAGE_BACKEND`：`db | file`（默认 `db`）
- `STORAGE_DB_PATH`：SQLite 文件路径（默认 `outputs/db/app.sqlite`）
- `STORAGE_FALLBACK_TO_FILE`：是否启用文件回退（默认 `true`）
- `REVIEW_API_HOST` / `REVIEW_API_PORT`
- `REVIEW_API_AUTH_TOKEN`（可选，启用后 API 需要 Bearer token）

### 10.4 M4.3 daemon 与 Git 自动同步配置
- `DAEMON_SCHEDULER_INTERVAL_MS`
- `DAEMON_WORKER_POLL_MS`
- `DAEMON_MARKER_ROOT`
- `AUTO_GIT_SYNC`
- `GIT_SYNC_PUSH` / `GIT_SYNC_REMOTE` / `GIT_SYNC_BRANCH`
- `GIT_SYNC_INCLUDE_PATHS`
- `GIT_PUSH_HTTP_PROXY` / `GIT_PUSH_HTTPS_PROXY` / `GIT_PUSH_NO_PROXY`

### 10.5 Git 跟踪边界（M4.3）
- 默认纳入 Git 自动同步与远程审核的目录：
  - `outputs/review/**`
  - `outputs/published/**`
  - `outputs/review-instructions/**`
  - `outputs/runtime-config/**`
- 默认不纳入同步的目录：
  - `outputs/db/**`（二进制数据库，不适合协作合并）
  - `outputs/notifications/**`（运行时通知缓存）
  - `outputs/daemon/**`（调度去重与补偿 marker，属于单机运行态）
  - `outputs/service-logs/**`（本机运行日志，体积增长快且无协作价值）

### 10.6 M4.4 本地服务运维配置
- `AI_WEEKLY_ENV_FILE`（可选，默认 `<repo>/.env.local`）
- `AI_WEEKLY_LAUNCHD_ENV_FILE`（可选，默认 `~/.config/ai-weekly/.env.launchd`）
- `CLOUDFLARED_TUNNEL_NAME`（默认 `ai-weekly-callback`）
- `CLOUDFLARED_CONFIG_PATH`（默认 `~/.cloudflared/config.yml`）
- `CLOUDFLARED_TUNNEL_ID` / `CLOUDFLARED_TUNNEL_HOSTNAME`（首次 setup 自动生成 config 时使用）
- `CLOUDFLARED_CREDENTIALS_FILE`（可选，默认推导 `~/.cloudflared/<tunnel-id>.json`）
- `SERVICE_LOGS_TAIL`（`services:logs` 默认 tail 行数）
- `LLM_SUMMARY_ENABLED`（是否启用 LLM 总结）
- `MINIMAX_API_KEY` / `MINIMAX_MODEL`（MiniMax 调用配置）
- `LLM_CLASSIFY_SCORE_ENABLED` / `LLM_CLASSIFY_SCORE_BATCH_SIZE` / `LLM_CLASSIFY_SCORE_TIMEOUT_MS`
- `LLM_CLASSIFY_SCORE_MAX_CONCURRENCY` / `LLM_CLASSIFY_SCORE_MIN_CONFIDENCE` / `LLM_CLASSIFY_SCORE_PROMPT_VERSION`
- `LLM_SUMMARY_TIMEOUT_MS` / `LLM_SUMMARY_MAX_ITEMS` / `LLM_SUMMARY_MAX_CONCURRENCY`
- `LLM_GLOBAL_MAX_CONCURRENCY`（全局 LLM 并发闸门，默认 2）
- `LLM_RANK_FUSION_WEIGHT`（规则分与 LLM 分融合权重）
- `LLM_ASSIST_MIN_CONFIDENCE`（历史兼容字段，新流程可忽略）
- `LLM_SUMMARY_PROMPT_VERSION` / `LLM_FALLBACK_ALERT_ENABLED`

实现约束：
- `services:up` 会把 `AI_WEEKLY_ENV_FILE` 同步到 `AI_WEEKLY_LAUNCHD_ENV_FILE`，确保 launchd 读取路径稳定，规避 macOS TCC 对 `Documents/Desktop` 的权限拦截。
- `launchctl bootstrap` 增加短重试与 stop 态等待，降低 `Input/output error` 的偶发失败概率。

安全约束：
- 回调必须做签名校验与幂等处理。
- 敏感配置走环境变量，不写入仓库。

运维自动化（M3.2.1）：
- `pnpm run feishu:token`：自动获取 tenant access token。
- `pnpm run feishu:chat:list`：自动查询 chat_id（支持按群名过滤）。
- `pnpm run feishu:card:send`：自动发送审核卡片并携带标准 action value。

## 11. 部署与运行策略
- 当前部署基线：**单机 daemon 常驻运行**（CLI/cron 仍保留 fallback）。
- 互斥策略：单机 lock 文件已满足当前形态。
- 分布式互斥：仅在多实例部署时启动（当前明确暂缓）。

## 12. 分阶段执行计划（冻结）
1. **M3.2（协同）**：Feishu 通知 + 审核动作回写 + 截止提醒【已完成】。
2. **M3.3（修订）**：审核意见回流执行 + 打回终止约束【已完成】。
3. **M4（存储）**：审核指令与 runtime 配置升级 DB/API + 审计 + 并发控制【已完成】。
4. **M4.1（协同增强）**：Feishu app-only 通知统一 + 点击反馈闭环【已完成】。
5. **M4.3（自动化）**：daemon 自动调度 + @机器人主动触发 + 自动 Git 同步【已完成】。
6. **M4.4（运维）**：macOS 初始化引导 + 一键服务托管（launchd + Named Tunnel）【已完成】。
7. **M5.1（智能）**：LLM 总结节点（MiniMax，逐条总结 + 速览聚合）【已完成】。
8. **M5.2（智能）**：前置批量分类/全量打分 + 排序融合 + 导语 + 标题翻译【已完成】。
9. **M5.3（智能）**：自适应降载与 run 级诊断 + 分类导读（LLM + 模板回退）【已完成】。
10. **M5.4（数据源）**：GitHub Search 一手开源采集 + 精选 RSS 扩展 + 诊断增强【已完成】。
11. **暂缓项**：分布式互斥（多实例部署时再做）。

## 13. 里程碑后的质量门禁
- 无来源断言容忍度：0。
- 周报有效条目：>=20。
- 重复率：<10%。
- 审核链路可追溯：每个审核动作可追到来源（CLI/Feishu）与时间。
- 自动发布可验证：超时发布与人工通过发布的状态、文案、落盘一致。
- 点击反馈可验证：飞书卡片动作成功/失败均有可见反馈（toast + 群回执）。
- LLM 回退可验证：回退时报告有可见标记、审计可追踪、飞书告警每 run 至多 1 条。
