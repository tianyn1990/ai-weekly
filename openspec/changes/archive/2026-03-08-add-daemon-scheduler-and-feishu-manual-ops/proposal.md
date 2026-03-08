# Change: 后台常驻自动化 + Feishu 主动触发运维卡 + Git 自动同步（M4.3）

## Why
当前系统已经具备完整的审核闭环与飞书协同能力，但执行方式仍以手动 CLI 为主，存在三个实际摩擦：
- 日常运行依赖人工执行 `run/recheck/watchdog`，与“自动化周报系统”的目标不一致；
- 审核人在飞书中点击动作后，还需要运维手动执行 `recheck`，协作链路存在断点；
- 飞书链接虽然可点击，但若产物未同步到 GitHub，审核人仍无法查看真实内容。

此外，团队希望支持“主动触发”模式：在群里 @应用机器人即可收到操作卡，通过按钮触发常见流程，用于测试、排障和临时补偿。

## What Changes
- 新增 **daemon 常驻运行模式**，统一托管调度与协同链路：
  - 周期任务调度（日报、周报、周一 11:30 提醒、周一 12:31 watchdog）；
  - Feishu callback server；
  - 自动 recheck 触发与任务队列消费。
- 新增 **Feishu 主动触发运维卡**：
  - 支持在群里 @应用机器人后返回“运维操作卡”；
  - 卡片按钮支持触发 `run/recheck/watchdog/reminder/status` 等常见动作；
  - 长任务采用“入队 + 异步执行 + 结果回执”，避免回调超时。
- 新增 **Git 自动同步发布能力**：
  - 对待审核、已发布及关键状态文件自动 `add/commit/push`；
  - 仅在有变更时提交，避免无效 commit；
  - 支持 push 阶段可选代理环境变量注入（适配本地网络环境）。
- 保留 **手动 CLI 命令** 作为 fallback，不破坏现有学习与排障路径。

## Impact
- Affected specs:
  - `ai-reporting-pipeline`
- Affected code (planned):
  - `src/cli.ts`
  - `src/review/feishu.ts`
  - `src/pipeline/recheck.ts`
  - `src/pipeline/watchdog.ts`
  - `src/daemon/*`（新增）
  - `src/git/*`（新增）
  - `scripts/*`（新增 daemon 启动与健康检查脚本）
  - `.env.local.example`
  - `.gitignore`
  - `README.md`
  - `docs/PRD.md`
  - `docs/architecture.md`
  - `docs/learning-workflow.md`
