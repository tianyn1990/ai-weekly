## Context
M1 已完成周报待审核稿生成，但缺少审核状态机与自动发布守护行为。M2 需要在不破坏现有主链路稳定性的前提下，补齐审核闭环。

## Goals / Non-Goals
- Goals:
  - 支持周报大纲审核与终稿审核。
  - 支持周一 12:30（Asia/Shanghai）超时自动发布。
  - 保留日报直出路径，避免过度复杂化。
- Non-Goals:
  - 本次不引入外部数据库或 Web 审核界面。
  - 本次不实现多角色审批流。

## Decisions
- Decision: 使用显式状态字段驱动发布决策，而非隐式文件存在性判断。
- Decision: Graph 保持单编排入口，通过条件分支区分 daily/weekly。
- Decision: 自动发布判定由时间函数统一计算，避免分散在多个节点。

## Risks / Trade-offs
- 风险：状态字段增加后，node 输入输出复杂度上升。
  - Mitigation：新增字段集中在 `ReportState` 并统一在 publish 节点更新。
- 风险：仅本地文件持久化可能影响恢复能力。
  - Mitigation：先保证状态可落盘，后续迭代再接入 SQLite。

## Migration Plan
1. 扩展 state 与 graph 节点。
2. 增加 markdown/json 输出状态字段。
3. 验证 mock 模式下可触发审核等待与自动发布分支。
4. 更新架构文档与学习导读。

## Open Questions
- 审核动作的触发方式（CLI 命令 vs 文件标记）在实现前最终确定。
