# Change: M4 审核与运行时配置存储升级到 DB/API

## Why
当前系统已在 M3.3 完成审核协同与回流修订闭环，但核心状态仍以文件写入为主（`review-instructions` 与 `runtime-config`）。在持续迭代下，文件模式暴露出三类问题：

1. 并发一致性薄弱：多入口（CLI/Feishu/watchdog）并发写入时难以严格保证状态一致。
2. 审计查询成本高：需要按文件扫描与手工聚合，难以做 trace 级追踪与后续运营分析。
3. 接口化能力不足：外部系统无法通过统一 API 获取待审状态、审计记录与配置版本。

M4 目标是将“审核动作 + 回流配置 + 审计事件”升级到 DB/API，形成可并发、可追溯、可扩展的持久化基线，并保持与当前流程行为一致。

## What Changes
- 增加 DB 持久化层（M4 首选 SQLite，本地单机部署；结构兼容后续 PostgreSQL 迁移）。
- 增加审核动作事件表（append-only）与统一审计事件表。
- 增加 runtime 配置版本表，支持乐观并发控制（expectedVersion）。
- 增加最小可用 API：
  - 写入审核动作
  - 查询最新有效审核动作
  - 查询待处理周报
  - 读写 runtime 配置
  - 查询审计事件
- 增加文件到 DB 的迁移命令，支持历史数据导入与校验报告。
- 增加双轨兼容策略（过渡期 DB 优先 + 文件 fallback），保证线上流程平滑切换。
- 保持业务规则不变：
  - `last-write-wins`（基于 `decidedAt`）
  - `reviewStartedAt` 过滤历史动作
  - `reject` 终止当前 run 发布尝试

## Impact
- Affected specs:
  - `ai-reporting-pipeline`
- Affected code:
  - `src/review/instruction-store.ts`（抽象扩展与 DB 实现接入）
  - `src/config/runtime-config.ts`（文件实现保留，新增 DB 版本实现）
  - `src/review/feishu.ts`（回调写入改为 DB/API 优先）
  - `src/pipeline/recheck.ts`
  - `src/pipeline/watchdog.ts`
  - `src/cli.ts`（新增 DB/API 参数与迁移命令入口）
  - `src/*`（新增 db/repository/api 模块）
  - `tests/*`（新增 repository/API/迁移/并发测试）
  - `README.md`
  - `docs/architecture.md`
  - `docs/learning-workflow.md`
