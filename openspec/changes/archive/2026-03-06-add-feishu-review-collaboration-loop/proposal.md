# Change: 增加 Feishu 审核协同能力（M3.2）

## Why
当前系统已具备审核状态机与 watchdog 自动发布能力，但人工协作仍偏技术向（CLI/文件）。在团队使用场景下，需要先把“通知 + 审核动作输入”迁移到 Feishu，降低操作门槛并提高审稿效率。

## What Changes
- 接入 Feishu 作为审核协同入口：周报生成通知、审核截止提醒、发布结果回执。
- 支持通过 Feishu 回写审核动作：`approve_outline`、`approve_final`、`request_revision`、`reject`。
- 审核权限模型：群内任意成员可审核，多人并发操作采用最后一次有效（last-write-wins）。
- 截止提醒策略：每周一 11:30（Asia/Shanghai）发送一次提醒。
- 保留 CLI 审核作为 fallback，避免协同链路故障影响发布兜底。
- 回调接入形态采用 2B（本地服务 + 隧道代理）以降低联调门槛。

## Impact
- Affected specs: `ai-reporting-pipeline`
- Affected code:
  - `src/cli.ts`
  - `src/review/*`
  - `src/tools/feishu-ops.ts`
  - `tests/*`
  - `README.md`
  - `docs/architecture.md`
