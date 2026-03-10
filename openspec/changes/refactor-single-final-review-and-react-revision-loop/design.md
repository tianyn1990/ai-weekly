## Context
当前周报审核交互仍是双阶段（`outline_review`、`final_review`），但实际产物差异不足以支撑双卡点，造成审核与回执噪音。
同时，现有修订机制偏结构化字段输入，对自然语言复杂修订支持不足，用户难以“一次输入多条意见并真实生效”。

本次设计目标是在不牺牲可审计与可控性的前提下，引入 ReAct 能力来提高修订表达力与命中率，并简化人工审核路径。

## Goals / Non-Goals
### Goals
- 将 weekly 审核收敛为单阶段 `final_review`，降低人工操作复杂度。
- 引入受限 ReAct 修订 Agent，支持自由文本多意见输入与多步执行。
- 保证修订流程“可追溯、可回放、可中断恢复、可失败解释”。
- 保证历史数据兼容与主流程稳定性（run/recheck/watchdog 不中断）。

### Non-Goals
- 不实现“LLM 直接输出整份新 Markdown 并覆盖发布稿”。
- 不在本次实现多机分布式协同执行。
- 不在本次引入无限制自定义工具调用。

## Decisions
### 1) 审核状态机改为单阶段
- Weekly 统一进入 `final_review`。
- `approve_final`：发布。
- `request_revision`：进入修订回路，完成后仍回到 `final_review`。
- `reject`：终止当前 run 发布。
- 历史 `approve_outline` 仅做兼容提示，不再推进新阶段。

**Reasoning**
- 减少无效审核停顿，提高协作效率。
- 与当前“内容几乎一次成稿”实际过程一致。

### 2) 修订使用“受限 ReAct”而非“整文重写”
ReAct 由以下节点构成：
1. `Planner`（LLM）：自由文本 -> `revision_tasks[]`（严格 JSON）
2. `Executor`（tools）：逐任务定位并 patch 结构化快照
3. `Validator`（rule + optional LLM）：校验结构/证据/质量
4. `Reporter`：产出 diff 与结果回执

**Reasoning**
- 兼顾表达力与工程可控性。
- 避免整文重写导致结构破坏、证据失配、审计困难。

### 3) Planner 输出 contract
Planner 必须输出可 `JSON.parse` 的对象，核心字段：
- `tasks`: 任务数组（可多条）
- `target`: 定位信息（itemId/evidenceId/link/title/category/module）
- `operation`: 操作类型
- `payload`: 操作参数
- `confidence`: 置信度
- `requires_clarification`: 是否需人工澄清

禁止 Markdown、code fence、解释性文本。

### 4) 工具白名单与操作域
允许操作（初版）：
- 条目级：改标题中文、改摘要、改推荐、改分类、改重要性、删除/恢复。
- 模块级：新增模块、删除模块、重排模块、模块导语改写。
- 证据级：修复证据链接、补证据说明、证据冲突标记。
- 配置级：topic/search term/source toggle/source weight/rank weight。
- 流水线级：重排、重建报告、可选局部补采触发。

禁止操作：
- 任意文件写入。
- 绕过 schema 的原始 Markdown 全文替换。

### 5) 失败处理与用户可恢复能力
失败分类：
- `planning_failed`
- `ambiguous_target`
- `target_not_found`
- `tool_execution_failed`
- `validation_failed`
- `step_limit_reached`
- `wall_clock_timeout`

对应回执：
- 返回失败原因、已完成动作、未完成动作。
- 提供后续入口：编辑后重试 / 继续执行 / 直接发布。

### 6) 运行护栏（可配置）
- `REVISION_AGENT_MAX_STEPS=20`
- `REVISION_AGENT_MAX_WALL_CLOCK_MS=600000`（10 分钟，总流程超时）
- `REVISION_AGENT_MAX_LLM_CALLS`（默认 30）
- `REVISION_AGENT_MAX_TOOL_ERRORS`（默认 5）

超限即中断，保持原稿不被破坏。

## Risks / Trade-offs
- ReAct 引入多次 LLM 调用，耗时与成本上升。
  - Mitigation: 步数/总时长/调用数护栏 + 缓存与重试退避。
- 自由文本修订存在目标歧义。
  - Mitigation: 目标定位置信度门控，低置信度进入澄清分支。
- 单阶段审核减少一道人工屏障。
  - Mitigation: 强化修订回执、diff 可视化、直接发布兜底动作需显式点击。

## Migration Plan
1. 升级状态机：新 run 使用单阶段；历史 run 兼容读取。
2. 升级飞书卡片模板与动作适配器。
3. 增加 ReAct 修订节点并接入 `request_revision`。
4. 联调失败回执与恢复入口。
5. 回归测试 run/recheck/watchdog/reminder。

## Open Questions
- 局部补采触发是否默认关闭，仅在明确“新增资讯”意图时开启？
- “继续执行未完成任务”是否需要持久化 checkpoint 到 DB（建议是）。
- 飞书表单字段上限下，如何平衡自由文本长度与可操作性？
