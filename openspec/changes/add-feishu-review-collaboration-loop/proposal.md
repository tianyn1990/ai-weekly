# Change: 增加 Feishu 审核协同与审核意见回流修订能力

## Why
当前系统已具备审核状态机与 watchdog 自动发布能力，但人工协作仍偏技术向（CLI/文件）。在团队使用场景下，需要将“通知、审核动作输入、审核意见回流”放到统一协作入口，降低操作门槛并提高审稿效率。

## What Changes
- 接入 Feishu 作为审核协同入口：周报生成通知、审核截止提醒、发布结果回执。
- 支持通过 Feishu 回写审核动作：`approve_outline`、`approve_final`、`request_revision`、`reject`。
- 增加审核意见回流修订：支持在原有内容基础上执行新增/删除候选、主题词与搜索词调整、来源开关/权重调整、排序权重调整。
- 将“打回”定义为修订分支，不等于取消流程；修订完成后重新进入终稿审核。
- 审核权限模型：群内任意成员可审核，多人并发操作采用最后一次有效（last-write-wins）。
- 截止提醒策略：每周一 11:30（Asia/Shanghai）发送一次提醒。
- 回流作用域：来源/排序权重与来源开关调整写入全局配置并影响后续周期。
- `reject` 语义：终止当前发布尝试，后续必须新建一次 run 才能再次进入发布流程。
- 保留 CLI 审核作为 fallback，避免协同链路故障影响发布兜底。

## Impact
- Affected specs: `ai-reporting-pipeline`
- Affected code:
  - `src/cli.ts`
  - `src/pipeline/nodes.ts`
  - `src/pipeline/recheck.ts`
  - `src/pipeline/watchdog.ts`
  - `src/review/*`
  - `tests/*`
  - `README.md`
  - `docs/architecture.md`
  - `docs/learning-workflow.md`
