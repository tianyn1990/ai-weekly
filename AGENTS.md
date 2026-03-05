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
