## 1. 运维动作分流
- [x] 1.1 将 `query_status` 改为回调直读路径，不创建 operation job。
- [x] 1.2 保持执行类动作（run/recheck/watchdog/reminder）为异步入队执行。
- [x] 1.3 为分流路径补齐审计事件，保证 trace 可追溯。

## 2. 阶段通知与失败通知
- [x] 2.1 为 operation job 增加生命周期状态（queued/started/progress/succeeded/failed/cancelled）。
- [x] 2.2 在关键阶段发送飞书通知，控制通知粒度与去重。
- [x] 2.3 统一失败分类并在失败回执中输出原因摘要。
- [x] 2.4 当发现同类任务正在运行时，发送冲突控制通知（中止/中止并重启）。

## 3. 中止能力
- [x] 3.1 在飞书运维卡新增“中止本次运行”按钮。
- [x] 3.2 数据层支持 cancel 请求字段与状态流转。
- [x] 3.3 worker 在阶段边界检查 cancel 标记并安全退出。
- [x] 3.4 重复 cancel 与终态竞态场景做幂等保护。
- [x] 3.5 执行类长任务改为子进程执行，支持硬中止（SIGTERM/SIGKILL）并立即释放 dedupe 占位。

## 4. 测试与文档
- [x] 4.1 单测：query_status 在队列堵塞时仍可立即返回。
- [x] 4.2 单测：阶段通知/失败通知/取消回执行为正确。
- [x] 4.3 单测：cancel 竞态与重复点击幂等。
- [x] 4.4 更新 `docs/PRD.md`、`docs/architecture.md`、`docs/learning-workflow.md`（如流程或协作方式变化）。
