# Change: 飞书运维流程增加日报生成入口

## Why
当前飞书运维主动触发面板仅提供周报生成入口，缺少日报手工补偿触发，不利于日常排障与补跑。

## What Changes
- 在飞书运维操作卡中新增“生成日报（真实）”按钮。
- 明确日报按钮同样采用“入队异步执行 + 完成回执”的运维流程。
- 保持飞书主动触发 run 动作默认真实数据策略（`mock=false`）。
- 同步更新相关测试与文档，确保新入口可回归验证。

## Impact
- Affected specs: `ai-reporting-pipeline`
- Affected code:
  - `src/review/feishu.ts`
  - `tests/feishu.test.ts`
- Affected docs:
  - `README.md`
  - `docs/PRD.md`
  - `docs/architecture.md`
  - `docs/learning-sessions/*`
