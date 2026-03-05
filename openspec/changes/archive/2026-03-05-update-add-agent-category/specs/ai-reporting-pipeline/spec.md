## ADDED Requirements

### Requirement: Classification SHALL include dedicated agent category
系统 SHALL 在分类阶段提供独立 `agent` 分类，用于承载 Agent 工程实践相关内容，并与 `tooling` 分类分离。

#### Scenario: Agent-related content is classified into agent
- **WHEN** 条目标题或摘要包含 `agent` 或 `agentic` 关键词
- **THEN** 条目分类结果为 `agent`
- **AND** 分类统计中包含 `agent` 维度
