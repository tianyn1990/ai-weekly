## 1. Spec & Design
- [ ] 1.1 确认审核状态模型（pending/approved/timeout_published）。
- [ ] 1.2 明确周报与日报的分支行为边界。
- [ ] 1.3 评审 proposal/design 并获得批准后开始实现。

## 2. Implementation
- [ ] 2.1 扩展 `ReportState`，加入审核与发布状态字段。
- [ ] 2.2 在 Graph 中加入 review 断点节点与 publish 决策节点。
- [ ] 2.3 实现自动发布判定（周一 12:30 北京时间）。
- [ ] 2.4 输出审核与发布状态到 markdown/json 产物。
- [ ] 2.5 同步更新 `docs/architecture.md`。

## 3. Validation
- [ ] 3.1 运行 `openspec validate add-weekly-review-gate-and-auto-publish --strict`。
- [ ] 3.2 运行 `pnpm build`。
- [ ] 3.3 运行 `pnpm run:weekly:mock` 并验证状态字段。
