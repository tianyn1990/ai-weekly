# ai-weekly

基于 LangGraph 的 AI 日报/周报自动化项目骨架。

## 当前状态
- 已完成 `docs/PRD.md`（冻结需求）。
- 已完成 `docs/architecture.md`（系统设计）。
- 已提供可运行的 M2.5 流程：`collect -> normalize -> dedupe -> classify -> rank -> build_outline -> review_outline -> review_final -> publish_or_wait -> build_report`。
- 周报审核支持「持久化指令优先，CLI 参数 fallback」与 pending 周报复检发布。

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

## 测试
```bash
pnpm test
```

## 首版设计取舍
- 首版先用 RSS + 规则分类，优先保证流程稳定与可追溯。
- 先输出 Markdown，后续再接入审核 UI 与自动发布守护进程。
- 模型调用与高级总结暂未接入，作为下一阶段扩展点。

## 下一步（建议）
1. 增加定时守护任务，自动轮询 pending 周报并触发 12:30 发布。
2. 审核指令存储从文件升级到 DB/API，并补并发写保护。
3. 接入 LLM 总结节点（可切换 OpenAI/Anthropic/MiniMax）。
4. 增加 SQLite 持久化与历史检索页。
