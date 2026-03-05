# ai-weekly

基于 LangGraph 的 AI 日报/周报自动化项目骨架。

## 当前状态
- 已完成 `docs/PRD.md`（冻结需求）。
- 已完成 `docs/architecture.md`（系统设计）。
- 已提供可运行的 M3.1 流程：`collect -> normalize -> dedupe -> classify -> rank -> build_outline -> review_outline -> review_final -> publish_or_wait -> build_report`。
- 周报审核支持「持久化指令优先，CLI 参数 fallback」、pending 周报复检发布、watchdog 守护扫描（含锁与重试）。
- 分布式互斥暂缓，当前以单机定时任务为部署基线。

## 环境要求
- Node.js >= 20
- pnpm >= 9

## 快速开始
```bash
pnpm install
pnpm run:weekly:mock
```

执行后会在 `outputs/review/weekly/` 生成：
- `YYYY-MM-DD.md`：待审核报告
- `YYYY-MM-DD.json`：结构化运行结果（含 review/publish 状态）

满足发布条件时会额外写入 `outputs/published/weekly/`。

## 运行真实来源
```bash
pnpm run:daily
pnpm run:weekly
```

可选参数：
```bash
tsx src/cli.ts run --mode weekly --source-config data/sources.yaml --source-limit 6 --timezone Asia/Shanghai
```

审核相关参数：
```bash
# 周报大纲+终稿审核通过，立即发布
tsx src/cli.ts run --mode weekly --mock --approve-outline --approve-final

# 指定生成时间（用于回放“周一 12:30 超时自动发布”场景）
tsx src/cli.ts run --mode weekly --mock --generated-at 2026-03-09T05:00:00.000Z
```

持久化审核指令（默认目录：`outputs/review-instructions/`）：
```bash
# 文件路径：outputs/review-instructions/weekly/2026-03-09.json
{
  "mode": "weekly",
  "reportDate": "2026-03-09",
  "instructions": [
    { "stage": "outline_review", "approved": true, "decidedAt": "2026-03-09T01:00:00.000Z" },
    { "stage": "final_review", "approved": true, "decidedAt": "2026-03-09T02:00:00.000Z" }
  ]
}
```

pending 周报复检发布（不重跑采集链路）：
```bash
tsx src/cli.ts run --mode weekly --recheck-pending --report-date 2026-03-05
```

pending 周报守护扫描（批量巡检）：
```bash
# dry-run：仅输出将发布/跳过结果，不写入产物
tsx src/cli.ts run --mode weekly --watch-pending-weekly --dry-run

# 实际执行：对符合条件的 pending 周报执行复检并发布
tsx src/cli.ts run --mode weekly --watch-pending-weekly

# 自定义重试与锁文件
tsx src/cli.ts run --mode weekly --watch-pending-weekly --watch-max-retries 3 --watch-retry-delay-ms 500 --watch-lock-file outputs/watchdog/weekly.lock

# 锁文件异常残留时可强制清锁（谨慎）
tsx src/cli.ts run --mode weekly --watch-pending-weekly --watch-force-unlock
```

推荐 cron（北京时间）：
```bash
# 每周一 12:31 执行一次 watchdog
31 12 * * 1 cd /path/to/ai-weekly && pnpm run:weekly:watch
```

## 测试
```bash
pnpm test
```

## 首版设计取舍
- 首版先用 RSS + 规则分类，优先保证流程稳定与可追溯。
- 先输出 Markdown，后续再接入审核 UI 与自动发布守护进程。
- 模型调用与高级总结暂未接入，作为下一阶段扩展点。

## 下一步（建议）
1. 接入 Feishu 审核协同：通知、审核动作输入、截止提醒。
2. 增加“审核意见回流修订”：新增/删除候选、主题词/搜索词/权重调整。
3. 审核指令存储从文件升级到 DB/API，并补并发写保护。
4. 接入 LLM 总结节点，并逐步扩展到分类/打标/排序辅助。
