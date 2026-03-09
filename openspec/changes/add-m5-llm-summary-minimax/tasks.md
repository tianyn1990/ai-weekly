## 1. Spec 与设计
- [x] 1.1 明确 M5.1 范围：仅总结增强，不改分类/排序主导权。
- [x] 1.2 明确两段式总结策略（逐条总结 + 快速重点聚合）与 4-12 条自适应规则。
- [x] 1.3 明确 MiniMax 首发接入与 provider 抽象边界。

## 2. 工程实现
- [x] 2.1 新增 LLM provider 抽象与 MiniMax 实现，支持超时/重试/错误归类。
- [x] 2.2 在 LangGraph 中新增 `llm_summarize` 节点，并接入 run + recheck 流程。
- [x] 2.3 扩展状态模型与 artifact 落盘 schema（item summaries、quick digest、llm meta）。
- [x] 2.4 更新 markdown 渲染：优先 LLM 摘要，失败时规则回退并可见标记。
- [x] 2.5 增加 run 级“LLM 降级合并告警”飞书通知能力（单 run 最多 1 条）。
- [x] 2.6 增加审计事件：started/completed/fallback。

## 3. 测试与验证
- [x] 3.1 单测：provider 解析、schema 校验、证据校验、回退分支、告警去重。
- [x] 3.2 集成：daily/weekly 都验证 LLM 成功与失败回退路径。
- [x] 3.3 验证 recheck/watchdog/daemon 场景在 LLM 失败时仍不阻断。
- [x] 3.4 执行 `pnpm test`、`pnpm build`、`openspec validate --specs --strict`。

## 4. 文档与学习材料
- [x] 4.1 更新 `docs/PRD.md`（M5.1 约束与验收细则）。
- [x] 4.2 更新 `docs/architecture.md`（节点、契约、回退与告警策略）。
- [x] 4.3 更新 `docs/learning-workflow.md`（M5.1 学习路径）。
- [x] 4.4 新增 M5.1 学习会话文档并自动填写“3 分钟复盘模板”。
