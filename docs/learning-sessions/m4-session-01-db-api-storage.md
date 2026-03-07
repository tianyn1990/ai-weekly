# M4 学习复盘 01：审核/配置 DB 化与 Review API

## 1. 本次实现了什么
- 审核指令新增 DB 存储实现（SQLite，append-only），并保留文件 fallback。
- runtime config 新增版本化 DB 存储，支持 `expectedVersion` 乐观并发控制。
- 新增审计事件存储，记录审核动作与配置写入事件。
- 新增最小 Review API：审核动作写入/查询、pending 查询、runtime 配置读写、审计查询。
- 新增文件迁移命令：把历史 `review-instructions` 与 runtime 配置导入 DB。

## 2. 流程图（M4）
```text
Feishu/CLI/API action
  -> ReviewInstructionStore (DB primary, file fallback)
  -> review_instructions + audit_events
  -> recheck/watchdog 查询 latest action (decidedAt + id)
  -> publish_or_wait

request_revision feedback
  -> RuntimeConfigStore (DB versioned)
  -> runtime_config_versions + audit_events
  -> 后续 run 读取最新版本配置
```

## 3. 源码导读（建议阅读顺序）
1. `src/storage/sqlite-engine.ts`
   - 看 schema 初始化与单文件串行写锁，理解“为何在单机下仍要序列化 DB 写入”。
2. `src/review/instruction-store.ts`
   - 看 `DbReviewInstructionStore` 与 `HybridReviewInstructionStore`，理解 DB 优先与 fallback 语义。
3. `src/config/runtime-config.ts`
   - 看 `DbRuntimeConfigStore` 与 `RuntimeConfigVersionConflictError`，理解版本冲突保护。
4. `src/review/api-server.ts`
   - 看 API 输入校验与 `PATCH /api/runtime-config` 的冲突返回（409）。
5. `src/storage/migrate-file-to-db.ts`
   - 看迁移去重指纹策略与导入统计。

## 4. 验证结果
- `pnpm build`：通过。
- `pnpm test`：通过（16 files / 58 tests）。
- `openspec validate add-m4-db-api-review-runtime-storage --strict`：通过。
- `openspec validate --specs --strict`：通过。
- 新增测试覆盖：
  - `tests/review-instruction-db-store.test.ts`
  - `tests/runtime-config-db-store.test.ts`
  - `tests/review-api-server.test.ts`
  - `tests/migrate-file-to-db.test.ts`

## 5. 3 分钟复盘模板（M4 版本）
```text
【1】本轮目标（30s）
- 我本轮要验证的能力点是：审核动作与 runtime 配置能否从文件迁移到 DB，并在并发下保持可追溯与可冲突检测。
- 我完成后的可见结果是：审核动作可入库并查询 latest；runtime 配置支持 expectedVersion；提供 API 与迁移命令。

【2】关键实现（60s）
- 我改了哪 3 个核心文件：
  1) `src/storage/sqlite-engine.ts`
  2) `src/review/instruction-store.ts`
  3) `src/config/runtime-config.ts`
- 每个文件“为什么要改”：
  - `sqlite-engine.ts`：统一 DB schema 与串行写入，保证单机一致性。
  - `instruction-store.ts`：把审核动作存储升级为 DB 优先，同时保留文件回退。
  - `runtime-config.ts`：引入版本化写入与冲突检测，避免配置并发覆盖。

【3】运行验证（45s）
- 我执行的命令：
  - `pnpm build`
  - `pnpm test`
  - `openspec validate add-m4-db-api-review-runtime-storage --strict`
- 结果是否符合预期：符合；构建通过，58 个测试全部通过，OpenSpec 严格校验通过。
- 有无 warning/边界场景：
  - 有，DB 不可用时通过 Hybrid store 回退到文件读写（可配置关闭）。
  - 有，runtime 配置在 expectedVersion 过期时返回 409 冲突。

【4】设计取舍（30s）
- 我放弃了哪个方案，原因是：放弃 native sqlite 依赖（build script 易受环境限制），改用 `sql.js`（WASM）保证跨环境稳定安装。
- 当前实现的风险点是：`sql.js` 每次打开/导出文件成本高，后续可按访问模式优化连接生命周期。

【5】下一步（15s）
- 我下一轮最小可执行目标是：进入 M5，先接入 LLM 总结节点，并保持规则分类/排序可回退。
```
