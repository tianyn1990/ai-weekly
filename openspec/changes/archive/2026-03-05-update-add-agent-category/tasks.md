## 1. Implementation
- [x] 1.1 新增 `ItemCategory` 中的 `agent` 类型并补齐分类统计结构。
- [x] 1.2 调整分类规则，将 `agent/agentic` 优先归类为 `agent`。
- [x] 1.3 同步更新架构文档分类说明。

## 2. Spec
- [x] 2.1 更新 `ai-reporting-pipeline` 的分类 requirement/scenario。
- [x] 2.2 运行 `openspec validate update-add-agent-category --strict` 并通过。
- [x] 2.3 归档 change 并验证 specs 状态。

## 3. Verification
- [x] 3.1 运行 `pnpm build`。
- [x] 3.2 运行 `pnpm run:weekly:mock`。
