# project-document-governance Specification

## Purpose
定义项目文档治理规则，确保 PRD、架构与学习协作文档始终保持单一来源，并在需求、流程或学习节奏变更时同步更新，避免并行文档造成语义漂移和执行偏差。
## Requirements
### Requirement: Project SHALL maintain single canonical PRD and architecture documents
项目 SHALL 仅维护一份需求文档与一份架构文档作为唯一来源，避免并行版本漂移。

#### Scenario: Canonical docs are discoverable from AGENTS
- **WHEN** Agent 开始处理任务
- **THEN** 可从 `AGENTS.md` 直接定位唯一需求文档 `docs/PRD.md`
- **AND** 可从 `AGENTS.md` 直接定位唯一架构文档 `docs/architecture.md`

### Requirement: Project SHALL maintain a canonical learning workflow document
项目 SHALL 维护唯一学习协作文档，约束“边做边学”交付节奏。

#### Scenario: Learning workflow is mandatory
- **WHEN** Agent 执行阶段性实现
- **THEN** 需遵循 `docs/learning-workflow.md` 约定
- **AND** 交付中包含流程图、源码导读、复盘报告

### Requirement: Relevant changes SHALL synchronize canonical documentation updates
项目 SHALL 在需求、架构、学习协作规则变更时，同步更新对应唯一文档。

#### Scenario: Requirement change is introduced
- **WHEN** 功能需求发生变化
- **THEN** `docs/PRD.md` 必须同步更新

#### Scenario: Architecture or workflow change is introduced
- **WHEN** 系统架构或处理流程发生变化
- **THEN** `docs/architecture.md` 必须同步更新

#### Scenario: Learning cadence change is introduced
- **WHEN** 学习节奏或学习交付方式发生变化
- **THEN** `docs/learning-workflow.md` 必须同步更新
