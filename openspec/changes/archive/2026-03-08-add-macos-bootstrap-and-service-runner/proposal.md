# Change: 增加 macOS 初始化引导与一键服务运行能力

## Why
当前项目已具备 daemon + Feishu 回调 + Named Tunnel 的能力，但首次接入新电脑仍依赖手工安装与人工配置，且日常运行需要手工打开多个终端，存在易遗漏、可重复性差、运维成本高的问题。

为保证「固定回调地址长期可用」与「边做边学可复制」，需要把初始化流程和服务生命周期管理标准化为可执行命令，并明确稳定模式与临时调试模式的边界。

## What Changes
- 新增 macOS 首次初始化能力（bootstrap）：
  - 自动检查依赖（Node/pnpm/cloudflared/sqlite3 等）
  - 校验关键环境变量与本地文件
  - 引导或生成 `~/.cloudflared/config.yml`（基于模板，凭证文件与密钥不入仓库）
  - 输出可执行修复建议（缺失项、失败项、下一步命令）
- 新增一键服务运行能力（service runner）：
  - 提供 `up/down/restart/status/logs` 命令集
  - 通过 macOS `launchd` 托管 daemon 与 Named Tunnel 双服务
  - 支持幂等安装与重复执行安全（不重复注册、不中断已有健康服务）
- 新增运行模式约束：
  - 固定域名回调（Named Tunnel）作为长期稳定模式
  - `feishu:tunnel`（Quick Tunnel）保留为临时调试模式并给出显式提示
- 新增可观测与验收约束：
  - 提供本地 health 与公网 health 联合检查
  - 明确单机活跃约束（当前阶段不支持多机并发 active daemon）

## Impact
- Affected specs:
  - `ai-reporting-pipeline`（新增初始化与服务托管相关 requirement）
- Affected code (planned):
  - `scripts/`（bootstrap / service 管理脚本）
  - `infra/`（launchd/plist 模板与 cloudflared 模板）
  - `src/cli.ts` 或 `src/tools/*`（若需命令入口聚合）
  - `package.json`（新增运维脚本命令）
  - `README.md` / `docs/architecture.md` / `docs/learning-workflow.md`（文档同步）

## Non-Goals
- 不引入分布式互斥或多节点主备切换（当前仍按单机活跃模型运行）。
- 不在本 change 中实现云端部署（Linux/systemd）方案。
- 不改变现有审核状态机与发布策略语义。
