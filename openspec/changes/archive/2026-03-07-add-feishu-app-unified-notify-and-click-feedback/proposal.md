# Change: 飞书通知通道统一到应用机器人，并补齐点击反馈闭环

## Why
当前飞书链路同时依赖两类机器人：
1) 自定义 webhook 机器人（待审核通知/提醒/发布回执）
2) 飞书应用机器人（审核卡片与回调）

这种双通道方案带来配置复杂度与排障成本：同一个流程需要维护两套凭证、两种消息模型。

另外，飞书用户点击卡片按钮后缺少明确反馈（成功/失败/当前状态），导致使用者无法判断“动作是否被系统接收并生效”。

## What Changes
- 将飞书通知通道统一为“应用机器人（App Bot）”，覆盖：
  - 待审核通知
  - 11:30 截止提醒
  - 发布结果回执
  - 审核动作结果反馈
- 移除自定义 webhook 机器人配置与发送路径，统一由应用机器人负责消息投递。
- 增加“点击反馈闭环”：
  - 卡片回调请求返回明确反馈（成功/失败）。
  - 在群内追加状态通知，包含 reportDate、动作、执行结果、当前审核阶段/发布状态。
- 增加“可点击报告链接”能力：
  - 通知中保留本地路径字段。
  - 当配置 `REPORT_PUBLIC_BASE_URL` 时附加公网 `reviewUrl/publishedUrl` 字段。
- 保持现有业务语义不变：
  - 群内任意成员可审核
  - last-write-wins
  - reject 必须新建 run
- 增加必要审计字段，确保每次点击与反馈结果可追溯。

## Impact
- Affected specs:
  - `ai-reporting-pipeline`
- Affected code:
  - `src/review/feishu.ts`
  - `src/tools/feishu-ops.ts`
  - `src/cli.ts`
  - `src/review/api-server.ts`（如复用 API 查询状态）
  - `src/review/instruction-store.ts`（审计关联字段补充）
  - `tests/feishu*.test.ts`
  - `tests/*review*.test.ts`
  - `README.md`
  - `docs/architecture.md`
  - `docs/learning-workflow.md`
