## Context
M3.1 已完成 watchdog 锁与重试，但审核协作仍依赖 CLI 参数/指令文件。下一阶段要把“人机协作入口”前移到 Feishu，形成可操作、可追踪、可回溯的审稿体验，并把审核意见转化为可执行修订指令。

## Goals / Non-Goals
- Goals:
  - 在 Feishu 完成审核通知、动作输入与截止提醒。
  - 审核意见可结构化回流并驱动修订。
  - 打回后可继续修订并重新进入终稿审核。
- Non-Goals:
  - 本阶段不实现完整 Web 管理后台。
  - 本阶段不替换现有 CLI fallback 审核链路。

## Decisions
- Decision: Feishu 采用“通知 + 交互动作回调”双通道。
  - Why: 通知可达与动作输入一体化，减少跨系统切换。
- Decision: 审核意见采用结构化字段存储。
  - Why: 避免自由文本难以自动执行，便于追踪修订效果。
- Decision: 回流策略优先“修订”而非“取消”。
  - Why: 用户明确要求在原有内容基础上增强，而不是终止流程。
- Decision: 审核权限采用“群内任意成员可执行动作”，冲突按最后一次有效（last-write-wins）。
  - Why: 团队协作门槛最低，且与当前轻量存储模型兼容。
- Decision: 截止提醒固定为每周一 11:30（Asia/Shanghai）一次。
  - Why: 保持提醒节奏稳定，降低通知噪音。
- Decision: 回流中的来源开关/权重与排序权重调整写入全局配置。
  - Why: 用户要求修订经验沉淀到后续周期，而非只作用单次周报。
- Decision: `reject` 后不允许同一轮继续发布，必须新建 run。
  - Why: 明确终止语义，避免同一报告轮次被反复修改导致审计歧义。
- Decision: M3.2 回调入口采用“本地服务 + 隧道代理（2B）”。
  - Why: 以最低接入成本完成联调与上线前验证，后续可平滑升级到长期公网服务。

## Feedback Directive Model
- `candidate_additions`: 人工新增条目（标题、链接、摘要、分类建议）
- `candidate_removals`: 需移除条目 ID/链接
- `new_topics`: 新增主题关键词
- `new_search_terms`: 新增搜索词
- `source_toggles`: 来源启停调整（sourceId -> enabled）
- `source_weight_adjustments`: 来源权重调整
- `ranking_weight_adjustments`: 分类/重要性权重调整
- `editor_notes`: 人工编辑备注（仅展示，不自动执行）

## Risks / Trade-offs
- Feishu 回调依赖网络与签名校验，接入复杂度上升。
  - Mitigation: 保留 CLI fallback，回调失败时可走手工文件注入。
- 结构化修订若约束不足，可能引入误改。
  - Mitigation: 所有自动修订记录到变更日志，并支持二次审核。

## Migration Plan
1. 增加 Feishu notifier 与 callback handler 抽象。
2. 增加审核动作与反馈指令存储 schema。
3. 接入修订节点并串联 recheck 流程。
4. 补充测试、文档与学习材料。

## Action Dictionary
- `approve_outline`: 大纲通过，进入 `final_review`
- `approve_final`: 终稿通过，进入 `approved + published`
- `request_revision`: 进入修订分支，修订后回到 `final_review`
- `reject`: 终止本轮发布尝试，保留产物与审计记录

## Open Questions
- 无（当前阶段关键决策已冻结，后续仅在生产化迁移时评估 2A）。
