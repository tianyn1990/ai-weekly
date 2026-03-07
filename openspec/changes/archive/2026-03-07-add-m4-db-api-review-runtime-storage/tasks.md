## 1. 规格与设计
- [x] 1.1 冻结 DB schema（review_instructions/runtime_config_versions/audit_events）与索引策略。
- [x] 1.2 冻结 API 契约（请求字段、响应结构、错误码、鉴权入口）。
- [x] 1.3 冻结迁移与双轨兼容策略（DB 优先 + 文件 fallback）。

## 2. 工程实现
- [x] 2.1 新增 DB 初始化与 schema migration 模块。
- [x] 2.2 实现审核动作 repository（append + latest 查询 + reviewStartedAt 过滤）。
- [x] 2.3 实现 runtime 配置版本 repository（读取当前版本 + optimistic concurrency patch）。
- [x] 2.4 实现审计事件 repository（写入 + 查询）。
- [x] 2.5 实现最小 API（review-actions/runtime-config/audit-events/pending）。
- [x] 2.6 将 Feishu 回调写入路径切换为 DB/API 优先，保留文件 fallback。
- [x] 2.7 将 recheck/watchdog/pipeline 读取路径切换为 DB/API 优先，保留文件 fallback。
- [x] 2.8 新增历史数据迁移命令（文件 -> DB）与迁移结果报告。

## 3. 测试与验证
- [x] 3.1 单测：repository 查询规则、并发冲突、reject 终止、reviewStartedAt 边界。
- [x] 3.2 集成测试：Feishu 回调入库 -> recheck 发布，runtime patch -> 后续 run 生效。
- [x] 3.3 回归测试：`pnpm test` 与 `pnpm build` 全量通过。
- [x] 3.4 OpenSpec 验证：`openspec validate add-m4-db-api-review-runtime-storage --strict`。

## 4. 文档与学习交付
- [x] 4.1 更新 `docs/architecture.md`（存储层/API 层/迁移策略）。
- [x] 4.2 更新 `README.md`（运行方式、迁移命令、故障排查）。
- [x] 4.3 更新 `docs/learning-workflow.md`（M4 学习节奏与里程碑）。
- [x] 4.4 新增 M4 学习会话文档并自动填写“3 分钟复盘模板（M4 版本）”。
