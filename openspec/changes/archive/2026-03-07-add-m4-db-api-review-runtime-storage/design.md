## Context
M3.3 完成后，系统已经具备以下关键能力：
- Feishu 审核通知与动作回写
- `request_revision` 结构化回流修订
- `reject` 终止当前 run 发布约束
- watchdog/recheck 复检发布链路

但状态存储仍以文件为主，导致并发控制、审计检索与系统集成能力受限。M4 在不改变业务语义的前提下，将核心状态升级到 DB/API，并提供可渐进迁移方案。

## Goals / Non-Goals
- Goals:
  - 将审核动作、runtime 配置、审计日志持久化到 DB。
  - 提供最小可用 API，统一 Feishu/CLI/watchdog 的写入语义。
  - 提供并发保护（配置更新冲突检测）与事件级审计可追溯。
  - 保持 M3.3 行为兼容，支持平滑迁移与回退。
- Non-Goals:
  - 本阶段不改造报告产物存储（`outputs/review` 与 `outputs/published` 仍为文件）。
  - 本阶段不引入分布式锁与多实例部署协调机制。
  - 本阶段不建设可视化后台页面。

## Architecture Overview
M4 引入三层新组件：
1. `Storage Layer`：DB schema + migration + repository。
2. `Service Layer`：审核动作与配置服务（封装状态规则）。
3. `API Layer`：HTTP 接口（Feishu/CLI/运维工具复用）。

现有 pipeline 节点不直接依赖 SQL，而是依赖存储抽象接口，保证可测性与后续替换能力。

## Data Model
### 1) review_instructions（审核动作事件表，append-only）
- 字段（建议）：
  - `id` INTEGER PRIMARY KEY AUTOINCREMENT
  - `mode` TEXT NOT NULL (`daily|weekly`)
  - `report_date` TEXT NOT NULL (`YYYY-MM-DD`)
  - `run_id` TEXT NULL
  - `stage` TEXT NOT NULL (`outline_review|final_review`)
  - `action` TEXT NULL (`approve_outline|approve_final|request_revision|reject`)
  - `approved` INTEGER NULL
  - `decided_at` TEXT NOT NULL (ISO timestamp)
  - `source` TEXT NULL (`cli|feishu_callback|api`)
  - `operator` TEXT NULL
  - `reason` TEXT NULL
  - `trace_id` TEXT NULL
  - `message_id` TEXT NULL
  - `feedback_json` TEXT NULL
  - `created_at` TEXT NOT NULL
- 索引：
  - `(mode, report_date, stage, decided_at DESC, id DESC)`
  - `(trace_id)`

### 2) runtime_config_versions（运行时配置版本表）
- 字段（建议）：
  - `id` INTEGER PRIMARY KEY AUTOINCREMENT
  - `version` INTEGER NOT NULL UNIQUE
  - `payload_json` TEXT NOT NULL
  - `updated_at` TEXT NOT NULL
  - `updated_by` TEXT NULL
  - `trace_id` TEXT NULL
- 语义：仅追加新版本，不覆盖旧版本。

### 3) audit_events（统一审计事件表）
- 字段（建议）：
  - `id` INTEGER PRIMARY KEY AUTOINCREMENT
  - `event_type` TEXT NOT NULL
  - `entity_type` TEXT NOT NULL
  - `entity_id` TEXT NOT NULL
  - `payload_json` TEXT NOT NULL
  - `operator` TEXT NULL
  - `source` TEXT NULL
  - `trace_id` TEXT NULL
  - `created_at` TEXT NOT NULL
- 索引：
  - `(event_type, created_at DESC)`
  - `(trace_id)`

## API Contract (M4 Minimum)
### POST /api/review-actions
- 输入：`mode/reportDate/stage/action/decidedAt/operator/reason/traceId/messageId/feedback/runId`
- 行为：
  - 校验 payload schema
  - 写入 `review_instructions`
  - 同事务写入 `audit_events`
- 输出：`{ ok: true, id: number }`

### GET /api/review-actions/latest
- 查询参数：`mode, reportDate, stage, reviewStartedAt?`
- 行为：
  - 按 `decided_at DESC, id DESC` 取最近动作
  - 若传入 `reviewStartedAt`，过滤旧动作
- 输出：`{ instruction: ... | null }`

### GET /api/review/pending
- 查询参数：`mode=weekly, limit?, cursor?`
- 输出：pending 列表（含 stage/deadline/status）。

### GET /api/runtime-config
- 输出：当前生效版本与 payload。

### PATCH /api/runtime-config
- 输入：`expectedVersion`, `patch`, `operator`, `traceId`
- 行为：
  - version 检查失败返回 `409 conflict`
  - 成功写入下一版本
  - 同事务写入审计事件
- 输出：新版本配置。

### GET /api/audit-events
- 查询参数：`traceId?, eventType?, from?, to?, limit?`
- 输出：按时间倒序分页。

## Behavior Compatibility Rules
以下规则在 M4 必须保持与当前实现一致：
1. `last-write-wins`：同 stage 多动作按 `decidedAt` 最新生效；同时间戳按 `id` 最新生效。
2. `reviewStartedAt` 边界：只读取本 run 启动后发生的动作，避免历史动作污染。
3. `reject` 终止当前 run：recheck/watchdog 不得发布被 reject 的 run。
4. `request_revision` 回流执行后重新进入 `final_review`。

## Migration Plan
### Step 1: Schema 初始化
- 新增 DB schema 初始化脚本与版本号（如 `schema_version`）。

### Step 2: 历史数据导入
- 从 `outputs/review-instructions/**/*` 导入审核动作事件。
- 从 runtime 配置文件导入首个版本。
- 导入过程输出迁移报告（成功/失败/跳过计数）。

### Step 3: 双轨运行
- 读取路径：DB 优先，文件 fallback。
- 写入路径：默认写 DB，同时可选写文件镜像（便于对账）。

### Step 4: 切换完成
- 通过配置关闭文件 fallback。
- 保留迁移回滚说明（若 DB 不可用可临时切回文件模式）。

## Error Handling & Resilience
- DB 不可用时：
  - API 返回明确错误码与错误信息。
  - pipeline 在开启 fallback 时降级到文件读路径。
- 配置并发冲突时：
  - 返回 `409` 并附带当前版本号。
- 非法反馈 payload：
  - 返回 `400`，拒绝写入，审计记录错误事件。

## Security & Audit
- API 入口保留 token 校验（与 Feishu 回调一致的最小安全基线）。
- 审核与配置写操作必须携带 `operator/source/traceId`（允许 `operator` 为空但需记录来源）。
- 审计事件不可变更，仅追加。

## Testing Strategy
- 单元测试：
  - repository CRUD 与排序规则
  - optimistic concurrency 冲突
  - `reviewStartedAt` 过滤
  - reject run 终止
- 集成测试：
  - Feishu 回调 -> review action 入库 -> recheck 发布
  - runtime patch -> 下一次 run 生效
- 回归验证：
  - `pnpm test`
  - `pnpm build`
  - `openspec validate --strict`

## Risks / Trade-offs
- 引入 DB 增加系统复杂度。
  - Mitigation: 先 SQLite + 轻量 repository，保持模块边界清晰。
- 双轨期可能出现文件/DB 不一致。
  - Mitigation: 增加镜像写入校验与对账脚本，优先以 DB 为准。
- API 引入后接口契约变更风险上升。
  - Mitigation: 用 schema 校验 + 契约测试锁定行为。

## Open Questions
- 无。M4 范围、并发策略、迁移语义、fallback 规则已在当前方案中冻结。
