请使用中文回复、写文档、写代码注释，专业词汇使用英文。

## 核心文档引用（按需读取）
- 需求唯一文档：`docs/PRD.md`
- 架构唯一文档：`docs/architecture.md`
- 学习协作文档：`docs/learning-workflow.md`
- 执行任务时按需读取相关文档，避免重复维护多份同类文档。

## 文档同步维护规则（长期生效）
- 任何需求变更，必须同步更新 `docs/PRD.md`。
- 任何架构/流程变更，必须同步更新 `docs/architecture.md`。
- 任何学习节奏/交付方式变更，必须同步更新 `docs/learning-workflow.md`。
- 禁止新增并行版本文档（例如 `PRD-v*.md`、`architecture-v*.md`）；统一在唯一文档内迭代。

## 代码注释规则（长期生效）
- 所有新增或修改的核心逻辑，必须补充简洁注释，优先解释“为什么这样做”。
- 注释使用中文，专业词汇使用英文；避免逐行翻译式注释。
- 注释覆盖重点：入口流程、状态流转、容错与回退、评分/分类规则、输出结构约束。
- 若发现历史代码可读性不足，应在相关任务中顺带补齐必要注释。

## 提交协作规则（长期生效）
- 当 Agent 认为当前任务阶段适合提交时，必须先询问用户是否同意提交。
- 仅在用户明确同意后，才可执行 `git add` 与 `git commit`。
- `git add` 范围可根据任务需要选择部分文件或全部文件，但应在提交前向用户说明范围。
- 提交信息必须使用中文，并包含清晰且相对详细的变更说明（建议包含背景、主要改动、验证结果）。

## 上下文压缩交接规则（长期生效）
- 当用户表达“将要压缩上下文/准备 context compact/类似意图”时，Agent 必须主动输出一份“压缩交接包”供下一个 Agent 初始化。
- 压缩交接包至少包含：当前目标、已完成事项、未完成事项、关键约束、关键文件路径、验证命令与结果、最近提交信息、下一步建议。
- 交接包内容应简洁、可执行、可直接复制；避免冗长叙述。

## 学习协作约束（长期生效）
- 本仓库默认采用「边做边学」模式，执行任务前请先阅读：`docs/learning-workflow.md`。
- 所有阶段性实现都需要同时交付学习材料（流程图、源码导读、复盘报告）。
- 若仅完成代码而未完成学习材料，视为未完成任务。
- 每次新增学习会话文档时，Agent 需自动填写“3 分钟复盘模板”内容，禁止仅保留空白占位。

## 阶段推进确认规则（长期生效）
- 当任务进入新阶段（例如从方案到 spec、从 spec 到实现、从实现到教学/复盘）时，Agent 必须先向用户提交“下一步方案”并等待确认。
- 在用户未明确确认前，Agent 不得直接进入后续阶段，不得自动连续执行 `spec + 实现 + 教学` 全流程。
- 若用户提出讨论或调整意见，Agent 需先完成对齐并更新方案/文档，再请求进入下一阶段确认。

## LLM 节点开发经验规则（长期生效）
- Prompt 设计优先“少量高质量正例 + 明确 output contract”，避免堆叠大量反例导致模型被干扰。
- Prompt 必须显式要求：仅输出单个 JSON object、禁止 markdown/code fence、禁止解释性文本、输出前自检 `JSON.parse` 可通过。
- LLM 返回解析必须做多形态兼容，至少覆盖：Anthropic 风格 `content[]`、字符串 `content`、`output_text`、OpenAI 风格 `choices.message.content/text`。
- 解析器必须兼容脏格式：` ```json ` 包裹、前后解释文本、转义 JSON（如 `\\\"`）、字段前缀噪音（如 `summary:`）。
- 必须实现“质量闸门（quality gate）”，仅 schema 通过不算成功；至少校验：
  - 占位词（如 `summary`/`推荐`）拦截；
  - `summary` 与 `recommendation` 不能相同；
  - recommendation 需包含建议性 action 语义；
  - 字段前缀噪音拦截。
- 质量问题分级处理：
  - `hard quality error`（占位词、字段串位等）必须重试，重试失败可回退规则摘要；
  - `soft quality error`（如截断句）首轮触发重试，若末轮仍存在则可保留，不强制回退。
- recommendation 自动补全禁止直接复制摘要；应使用“category + importance”模板生成可执行建议。
- Retry 策略必须覆盖：timeout、429/5xx、空内容响应、可修复的 JSON 失败、质量闸门失败。
- 监控与可观测性要求：
  - 记录每次回退与条目失败原因；
  - 输出 success rate 与 fallback reason，便于快速定位是“解析失败”还是“低质量通过”。
- 测试要求：
  - 新增/修改 LLM 节点时，必须补齐单测覆盖“真实坏样本”；
  - 至少包含：`code fence`、半截 JSON、字段串位、占位词、空内容响应、多返回格式提取、重试与回退分支。

<!-- OPENSPEC:START -->
# OpenSpec Instructions

These instructions are for AI assistants working in this project.

Always open `@/openspec/AGENTS.md` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:
- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Keep this managed block so 'openspec update' can refresh the instructions.

<!-- OPENSPEC:END -->
