# Change: 飞书主动触发改为真实数据执行

## Why
当前飞书运维操作卡中的“生成周报”实际走 `mock` 数据，和用户预期不一致，容易在联调与值班场景中误判流程健康状态。

## What Changes
- 将飞书运维操作卡的“生成周报（mock）”改为“生成周报（真实）”。
- 飞书按钮触发 `run_weekly`（以及同类 run 动作）时，默认使用真实数据采集（`mock=false`）。
- 保持 CLI 的 `--mock` 能力不变，供本地调试与教学场景使用。
- 更新 README 与架构文档，明确“飞书主动触发默认真实数据”的行为与测试方式。

## Impact
- Affected specs: `ai-reporting-pipeline`
- Affected code:
  - `src/cli.ts`
  - `src/review/feishu.ts`
  - `tests/feishu.test.ts`
- Affected docs:
  - `README.md`
  - `docs/architecture.md`
