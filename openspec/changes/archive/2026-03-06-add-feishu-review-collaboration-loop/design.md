## Context
M3.1 已完成 watchdog 锁与重试，但审核协作仍依赖 CLI 参数/指令文件。M3.2 目标是把“人机协作入口”前移到 Feishu，形成可操作、可追踪、可回溯的审稿体验。

## Goals / Non-Goals
- Goals:
  - 在 Feishu 完成审核通知、动作输入与截止提醒。
- Non-Goals:
  - 本阶段不实现完整 Web 管理后台。
  - 本阶段不替换现有 CLI fallback 审核链路。
  - 本阶段不实现审核意见回流修订执行（M3.3）。
  - 本阶段不实现 `reject` 后强制新建 run 的硬约束（M3.3）。

## Decisions
- Decision: Feishu 采用“通知 + 交互动作回调”双通道。
  - Why: 通知可达与动作输入一体化，减少跨系统切换。
- Decision: 审核权限采用“群内任意成员可执行动作”，冲突按最后一次有效（last-write-wins）。
  - Why: 团队协作门槛最低，且与当前轻量存储模型兼容。
- Decision: 截止提醒固定为每周一 11:30（Asia/Shanghai）一次。
  - Why: 保持提醒节奏稳定，降低通知噪音。
- Decision: M3.2 回调入口采用“本地服务 + 隧道代理（2B）”。
  - Why: 以最低接入成本完成联调与上线前验证，后续可平滑升级到长期公网服务。
- Decision: 回调鉴权支持 Bearer、query token、`x-callback-token` 三种入口。
  - Why: 兼容 Feishu 原生回调难以自定义 Authorization header 的现实限制。
- Decision: 回调 payload 兼容简化 JSON 与 Feishu 原生结构（含 `url_verification`）。
  - Why: 降低接入端改造成本，提升联调成功率。

## Risks / Trade-offs
- Feishu 回调依赖网络与签名校验，接入复杂度上升。
  - Mitigation: 保留 CLI fallback，回调失败时可走手工文件注入。
- 本地隧道 URL 变更可能导致飞书后台回调地址失效。
  - Mitigation: 通过 `feishu:dev` 输出 callback-url，并在文档中提供快速排障步骤。

## Migration Plan
1. 增加 Feishu notifier 与 callback handler 抽象。
2. 增加审核动作持久化 schema 并兼容回调多 payload 形态。
3. 增加 Feishu 运维工具（token/chat 列表/发卡片）用于联调自动化。
4. 补充测试、文档与学习材料。

## Action Dictionary
- `approve_outline`: 大纲通过，进入 `final_review`
- `approve_final`: 终稿通过，进入 `approved + published`
- `request_revision`: 本阶段先记录为未通过当前审核阶段，修订执行留到 M3.3
- `reject`: 本阶段先记录为未通过当前审核阶段，强制新建 run 留到 M3.3

## Open Questions
- 无（M3.2 范围已冻结，M3.3 将独立建 change）。
