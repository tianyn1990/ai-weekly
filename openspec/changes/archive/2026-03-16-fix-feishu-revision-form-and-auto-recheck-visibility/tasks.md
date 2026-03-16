## 1. 飞书修订入口改造
- [x] 1.1 将主审核卡“要求修订”改为“打开修订表单”入口，不再仅依赖固定 reason。
- [x] 1.2 新增修订表单字段映射：`revisionRequest`（必填）、`revisionScope`、`revisionIntent`、`continueFromCheckpoint`。
- [x] 1.3 回调解析层优先消费 `feedback`，并保持 reason-only 历史回调兼容。

## 2. 自动 recheck 可见性补齐
- [x] 2.1 为 `feishu_callback_auto` 任务补齐生命周期通知（queued/started/progress/success/failed/cancelled）。
- [x] 2.2 统一采用单任务进度卡 upsert，文本通知仅保留关键里程碑，避免刷屏。
- [x] 2.3 `query_status` 可返回自动修订任务运行态（jobId/阶段/耗时/最近错误摘要）。

## 3. 修订失败恢复闭环
- [x] 3.1 在修订失败/中断时发送恢复卡，包含失败分类与失败摘要。
- [x] 3.2 恢复卡支持“编辑后重试 / 继续执行 / 直接通过并发布”动作。
- [x] 3.3 `continueFromCheckpoint` 路径联调，确保可复用历史 checkpoint。

## 4. 卡住保护与超时治理
- [x] 4.1 为自动 recheck 子进程增加 wall-clock timeout 配置与默认值。
- [x] 4.2 超时终止后写入明确失败分类（`subprocess_timeout`）并发送失败回执。
- [x] 4.3 确认超时中断与手工中止（cancel）幂等兼容。

## 5. 测试与文档
- [x] 5.1 单测：修订表单 payload 解析与兼容分支（含 reason-only 回退）。
- [x] 5.2 单测：自动 recheck 通知路径与去重/节流行为。
- [x] 5.3 单测：失败恢复卡动作分支与 checkpoint 继续执行。
- [x] 5.4 单测：recheck timeout 分支与失败分类输出。
- [x] 5.5 更新 `docs/PRD.md`、`docs/architecture.md`、`docs/learning-workflow.md`。
- [x] 5.6 新增学习会话文档并填写完整 3 分钟复盘模板。
