## 1. 规格与设计
- [x] 1.1 定义 watchdog 互斥锁行为（获取、释放、冲突处理）。
- [x] 1.2 定义重试策略（最大次数、重试间隔、失败终止条件）。
- [x] 1.3 定义告警与 summary 输出结构。

## 2. 工程实现
- [x] 2.1 在 watchdog 入口接入 lock 文件互斥机制。
- [x] 2.2 在复检执行中增加重试机制与失败原因累积。
- [x] 2.3 将 watchdog summary 持久化到输出目录并补 alert 日志。

## 3. 测试与文档
- [x] 3.1 新增/更新单测：锁冲突、重试成功/失败、summary 输出。
- [x] 3.2 更新 `README.md` 与 `docs/architecture.md`。
- [x] 3.3 新增 M3.1 学习材料（流程图 + 源码导读 + 已填写复盘模板）。
- [x] 3.4 执行并记录验证：`pnpm test`、`pnpm build`、`openspec validate --specs --strict`。
