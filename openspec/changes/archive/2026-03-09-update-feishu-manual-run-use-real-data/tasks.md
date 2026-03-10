## 1. Implementation
- [x] 1.1 修改飞书运维卡文案，明确“生成周报（真实）”。
- [x] 1.2 修改飞书触发 run 操作 payload，默认 `mock=false`。
- [x] 1.3 补充或更新单元测试，覆盖运维卡按钮文案与行为。

## 2. Documentation
- [x] 2.1 更新 `README.md` 的飞书自测步骤描述。
- [x] 2.2 更新 `docs/architecture.md` 的主动触发说明。

## 3. Validation
- [x] 3.1 执行 `pnpm test`。
- [x] 3.2 执行 `pnpm build`。
- [x] 3.3 执行 `openspec validate update-feishu-manual-run-use-real-data --strict`。
- [x] 3.4 归档 change（不提交）。
