## Context
飞书主动触发入口本质是运维补偿与排障入口，默认应反映线上真实链路。如果继续默认 mock，会导致“点击成功但数据不可信”的认知偏差。

## Goals / Non-Goals
- Goals:
  - 飞书主动触发 `run_weekly` 默认走真实数据。
  - 卡片文案与实际执行行为一致，减少误导。
  - 保留 CLI `--mock` 作为独立调试能力。
- Non-Goals:
  - 本次不改动 scheduler 自动任务策略。
  - 本次不新增“mock/real 双按钮”复杂交互。

## Decisions
- Decision 1: 运维卡按钮文案改为“生成周报（真实）”。
  - Why: 明确执行语义，避免误解。
- Decision 2: `buildOperationPayloadFromFeishuAction` 中 `run_weekly/run_daily` 固定 `mock=false`。
  - Why: 统一飞书入口行为，以真实链路为主。
- Decision 3: 不改 CLI 参数体系。
  - Why: 兼容既有本地测试脚本与教学材料。

## Risks / Trade-offs
- 风险：真实数据源偶发抖动会让飞书触发失败率高于 mock。
  - Mitigation：保留现有 warning/回退机制，测试流程中加入源诊断与日志排查步骤。

## Migration Plan
1. 更新 spec delta 并校验。
2. 修改代码与单元测试。
3. 更新 README/architecture 的运维说明。
4. 执行测试与构建。
5. 归档 change（不提交）。
