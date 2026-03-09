## Context
M5.2 已具备 LLM 总结、排序融合、导语与标题翻译能力，且在失败时可回退规则模式。
但真实运行中仍出现以下问题：

- `missing_content` 在部分 run 呈簇状出现，导致局部回退比例偏高。
- 默认并发值在 spec/代码/文档存在历史差异，影响预期一致性。
- 报告已有“本期导语”，但分类维度缺少“进入正文前的阅读提示”。

M5.3 的目标是做“稳定性+可观测+可读性”一次收口，而不是继续堆叠新能力。

## Goals / Non-Goals
### Goals
- 降低 `missing_content` 集中爆发时的失败扩散，提升整体 LLM 成功率稳定性。
- 将全局并发默认值统一到 `2`，确保配置与行为一致。
- 提升运行可观测性，使失败归因可快速定位。
- 增加分类导读，提升报告可读性与审核效率。

### Non-Goals
- 不引入多 provider 路由或自动切 provider。
- 不改动审核状态机语义（outline/final/reject/timeout）。
- 不在本阶段引入分布式并发控制（仍保持单机基线）。

## Decisions
### Decision 1: 引入“窗口驱动”的自适应降载，而非固定并发
- 在 item-wise 执行中维护短窗口统计（例如最近 N 条执行结果）。
- 当窗口内 `missing_content` 失败占比达到阈值时，进入降载模式（临时并发=1 或更低并发预算）。
- 降载模式仅影响本轮 LLM 步骤，不改变全局配置文件，避免误持久化。

原因：固定并发在 provider 抖动窗口下恢复慢；窗口驱动可更快抑制失败扩散。

### Decision 2: 保留“回退优先于阻断”的主流程原则
- 降载/重试失败后，仍执行条目级或全局回退，不阻断审核与发布。
- 审计中记录完整失败原因与降载状态变化，保证可追溯。

原因：业务主流程（审核/发布）优先级高于 LLM 辅助能力。

### Decision 3: 并发默认值统一为 2
- OpenSpec、CLI 默认、`.env.local.example`、README、PRD、Architecture 统一口径。
- 实际生效并发仍为 `min(nodeConcurrency, globalConcurrency)`。

原因：与现网经验一致，减少 MiniMax 并发抖动风险。

### Decision 4: 分类导读采用“LLM + 模板回退”
- 为主要分类（按条目数/重要度）生成 1 句导读。
- LLM 失败或输出不合法时，回退模板导读（基于分类名称+top item 自动拼接）。

原因：在不增加阻断风险的前提下提升可读性。

## Data Contract Changes
计划扩展 `llmSummaryMeta`（字段名以实现为准）：
- `adaptiveDegradeTriggeredCount`
- `adaptiveRecoverCount`
- `adaptiveCurrentMode`（normal/degraded/recovering）
- `windowSampleSize`
- `windowMissingContentRate`

并保留既有：
- `failureStats`、`retryStats`、`effectiveConcurrency`

兼容性策略：
- 历史 artifact 缺失新字段时，recheck 使用默认值，不报错。

## Risks / Trade-offs
- 过早降载可能牺牲吞吐，增加单次 run 耗时。
  - Mitigation：采用阈值触发 + 自动恢复，避免长期低并发。
- 分类导读新增 LLM 调用可能增加成本。
  - Mitigation：限制导读生成条目范围，并提供模板回退与开关。
- 可观测字段增加后，artifact 体积略增。
  - Mitigation：字段保持聚合统计，不写入冗余明细。

## Migration Plan
1. 先在不改变外部接口的前提下增加内部统计字段与回退逻辑。
2. 再扩展 artifact schema 与 markdown 渲染。
3. 最后统一默认并发口径与文档。

## Validation Plan
- 单测覆盖：
  - 降载触发/恢复阈值
  - 并发裁剪与有效并发
  - 分类导读成功/失败回退
  - 新增元数据向后兼容
- 集成验证：
  - `weekly` 与 `daily` 真实/模拟链路可产出
  - 不阻断 recheck/watchdog/daemon
- 质量门禁：
  - `pnpm test`
  - `pnpm build`
  - `openspec validate add-m5-3-llm-stability-observability-and-category-lead --strict`
