## Context
M2 已具备审核断点与超时自动发布，但审核输入仍依赖运行时 CLI flags。该方式无法支撑“人工审核与定时任务解耦”的目标：人工审核发生在任意时间点，而发布任务可能由 cron/worker 在稍后触发。为满足“周一 9:00 准备审核稿，12:30 未审自动发布”，系统需要从持久化介质读取审核动作，并支持对 pending 周报进行复检发布。

## Goals / Non-Goals
- Goals:
  - 审核动作可持久化并被后续任务读取。
  - 周报可在不重新采集内容的前提下复检并发布。
  - 保持现有 CLI 演练方式可用（向后兼容）。
- Non-Goals:
  - 本阶段不实现 Web 审核 UI。
  - 本阶段不引入数据库迁移（先用文件存储）。

## Decisions
- Decision: 引入 `ReviewInstructionStore` 抽象，首版落地 `FileReviewInstructionStore`。
  - Why: 先满足最小可用闭环，后续替换为 DB/API 时不影响 pipeline 节点。
- Decision: 审核指令按 `mode + reportDate + stage` 定位，读取“最新有效指令”。
  - Why: 支撑重复提交与幂等覆盖，避免多条历史指令冲突。
- Decision: 新增复检入口（建议 CLI 子命令或 flag），仅加载既有 review JSON 快照并执行“审核判定 -> 发布判定 -> 渲染”。
  - Why: 避免重跑采集链路导致内容漂移，保证“发布的是待审核版本”。
- Decision: CLI flags 保留为 fallback。
  - Why: 保持学习脚本与本地回归流程不破坏。

## Risks / Trade-offs
- 文件存储并发写入存在竞争风险。
  - Mitigation: 首版限定单写场景；后续迁移 DB 时增加版本号或 optimistic lock。
- 复检发布依赖快照完整性。
  - Mitigation: 扩展 review JSON 包含渲染所需最小快照字段，并在加载时做 schema 校验。

## Migration Plan
1. 增加审核指令 schema 与文件读取器。
2. 在 weekly 审核节点接入持久化读取逻辑，保留 flags fallback。
3. 扩展 review JSON 快照字段并提供复检入口。
4. 完成测试与文档同步。

## Open Questions
- 复检入口命名：`run --recheck-pending` 还是新增 `recheck` 子命令？
- 审核指令文件路径默认放置在 `outputs/review-instructions/` 是否满足团队运维习惯？
