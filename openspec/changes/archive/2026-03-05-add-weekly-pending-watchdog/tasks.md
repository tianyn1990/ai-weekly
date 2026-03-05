## 1. 规格与设计
- [x] 1.1 明确 watchdog 的扫描范围、筛选条件、执行摘要结构。
- [x] 1.2 明确 dry-run 行为边界（不落盘、不改变状态）。

## 2. 工程实现
- [x] 2.1 在 CLI 增加 watchdog 入口与参数（含 dry-run）。
- [x] 2.2 实现 pending 周报扫描、筛选与顺序复检执行。
- [x] 2.3 输出处理摘要日志（processed/published/skipped/failed）。

## 3. 测试与文档
- [x] 3.1 新增/更新单测：扫描筛选、dry-run、超时发布、已发布跳过。
- [x] 3.2 更新 `README.md` 与 `docs/architecture.md` 使用说明。
- [x] 3.3 新增 M3 学习材料（流程图 + 源码导读 + 3 分钟复盘模板）。
- [x] 3.4 执行并记录验证：`pnpm test`、`pnpm build`、`openspec validate --specs --strict`。
