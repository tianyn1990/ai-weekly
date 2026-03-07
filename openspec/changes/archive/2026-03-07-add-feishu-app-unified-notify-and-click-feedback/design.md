## Context
项目在 M3.2 已打通飞书卡片回调，在 M4 已完成 DB/API 存储升级。当前阻塞体验的核心问题：
- 通知通道割裂：自定义 webhook 与应用机器人并存。
- 用户反馈缺失：点击按钮后飞书端没有清晰反馈信息。

本变更目标是“统一通道 + 完整反馈闭环”，在不改变审核业务规则的前提下提升可用性与可运维性。

## Goals / Non-Goals
- Goals:
  - 使用应用机器人作为通知与交互主通道，减少多机器人配置复杂度。
  - 为每次卡片点击提供即时反馈（成功/失败）与状态回执。
  - 让群内用户能直接看到动作结果与当前流程状态。
  - 保持当前审核语义（last-write-wins、reject 约束）不变。
- Non-Goals:
  - 本阶段不实现飞书后台可视化配置页面。
  - 本阶段不改变审核权限模型（仍为群内任意成员）。
  - 本阶段不引入分布式回调网关。

## Key Decisions
- Decision 1: 通知策略采用 `app-only`，移除 webhook 路径。
  - Why: 彻底降低配置复杂度，避免“双机器人”导致的排障分叉。
  - 配置建议：
    - 必填：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`REVIEW_CHAT_ID`
    - 可选：`REPORT_PUBLIC_BASE_URL`

- Decision 2: 回调点击后必须返回“可感知反馈”。
  - Why: 解决“用户不知道是否成功”的核心痛点。
  - 反馈层次：
    1) 回调响应体（面向点击人，成功/失败短反馈）
    2) 群内状态消息（面向协作人，完整状态）

- Decision 3: 群内状态消息统一模板。
  - Why: 提升信息一致性，便于排障与审计。
  - 建议字段：`reportDate`, `action`, `operator`, `result`, `reviewStage`, `reviewStatus`, `publishStatus`, `reason?`。

- Decision 4: 保持动作写入语义不变，仅补“反馈结果审计”。
  - Why: 降低回归风险，复用现有 M4 DB/审计能力。

- Decision 5: 通知附加可点击报告链接（可选）。
  - Why: 飞书里本地路径不可直接访问，需给审核人一个可点击入口。
  - 规则：当 `REPORT_PUBLIC_BASE_URL` 存在时，基于产物相对路径拼接 `reviewUrl/publishedUrl`。

## Message Flow
```text
User clicks card button
  -> Feishu callback -> local callback endpoint
  -> auth/signature verify
  -> write review instruction (DB)
  -> compute current state summary (read review artifact / DB)
  -> respond callback body (success/failure message)
  -> send group status message via app bot
```

## Failure Handling
- 回调鉴权失败：
  - 回调响应：失败提示（无权限/签名错误）
  - 记录审计：`feishu_callback_rejected`
- 指令写入失败：
  - 回调响应：失败提示（系统错误，稍后重试）
  - 群消息：可选发送失败告警（避免静默）
- 状态查询失败：
  - 回调响应保持成功（动作已落库）
  - 群消息降级为“动作已记录，状态刷新失败”

## Compatibility & Migration
- webhook 机器人配置将不再生效，建议从环境变量中移除。
- 推荐保留配置：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`REVIEW_CHAT_ID`、回调鉴权配置。
- 若需要通知中的可点击链接，新增 `REPORT_PUBLIC_BASE_URL`。

## Testing Strategy
- 单元测试：
  - app-only 通知发送
  - 点击反馈响应体（成功/失败）
  - 群状态消息模板字段完整性
  - `REPORT_PUBLIC_BASE_URL` 链接拼接
- 集成测试：
  - 回调 -> 落库 -> 回调反馈 -> 群状态推送
- 回归测试：
  - 既有 recheck/watchdog/审核状态机行为不变

## Risks / Trade-offs
- 应用机器人 API 依赖 token 获取，网络波动会影响投递。
  - Mitigation: token 缓存 + 启动时配置检查 + 审计追踪 `notifyResult`。
- 新增群状态消息可能导致刷屏。
  - Mitigation: 合并短时间重复动作，或按动作类型限流。
- 回调反馈格式若与飞书规范不一致会造成前端无提示。
  - Mitigation: 使用官方回调响应格式并增加联调用例。

## Open Questions
- 无。核心方向已确认：
  - 统一应用机器人主通道
  - 点击反馈必须覆盖成功/失败/当前状态
