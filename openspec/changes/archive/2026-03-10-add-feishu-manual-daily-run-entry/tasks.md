## 1. Implementation
- [x] 1.1 在飞书运维操作卡新增“生成日报（真实）”按钮。
- [x] 1.2 确认按钮 payload 使用既有 `run_daily` operation 类型并复用异步队列流程。
- [x] 1.3 补充/更新单元测试，覆盖按钮存在性与动作集合。

## 2. Documentation
- [x] 2.1 更新 `README.md` 中主动触发按钮清单与说明。
- [x] 2.2 更新 `docs/PRD.md` 与 `docs/architecture.md` 对运维流程的描述。
- [x] 2.3 新增学习会话文档并填写 3 分钟复盘模板。

## 3. Validation
- [x] 3.1 执行 `pnpm test`。
- [x] 3.2 执行 `pnpm build`。
- [x] 3.3 执行 `openspec validate add-feishu-manual-daily-run-entry --strict`。
