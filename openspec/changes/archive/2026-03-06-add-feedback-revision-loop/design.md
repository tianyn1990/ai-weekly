## Context
M3.2 将审核动作输入统一到 Feishu，但 `request_revision`/`reject` 仅影响当前阶段通过与否，尚未实现“意见可执行、配置可沉淀、打回可约束”的业务闭环。M3.3 目标是把审核意见转成结构化执行路径，并形成稳定的状态机行为。

## Goals / Non-Goals
- Goals:
  - 将审核意见标准化为可执行回流指令。
  - 让 `request_revision` 真正驱动修订并回到终稿审核。
  - 让来源/排序类调整写入全局配置并影响后续周期。
  - 让 `reject` 具备“当前 run 终止、必须新建 run”硬约束。
  - 保持 watchdog 与 CLI fallback 兼容。
- Non-Goals:
  - 本阶段不引入数据库（继续文件存储）。
  - 本阶段不引入 Web 后台进行回流指令可视化编辑。
  - 本阶段不引入分布式互斥。

## Decisions
- Decision: 回流指令采用“动作 + payload”模型，并在写入时进行 schema 校验。
  - Why: 降低错误输入对发布链路的破坏风险。
- Decision: 回流执行基于已产出的 review snapshot，而非重新全链路采集。
  - Why: 保持复检路径成本低、结果可复现。
- Decision: 全局配置仅接受“白名单字段”更新（source_toggles/source_weights/ranking_weights）。
  - Why: 避免审核意见意外覆盖非目标配置。
- Decision: `reject` 在状态层引入“terminal for current run”标记。
  - Why: 明确终止语义，防止同轮次重复推进造成审计歧义。
- Decision: 所有自动修订输出执行日志（before/after 摘要 + 应用失败项）。
  - Why: 便于问题定位与学习复盘。

## Feedback Directive Model
- `candidate_additions`: 人工新增条目（title/url/summary/category 可选）
- `candidate_removals`: 依据 itemId 或 url 删除候选
- `new_topics`: 新增主题关键词
- `new_search_terms`: 新增搜索词
- `source_toggles`: 来源启停（sourceId -> enabled）
- `source_weight_adjustments`: 来源权重调整（sourceId -> delta/absolute）
- `ranking_weight_adjustments`: 排序权重调整（dimension -> delta/absolute）
- `editor_notes`: 人工备注，仅记录，不执行

## State Transitions
- `request_revision`:
  - 从 `outline_review/final_review` 进入 `revision_requested`
  - 执行回流修订后进入 `final_review`
- `reject`:
  - 标记 `reviewStatus=rejected`
  - 当前 run 进入终止态，`recheck/watchdog` 不再发布该 run
  - 仅允许新 run（新 runId）重新生成并进入审核

## Risks / Trade-offs
- 结构化指令粒度增加后，错误指令可能导致修订偏离预期。
  - Mitigation: 指令 schema 校验 + 应用结果审计 + 非法项跳过并告警。
- 全局配置被频繁调整可能造成排序波动。
  - Mitigation: 配置变更写审计日志，并限制单次调整幅度（可选）。
- reject 强约束可能增加人工重跑成本。
  - Mitigation: 提供清晰 CLI 提示与“一键新 run”命令范式。

## Migration Plan
1. 扩展指令 schema 与存储读取逻辑（兼容历史格式）。
2. 实现 feedback executor 与配置写入器。
3. 串联 recheck/watchdog 的修订与 reject 终止逻辑。
4. 更新 markdown 输出与运行日志，体现修订/拒绝状态。
5. 补充测试、文档与学习材料。

## Open Questions
- 无（关键业务规则已由用户确认：群内任意成员、last-write-wins、11:30 提醒一次、回流全局生效、reject 必须新建 run）。
