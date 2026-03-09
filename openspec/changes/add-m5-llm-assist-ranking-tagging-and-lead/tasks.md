## 1. Spec 与设计
- [x] 1.1 确认 M5.2 合并范围：并发治理、标签/评分融合、导语、标题翻译。
- [x] 1.2 明确 LLM 融合评分公式与默认参数（含可配置项与护栏）。
- [x] 1.3 明确失败分层回退策略与 run 级告警合并规则。

## 2. 工程实现
- [x] 2.1 新增全局 LLM 并发闸门，默认上限 3，并与节点并发取最小值。
- [x] 2.2 新增 item 级 LLM assist 输出（domainTag/intentTag/actionability/confidence/llmScore/titleZh）。
- [x] 2.3 在排序阶段实现规则分 + LLM 分融合，并支持权重配置与低置信度回退。
- [x] 2.4 新增报告导语生成逻辑（2-3 句）与失败模板回退。
- [x] 2.5 更新 markdown 渲染，支持中文标题优先展示与导语区块。
- [x] 2.6 扩展 artifact/schema/audit，记录融合评分与回退元数据。
- [x] 2.7 维持飞书 run 级合并告警策略（每 run 至多 1 条）。

## 3. 测试与验证
- [x] 3.1 单测：并发闸门、字段解析、评分融合、低置信度回退、标题翻译回退。
- [x] 3.2 集成：daily/weekly 在成功与失败场景下均可产出报告。
- [x] 3.3 回归：recheck/watchdog/daemon 场景不因新增节点阻断。
- [x] 3.4 执行 `pnpm test`、`pnpm build`、`openspec validate <change-id> --strict`。

## 4. 文档与学习材料
- [x] 4.1 更新 `docs/PRD.md`（M5.2 验收与配置项）。
- [x] 4.2 更新 `docs/architecture.md`（节点拓扑、数据契约、回退策略）。
- [x] 4.3 更新 `docs/learning-workflow.md`（M5.2 阶段与学习目标）。
- [x] 4.4 新增 M5.2 学习会话文档并填写“3 分钟复盘模板”。
