## 1. 规格与设计
- [x] 1.1 明确回流指令 schema（字段、校验、兼容策略）。
- [x] 1.2 明确 `request_revision`/`reject` 状态机与 run 级约束。
- [x] 1.3 明确全局配置更新边界与审计字段。

## 2. 工程实现
- [x] 2.1 扩展审核指令读写模型，支持结构化回流 payload。
- [x] 2.2 实现 feedback executor（候选增删、主题词/搜索词、权重与来源调整）。
- [x] 2.3 在 recheck 路径接入修订执行，并在修订后回到 `final_review`。
- [x] 2.4 实现 reject 终止当前 run 的硬约束（watchdog/recheck 均生效）。
- [x] 2.5 将来源与排序相关调整写入全局配置，并确保后续 run 读取生效。
- [x] 2.6 更新报告渲染与运行日志，反映修订结果与拒绝原因。

## 3. 测试与文档
- [x] 3.1 单测：指令 schema 校验、last-write-wins、回流执行分支、reject 约束、配置落地。
- [x] 3.2 集成测试：request_revision -> final_review -> approve_final 全链路。
- [x] 3.3 更新 `README.md`、`docs/architecture.md`、`docs/learning-workflow.md`。
- [x] 3.4 新增 M3.3 学习材料并自动填写“3 分钟复盘模板（M3.3 版本）”。
- [x] 3.5 执行验证：`pnpm test`、`pnpm build`、`openspec validate --specs --strict`。
