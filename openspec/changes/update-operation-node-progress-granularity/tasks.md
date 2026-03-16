## 1. 进度事件与配置
- [x] 1.1 定义 operation 进度事件结构（lifecycle + pipeline node）与序列化协议。
- [x] 1.2 新增通知粒度相关运行配置（`off/milestone/verbose`、节流、更新上限、进度卡开关）。
- [x] 1.3 约束默认值：默认 `milestone`，避免新版本上线即刷屏。

## 2. 执行链路埋点
- [x] 2.1 在 run/recheck/watchdog 子进程链路增加结构化进度输出协议。
- [x] 2.2 在主 worker 解析子进程进度事件，并转换为统一通知事件。
- [x] 2.3 非 run 类任务补齐 operation phase 进度事件（无 nodeKey 也可观测）。

## 3. 飞书通知与降噪
- [x] 3.1 新增“单任务进度卡”构建与 `jobId -> messageId` 维护逻辑。
- [x] 3.2 实现进度卡 PATCH 更新（失败时补发并重建映射）。
- [x] 3.3 实现通知去重、时间节流、单任务更新上限。
- [x] 3.4 保持生命周期文本回执（queued/started/终态）与冲突控制卡兼容。

## 4. 状态查询增强
- [x] 4.1 `query_status` 返回运行中任务的当前节点、阶段与耗时信息。
- [x] 4.2 当无运行中任务时保持兼容输出，不破坏现有消费方。

## 5. 测试与文档
- [x] 5.1 单测：粒度配置 `off/milestone/verbose` 行为差异。
- [x] 5.2 单测：进度事件去重/节流/上限控制。
- [x] 5.3 单测：进度卡 PATCH 失败降级补发。
- [x] 5.4 单测：`query_status` 能返回当前节点与耗时。
- [x] 5.5 更新 `docs/PRD.md`、`docs/architecture.md`、`docs/learning-workflow.md`（如协作流程变更）。
- [x] 5.6 新增学习会话文档并完整填写“3 分钟复盘模板”。
