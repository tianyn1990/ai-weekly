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

## 6. 执行优先级约束
- 优先保证「可运行 + 可理解 + 可复盘」三件事同时成立。
- 未提供学习材料的实现，视为不完整交付。
