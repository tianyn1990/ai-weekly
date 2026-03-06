## 1. 规格与设计
- [x] 1.1 明确 Feishu 通知/回调的数据契约与鉴权方式。
- [ ] 1.2 明确审核意见回流指令模型与可执行边界。
- [ ] 1.3 明确打回、修订、再审核的状态流转。
- [x] 1.4 明确审核权限与冲突处理策略（群内任意成员 + last-write-wins）。
- [x] 1.5 明确提醒策略（周一 11:30 单次提醒）与 `reject` 后新建 run 约束。

## 2. 工程实现
- [x] 2.1 接入 Feishu 通知发送器（待审核通知/截止提醒/发布结果）。
- [x] 2.2 接入 Feishu 审核动作回写（approve/request_revision/reject）。
- [ ] 2.3 实现审核意见回流执行（新增/删除候选、主题词/搜索词、来源启停/权重、排序权重调整）。
- [ ] 2.4 打通修订后再审核流程，并保持 watchdog 兼容。
- [x] 2.5 增加 Feishu 不可用时的 CLI fallback 兜底路径。
- [ ] 2.6 回流配置落地到全局配置存储，并在后续 run 生效。
- [ ] 2.7 `reject` 后强制结束当前发布尝试，仅允许新 run 进入下一轮。

## 3. 测试与文档
- [ ] 3.1 补充单测：回调动作解析、last-write-wins、指令回流执行、打回再审核分支、Feishu 不可用 fallback、`reject` 后新 run 约束。
- [x] 3.2 更新 `README.md` 与 `docs/architecture.md`。
- [x] 3.3 新增 M3.2 学习材料（流程图 + 源码导读 + 已填写复盘模板）。
- [x] 3.4 执行并记录验证：`pnpm test`、`pnpm build`、`openspec validate --specs --strict`。
