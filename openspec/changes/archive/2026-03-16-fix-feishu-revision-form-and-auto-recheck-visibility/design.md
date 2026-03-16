## Context
`refactor-single-final-review-and-react-revision-loop` 已把修订执行内核升级为 ReAct（LLM Planner + 受限工具执行），并支持 `feedback.revisionRequest/revisionScope/revisionIntent/continueFromCheckpoint`。

但飞书主卡当前仍以固定按钮 `reason` 触发 `request_revision`，未提供自由文本入口，导致 ReAct 的输入能力在实际交互层未完全释放。

此外，`request_revision` 触发的自动 recheck 任务来源为 `feishu_callback_auto`，运行态通知策略目前偏向手工运维任务，导致用户可见性不足，容易产生“点击后无后续反馈”的误判。

## Goals / Non-Goals
### Goals
- 提供飞书侧可直接填写的修订表单，真正把自由文本修订意见传入 ReAct。
- 让自动 recheck 在飞书可见（至少可见受理、开始、进度、终态）。
- 失败/中断时提供可恢复路径，形成闭环。
- 加入运行时长护栏，避免自动任务僵持。

### Non-Goals
- 不在本次引入新的外部调度系统。
- 不在本次变更 ReAct 工具集合语义。
- 不在本次实现跨会话长历史对话记忆式修订。

## Decisions
### 1) 修订入口改为“表单提交”而非单按钮直接写指令
- 主审核卡“要求修订”按钮改为打开修订表单卡。
- 表单字段：
  - `revisionRequest`（必填，自由文本，支持多条意见）
  - `revisionScope`（可选，`all/category/item`）
  - `revisionIntent`（可选，`general_refine/content_update/structure_adjust/add_information/remove_information/other`）
  - `continueFromCheckpoint`（可选，布尔）
- 提交后统一映射为 `request_revision + feedback`。

原因：
- 把 ReAct 所需信息前置到入口层，避免 Planner 只能消费模糊 reason。
- 保留结构化字段可扩展性，便于后续做规则路由与差异化策略。

### 2) 兼容策略：保留 reason-only 旧入口
- 若回调未携带 `feedback`，仍允许按历史行为写入 `reason`。
- ReAct 继续使用现有 fallback：`reason -> implicit revisionRequest`。

原因：
- 保证历史卡片、历史回调、手工模拟请求不破坏。

### 3) 自动 recheck 可见性：统一进度卡 + 生命周期回执
- `feishu_callback_auto` 任务也进入同一进度通知通道。
- 通知形态：
  - 高频信息：单任务进度卡 upsert（避免刷屏）
  - 关键里程碑：受理/开始/终态文本回执
- 关键阶段建议：
  - `recheck_started`
  - `revision_agent_running`
  - `build_report`
  - `notify_review_pending`
  - `finished`

原因：
- 用户关心“是否执行、执行到哪、是否结束”，不需要逐日志细节。

### 4) 失败恢复入口标准化
- 失败或中断时发送“修订恢复卡”，至少包含：
  - 失败分类（`planning_failed`、`ambiguous_target`、`tool_execution_failed`、`wall_clock_timeout`、`step_limit_reached` 等）
  - 失败摘要（短文本）
  - 操作按钮：
    - `retry_revision_with_edit`（编辑后重试）
    - `continue_revision_from_checkpoint`（继续执行）
    - `approve_final`（直接通过并发布）

原因：
- 用户需要在飞书内闭环，不应强依赖 CLI 补救。

### 5) 卡住治理：自动 recheck 子进程 wall-clock timeout
- 为 `recheck_weekly` 子进程增加总时长上限（可配置，建议默认 10~15 分钟）。
- 超时后按失败终态落盘并通知，失败分类为 `subprocess_timeout`。

原因：
- 解决“长期 running 无反馈”的运维盲区。

## Data / Contract
### 回调 payload（新增/强化）
- `feedback.revisionRequest: string`（必填于表单路径）
- `feedback.revisionScope?: enum`
- `feedback.revisionIntent?: enum`
- `feedback.continueFromCheckpoint?: boolean`

### 运行配置（新增）
- `REVISION_RECHECK_MAX_WALL_CLOCK_MS`（或复用统一子进程 timeout 配置并按 jobType 覆盖）

## Failure Handling
- 表单字段校验失败：回调直接失败并返回可读错误。
- 修订执行失败：
  - 不阻断主流程基础可读产物；
  - 回写失败分类；
  - 发送恢复卡。
- 通知发送失败：
  - 不影响任务执行终态；
  - 记录 warning 便于排障。

## Migration Plan
1. 上线表单入口与 payload 解析，保留旧入口兼容。
2. 打开自动任务进度通知（先 milestone 级别）。
3. 引入 recheck timeout 与失败恢复卡。
4. 回归飞书端完整链路与去重逻辑。

## Open Questions
- 表单 `revisionRequest` 是否需要最小长度（例如 >= 8 字）以减少“空洞修订”。
- “编辑后重试”是否直接预填上次文本（取决于飞书卡片能力与实现复杂度）。
