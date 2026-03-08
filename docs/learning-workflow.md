# 边做边学协作约定（长期生效）

## 1. 目标
本项目采用「边做边学」模式推进：在保证交付进度的同时，把每个阶段的学习素材沉淀为可复用文档与源码导读。

## 2. 固定学习节奏（每次迭代必须执行）
1. **能力点对齐**：本次只聚焦 1 个核心能力点，明确“学什么 + 做什么”。  
2. **源码导读先行**：实现前先给 10 分钟级别导读，说明应先读哪些文件与关键函数。  
3. **实现与运行验证**：完成功能后，提供最小可运行命令与预期输出。  
4. **复盘沉淀**：总结设计取舍、可替代方案、下一步学习建议。

## 3. M1 已完成内容梳理（基线）
### 3.1 已交付
- 冻结需求文档：`docs/PRD.md`
- 系统设计文档：`docs/architecture.md`
- 可运行骨架：Node.js + TypeScript + LangGraph
- 首个工作流：`collect -> normalize -> dedupe -> classify -> rank -> build_report`

### 3.2 关键代码入口（先看这些）
- CLI 入口：`src/cli.ts`
- Graph 定义：`src/pipeline/graph.ts`
- Node 实现：`src/pipeline/nodes.ts`
- RSS 采集：`src/sources/rss-source.ts`
- Markdown 输出：`src/report/markdown.ts`
- 来源配置：`data/sources.yaml`

### 3.3 M1 最小运行方式
```bash
pnpm install
pnpm build
pnpm run:weekly:mock
```

## 4. 后续迭代输出模板（M2+）
每次迭代必须附带以下三类学习材料：
- **流程图**：本次改动在整体 Graph 中的位置与影响。
- **源码导读**：关键模块职责、关键接口、调用链。
- **复盘报告**：为什么这样设计、放弃了什么方案、风险与下一步。

## 5. 学习会话记录
- M2 导读 01（审核断点与自动发布）：`docs/learning-sessions/m2-session-01-review-gate.md`
- M2 复盘 02（审核断点与自动发布实现）：`docs/learning-sessions/m2-session-02-implementation.md`
- M2.5 复盘 01（持久化审核指令 + pending 复检发布）：`docs/learning-sessions/m2.5-session-01-persistent-review.md`
- M3 复盘 01（pending 周报 watchdog 扫描）：`docs/learning-sessions/m3-session-01-watchdog.md`
- M3.1 复盘 01（watchdog 锁 + 重试 + 告警输出）：`docs/learning-sessions/m3.1-session-01-watchdog-reliability.md`
- M3.2 复盘 01（Feishu 审核协同：通知 + 回调 + 提醒）：`docs/learning-sessions/m3.2-session-01-feishu-collaboration.md`
- M3.3 复盘 01（审核意见回流修订 + reject 终止约束）：`docs/learning-sessions/m3.3-session-01-feedback-revision.md`
- M4 复盘 01（审核/配置 DB 化 + Review API + 迁移）：`docs/learning-sessions/m4-session-01-db-api-storage.md`
- M4 复盘 02（Feishu app-only 通知统一 + 点击反馈闭环）：`docs/learning-sessions/m4-session-02-feishu-app-feedback.md`
- M4 复盘 03（Feishu 审核交互重构：阶段主卡 + 单卡更新 + 去噪回执）：`docs/learning-sessions/m4-session-03-feishu-review-ux-guided-flow.md`
- M4 复盘 04（daemon 自动化 + @机器人主动触发 + 自动 Git 同步）：`docs/learning-sessions/m4-session-04-daemon-and-manual-ops.md`
- M4 复盘 05（macOS 初始化引导 + 一键服务托管）：`docs/learning-sessions/m4-session-05-macos-bootstrap-and-service-runner.md`

## 6. 执行优先级约束
- 优先保证「可运行 + 可理解 + 可复盘」三件事同时成立。
- 未提供学习材料的实现，视为不完整交付。

## 7. 当前执行计划（冻结到 M5）
1. M3.2：Feishu 审核协同闭环（通知 + 审核动作输入 + 截止提醒）【已完成】。
2. M3.3：审核意见回流修订（新增/删除候选、主题词/搜索词/权重调整）【已完成】。
3. M4：审核指令与历史数据存储升级（DB/API + 审计 + 并发控制）【已完成】。
4. M4.1：Feishu app-only 通知统一 + 点击反馈闭环【已完成】。
5. M4.2：Feishu 审核交互重构（阶段引导主卡 + 单卡更新 + 去噪回执）【已完成】。
6. M4.3：daemon 自动化 + @机器人主动触发 + 自动 Git 同步【已完成】。
7. M4.4：macOS 初始化引导 + 一键服务托管（launchd + Named Tunnel）【已完成】。
8. M5：LLM 增强（总结优先，逐步扩展到分类/打标/排序辅助）。
9. 分布式互斥：暂缓，待多实例部署再启动。

## 8. M4.3 运行备忘（防遗忘）
- 常驻运行入口：`pnpm run run:daemon`。
- 主动触发入口：飞书群内 @应用机器人并发送“运维/操作卡/ops/触发”关键词。
- 自动同步配置与代理说明以 `README.md` 为准；每次变更同步策略时需同步更新 `README.md` 与 `docs/architecture.md`。

## 9. M4.4 运行备忘（防遗忘）
- 新机初始化入口：`pnpm run setup:macos`（先修复 FAIL 项，再启动服务）。
- 一键托管入口：
  - 启动：`pnpm run services:up`
  - 状态：`pnpm run services:status`
  - 日志：`pnpm run services:logs`
  - 停止：`pnpm run services:down`
- Quick Tunnel 仅用于临时联调：`pnpm run feishu:tunnel`，长期模式统一使用 Named Tunnel + `services:up`。
