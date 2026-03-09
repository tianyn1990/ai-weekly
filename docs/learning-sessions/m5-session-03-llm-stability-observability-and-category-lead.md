# M5 学习复盘 03：LLM 稳定性加固 + 运行诊断 + 分类导读

## 1. 本次实现了什么
- 在 `llm_summarize` 阶段新增窗口型自适应降载：
  - 短窗口 `missing_content` 比例异常时触发临时降载。
  - 优先重试失败条目，降低错误扩散。
  - 窗口成功率恢复后自动恢复并发。
- 扩展 run 级诊断元数据：
  - `llmSummaryMeta.adaptiveDegradeStats`。
  - warning 输出新增降载/恢复可读摘要。
- 报告新增“分类导读”区块：
  - 按主要分类生成 1 句导读。
  - 失败时自动回退模板导读，不阻断主流程。
- 并发默认值对齐：
  - 全局与节点并发默认值统一为 `2`。

## 2. 流程图（M5.3）
```text
publish_or_wait
  -> llm_summarize
      -> item-wise summary (MiniMax)
      -> adaptive window diagnose
      -> (if needed) degrade concurrency + retry failed items
      -> ranking assist fusion
      -> lead summary
      -> category leads
      -> on partial failure: item fallback
      -> on severe failure: global fallback
  -> build_report
```

## 3. 源码导读（建议顺序）
1. `src/llm/summary.ts`
- `buildLlmSummary`：主流程入口，含窗口诊断、降载触发与恢复。
- `computeAdaptiveWindowStats` / `shouldTriggerAdaptiveDegrade`：降载判定核心。
- `buildCategoryLeadSummariesWithFallback`：分类导读生成与模板回退。

2. `src/core/types.ts` + `src/core/review-artifact.ts`
- 新字段：`CategoryLeadSummary`、`LlmAdaptiveDegradeStats`。
- artifact/schema 兼容：历史产物缺失新字段时可读。

3. `src/report/markdown.ts`
- 新增 `分类导读` 渲染区块，保持“导读 -> 正文”阅读顺序。

4. `src/cli.ts` + `src/pipeline/nodes.ts`
- 默认并发值统一为 `2`。
- 新字段在落盘与 recheck 读取链路中的贯通。

## 4. 运行验证
- `pnpm test`：通过（25 files / 142 tests）。
- `pnpm build`：通过。
- `openspec validate add-m5-3-llm-stability-observability-and-category-lead --strict`：通过。

## 5. 设计取舍
- 采用“窗口自适应降载”而不是直接固定串行：
  - 目标是在稳定性和吞吐之间动态平衡。
- 分类导读保留模板回退：
  - 保障报告产出稳定，不让可读性增强功能反向阻断主流程。
- 保留既有条目级与全局回退策略：
  - 稳定性优先，确保审核/发布状态机不受影响。

## 6. 3 分钟复盘模板（已填写）
```text
【1】本轮目标（30s）
- 我本轮要验证的能力点是：在 MiniMax 真实运行抖动下，通过自适应降载降低 missing_content 扩散，并提升可诊断性。
- 我完成后的可见结果是：报告新增分类导读，产物新增 adaptiveDegradeStats，warning 可直接定位降载触发/恢复。

【2】关键实现（60s）
- 我改了哪 3 个核心文件：
  1) src/llm/summary.ts
  2) src/core/types.ts + src/core/review-artifact.ts
  3) src/report/markdown.ts
- 每个文件“为什么要改”：
  - summary.ts：集中实现降载策略、恢复策略与分类导读生成。
  - types/review-artifact：保证诊断信息可落盘、可回放、可兼容历史数据。
  - markdown.ts：把导读能力变成用户可见输出，提升审核可读性。

【3】运行验证（45s）
- 我执行的命令：
  - pnpm test
  - pnpm build
  - openspec validate add-m5-3-llm-stability-observability-and-category-lead --strict
- 结果是否符合预期：符合。
- 有无 warning/边界场景：
  - 分类导读 LLM 失败时自动回退模板，不影响主流程。

【4】设计取舍（30s）
- 我放弃了哪个方案，原因是：放弃“全程固定并发=1”，因为吞吐损失过大且无法利用稳定窗口。
- 当前实现的风险点是：窗口阈值仍需结合真实流量持续校准。

【5】下一步（15s）
- 我下一轮最小可执行目标是：基于真实 weekly 连续运行，观察 adaptive trigger/recover 比例并微调阈值。
```
