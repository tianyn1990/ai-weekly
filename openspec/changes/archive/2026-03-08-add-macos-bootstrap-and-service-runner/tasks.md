## 1. 方案与规范
- [x] 1.1 新增 bootstrap + service runner 的命令约定与参数约束（含 stable/debug 模式说明）。
- [x] 1.2 明确本地运行态配置与仓库模板边界（凭证不入仓库）。

## 2. 初始化能力（bootstrap）
- [x] 2.1 增加 `setup:macos` 命令入口与脚本，实现依赖检查（Node/pnpm/cloudflared/sqlite3）。
- [x] 2.2 实现环境变量与关键文件检查（`.env.local`、`FEISHU_*`、`REVIEW_CHAT_ID`）。
- [x] 2.3 实现 cloudflared 资产检查（tunnel 是否存在、credentials 文件是否存在）。
- [x] 2.4 增加 `~/.cloudflared/config.yml` 渲染/校验逻辑（基于模板、幂等更新）。
- [x] 2.5 输出结构化检查结果与下一步修复命令（可复制执行）。

## 3. 一键服务运行能力（service runner）
- [x] 3.1 增加 `up/down/restart/status/logs` 命令入口与脚本。
- [x] 3.2 增加 launchd 模板（daemon + tunnel）并实现 install/update 幂等逻辑。
- [x] 3.3 在 `up` 后执行本地 health 与公网 health 联合检查，并输出结果摘要。
- [x] 3.4 在 `status` 中输出服务状态、PID、最近错误（如可获取）。

## 4. 回退与兼容
- [x] 4.1 保留 `feishu:tunnel` 调试模式，不破坏既有联调流程。
- [x] 4.2 在调试模式命令输出中增加“URL 可能变化、非长期模式”的显式提示。

## 5. 测试
- [x] 5.1 为配置渲染与校验逻辑补充单元测试。
- [x] 5.2 为 service 管理命令与参数解析补充单元测试。
- [x] 5.3 补充关键脚本的集成验证脚本或可复现实操步骤。

## 6. 文档与学习材料
- [x] 6.1 更新 `README.md`（新机初始化、一键启动、常见故障）。
- [x] 6.2 更新 `docs/architecture.md`（运维启动层与模式边界）。
- [x] 6.3 更新 `docs/learning-workflow.md` 并新增本阶段学习会话文档（含 3 分钟复盘模板）。

## 7. 验证与收口
- [x] 7.1 执行 `pnpm test` 与 `pnpm build` 验证。
- [x] 7.2 执行 `openspec validate add-macos-bootstrap-and-service-runner --strict`。
- [x] 7.3 实现阶段已完成并完成文档同步收口。
