## Context
M4.2 已解决飞书审核交互可用性问题（阶段主卡、去噪回执、幂等判重），但系统主流程仍是“命令驱动 + 人工触发”，与目标中的“后台持续运行、无人值守”存在差距。

本次变更希望形成“双轨协同模型”：
1) 自动模式：后台 daemon 按时间自动执行；
2) 主动模式：在飞书中 @机器人，使用运维卡按钮主动触发。

同时，为了让飞书中的链接始终可读，本次引入产物自动 Git 同步机制（可选代理）。

## Goals / Non-Goals
- Goals:
  - 提供单进程常驻 daemon，自动执行核心时间点任务。
  - Feishu 点击审核动作后自动推进 recheck，避免人工补命令。
  - 支持 @机器人返回“运维操作卡”，以按钮触发常见运维动作。
  - 把关键产物自动同步到 Git 仓库，保障链接可访问。
  - 保留 CLI fallback，确保学习与排障路径不受阻断。
- Non-Goals:
  - 本阶段不实现分布式调度与多实例选主。
  - 本阶段不引入复杂权限系统（保持群内任意成员可触发）。
  - 本阶段不改变核心审核状态机语义（last-write-wins、reject 约束保持不变）。

## Decisions

### Decision 1: 引入 daemon 统一调度与执行
- 新增 `run --daemon` 入口（或独立 daemon 子命令），单进程内启动：
  - scheduler（时间触发）
  - feishu callback server
  - job worker（消费任务队列）
- scheduler 默认使用 Asia/Shanghai。
- 每次 daemon 启动后执行一次“补偿扫描”，处理机器休眠或重启期间错过的窗口。

### Decision 2: 回调路径只做“快速确认 + 入队”，长任务异步执行
- Feishu callback 请求内仅做：鉴权、payload 解析、幂等判重、落盘/入队、toast 返回。
- `recheck/watchdog/run/git push` 统一由 worker 异步执行。
- 这样可避免飞书回调超时，同时提升失败重试与审计能力。

### Decision 3: 主动触发采用“@机器人 -> 操作卡 -> 入队执行”
- 新增 Feishu 事件处理：当群内 @机器人时返回运维操作卡。
- 操作卡包含常见动作：
  - 生成周报（mock / real）
  - 指定日期 recheck
  - watchdog dry-run / real
  - 发送审核提醒
  - 查询指定日期状态
- 卡片动作 callback 不直接执行业务逻辑，而是创建 `operation_job`。

### Decision 4: Git 自动同步采用“受控目录 + 变更检测 + 可选代理”
- 自动同步范围默认包含：
  - `outputs/review/**`
  - `outputs/published/**`
  - `outputs/review-instructions/**`
  - `outputs/runtime-config/**`
- 默认继续忽略：
  - `outputs/db/**`
  - 通知缓存（如主卡 message 记录）
- push 阶段支持可选代理变量：
  - `GIT_PUSH_HTTP_PROXY`
  - `GIT_PUSH_HTTPS_PROXY`
  - `GIT_PUSH_NO_PROXY`
- 仅当 `git status --porcelain` 命中受控目录变更才提交，避免空提交。

### Decision 5: 幂等与并发控制
- 新增 `operation_jobs`（DB）作为统一任务队列：
  - 字段建议：`id/job_type/payload_json/status/created_by/source/trace_id/error/retry_count/created_at/updated_at`
- worker 采用“串行 + 可配置重试”作为默认策略，降低状态竞争风险。
- 同一 `reportDate` 的冲突任务（例如多个 recheck）以幂等键去重或合并。

## Architecture Sketch

```text
daemon process
  ├─ scheduler
  │   ├─ daily run
  │   ├─ weekly run
  │   ├─ weekly reminder 11:30
  │   └─ weekly watchdog 12:31
  ├─ feishu callback server
  │   ├─ review action callback -> append instruction -> enqueue recheck job
  │   └─ @mention/event callback -> send ops card / enqueue ops job
  └─ job worker
      ├─ run job
      ├─ recheck job
      ├─ watchdog job
      ├─ reminder job
      └─ git sync job
```

## Data Contracts

### operation_jobs（新增）
- `jobType`: `run_weekly | run_daily | recheck_weekly | watchdog_weekly | notify_reminder | git_sync | query_status`
- `payload`: 与 jobType 对应的参数 JSON
- `status`: `pending | running | success | failed | cancelled`
- `traceId`: 关联飞书点击或调度事件

### git_sync_audits（可选新增）
- 记录每次自动同步：变更文件数、commit sha、push 结果、错误信息。

## Failure Handling
- callback 入队失败：返回 error toast + 记录审计。
- worker 执行失败：按策略重试，超限后推送失败回执并记录审计。
- git push 失败：不阻断主流程，进入告警并允许后续重试。
- scheduler 任务失败：单任务失败不影响其他任务触发。

## Security
- callback 鉴权继续沿用 token/signature。
- @机器人操作卡默认沿用“群内任意成员可触发”策略；后续可扩展 allowlist。
- 自动 push 使用本地 git 凭证，不在仓库明文存储 secret。

## Migration Plan
1. 先实现 daemon + scheduler + job 队列基础骨架。
2. 接入 Feishu 主动触发运维卡（@机器人 + 按钮入队）。
3. 接入回调自动 recheck。
4. 调整 `.gitignore` 与 Git 自动同步执行器。
5. 更新文档与学习材料，提供一键联调脚本。

## Open Questions
- 运维操作卡中的高风险动作（如 real run/watchdog real）是否需要二次确认按钮。
- 自动 push 目标分支默认使用当前分支还是固定 `main`，建议以配置项控制。
