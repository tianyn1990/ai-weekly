## 1. 规格与设计
- [x] 1.1 明确审核指令数据模型（字段、优先级、幂等键）并固化到 design。
- [x] 1.2 明确 pending 周报复检发布的输入/输出契约与失败处理。

## 2. 工程实现
- [x] 2.1 新增审核指令存储接口与文件实现（读取最新指令、按阶段解析）。
- [x] 2.2 调整 weekly 流程节点：从持久化源读取审核结果，CLI flags 仅做 fallback。
- [x] 2.3 新增 pending 周报复检发布入口，支持在不重跑采集链路下执行发布判定。
- [x] 2.4 调整产物写入逻辑，保证复检后 Markdown/JSON 状态一致。

## 3. 测试与文档
- [x] 3.1 新增/更新单元测试：指令优先级、阶段流转、超时自动发布、复检场景。
- [x] 3.2 更新 `docs/architecture.md` 与 `README.md`。
- [x] 3.3 新增一份 M2.5 学习材料（流程图 + 源码导读 + 复盘模板）。
- [x] 3.4 执行并记录验证：`pnpm test`、`pnpm build`、`pnpm run:weekly:mock`、`openspec validate --specs --strict`。
