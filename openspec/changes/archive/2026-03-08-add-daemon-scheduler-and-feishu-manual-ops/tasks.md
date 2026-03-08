## 1. 规格与方案
- [x] 1.1 明确 daemon 运行模式与调度窗口（含补偿扫描规则）。
- [x] 1.2 明确 Feishu 主动触发运维卡的动作集合与回执规范。
- [x] 1.3 明确 Git 自动同步范围、忽略范围与代理配置策略。

## 2. 核心实现（后台自动化）
- [x] 2.1 新增 daemon 入口，统一启动 scheduler/callback/worker。
- [x] 2.2 实现 scheduler 时间触发：daily/weekly/reminder/watchdog。
- [x] 2.3 实现 daemon 启动后的补偿扫描机制。
- [x] 2.4 保留并验证 CLI fallback 命令链路可用。

## 3. 核心实现（Feishu 主动触发）
- [x] 3.1 支持 @机器人事件识别并返回运维操作卡。
- [x] 3.2 实现操作卡按钮 callback -> operation job 入队。
- [x] 3.3 实现 worker 异步执行与结果回执（success/failed）。
- [x] 3.4 对重复点击和重复事件执行幂等去重。

## 4. 核心实现（自动 Git 同步）
- [x] 4.1 调整 `.gitignore`，纳入 review/published/review-instructions/runtime-config。
- [x] 4.2 实现受控目录变更检测 + 自动 add/commit/push。
- [x] 4.3 增加 push 代理支持：`GIT_PUSH_HTTP_PROXY/GIT_PUSH_HTTPS_PROXY/GIT_PUSH_NO_PROXY`。
- [ ] 4.4 失败重试与审计日志（不阻断主业务流程）。

## 5. 数据与接口
- [x] 5.1 新增 `operation_jobs` 数据模型与持久化实现（DB 优先）。
- [x] 5.2 新增任务状态查询接口（用于飞书回执与调试）。
- [x] 5.3 将回调后的自动 recheck 改为入队执行，避免同步长耗时。

## 6. 测试与验证
- [x] 6.1 单测：scheduler 触发规则、补偿扫描规则、任务去重逻辑。
- [ ] 6.2 集成测试：@机器人 -> 操作卡 -> 入队 -> 执行 -> 回执闭环。
- [ ] 6.3 集成测试：审核动作 callback 后自动 recheck 并更新状态。
- [x] 6.4 集成测试：自动 git 同步在有变更时 commit/push、无变更时跳过。
- [x] 6.5 回归验证：`pnpm test`、`pnpm build`。
- [x] 6.6 OpenSpec 校验：`openspec validate add-daemon-scheduler-and-feishu-manual-ops --strict`。

## 7. 文档与学习交付
- [x] 7.1 更新 `docs/PRD.md`（M4.3 自动化与主动触发验收项）。
- [x] 7.2 更新 `docs/architecture.md`（daemon 架构、任务队列、Git 同步链路）。
- [x] 7.3 更新 `README.md`（daemon 启动、主动触发、自动同步配置）。
- [x] 7.4 更新 `.env.local.example`（代理变量说明与示例）。
- [x] 7.5 更新 `docs/learning-workflow.md` 并新增学习会话文档（含 3 分钟复盘模板）。
