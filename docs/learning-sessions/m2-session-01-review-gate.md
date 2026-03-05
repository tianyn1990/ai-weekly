# M2 学习导读 01：Human-in-the-loop 审核断点与自动发布

## 本次能力点（只聚焦 1 个）
- 在现有 LangGraph 主链路中引入周报审核断点（大纲审核 + 终稿审核）与超时自动发布策略。

## 为什么先学这个
- 这是你在项目里学习 LangGraph 最关键的一步：从线性 DAG 进入可中断/可恢复的流程编排。
- 该能力直接对应你的业务规则：周一 09:00 待审核，12:30 未审核自动发布。

## 10 分钟源码导读路径
1. `src/pipeline/graph.ts`
   - 看当前线性链路，理解后续要插入的 review 节点位置。
2. `src/pipeline/nodes.ts`
   - 看 `buildReportNode` 后输出的 state；思考审核状态应放在哪个字段。
3. `src/cli.ts`
   - 看当前一次性执行模型；思考如何支持“生成待审核版本”和“自动发布守护任务”。
4. `src/report/markdown.ts`
   - 看周报元信息输出；后续要加审核状态和版本信息。

## 本次应掌握的 3 个 LangGraph 概念
- **State 扩展**：新增审核相关字段（status、deadline、approvedAt、approvedBy 等）。
- **条件分支**：根据 mode（daily/weekly）和审核状态走不同路径。
- **可恢复执行**：从待审核状态恢复到发布状态，而不是每次全量重跑。

## 建议的 M2 目标结构（概念图）
```text
START
  -> collect_items
  -> normalize_items
  -> dedupe_items
  -> classify_items
  -> rank_items
  -> build_outline
  -> review_outline (HITL)
  -> review_final (HITL)
  -> publish_or_wait
  -> build_report
  -> END
```

## 本次练习（15 分钟）
- 练习 A：在纸上或白板写出你认为必须新增的 state 字段（不少于 6 个）。
- 练习 B：定义 3 个审核状态（例如 pending/approved/timeout_published）及其转移条件。
- 练习 C：写出你心中的“最小可运行 M2 验收标准”（3 条以内）。

## 产出要求（学习节奏）
- 先完成 OpenSpec proposal，再开始实现。
- 实现后必须补：流程图、源码导读、复盘报告。
