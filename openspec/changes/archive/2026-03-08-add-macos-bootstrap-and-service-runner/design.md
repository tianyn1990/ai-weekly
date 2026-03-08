## Context
项目已落地 M4.3（daemon 常驻 + Feishu 主动触发 + 自动 recheck + 自动 git 同步），并已采用 Named Tunnel 固定回调域名完成联调。

当前痛点：
1. 新电脑首次接入流程分散，容易漏项（cloudflared 登录、tunnel 凭证、回调配置、环境变量）。
2. 日常运行依赖手工开两个终端（daemon + tunnel），稳定性和可运维性不足。
3. Quick Tunnel 与 Named Tunnel 模式边界未工具化，误用后会出现“URL 变化导致飞书后台需重配”。

## Goals / Non-Goals
- Goals:
  - 提供可重复的一次性初始化命令，降低新机器接入门槛。
  - 提供一键服务生命周期管理命令，消除手工双终端操作。
  - 固化稳定模式（Named Tunnel）与调试模式（Quick Tunnel）的行为边界。
  - 增强本地可观测性（status/health/logs），便于排障。
- Non-Goals:
  - 不解决多机器并发 active daemon 的分布式互斥问题。
  - 不扩展到 Linux/systemd 或容器编排。
  - 不改动报告内容生成、审核状态机、发布策略业务逻辑。

## Decisions

### Decision 1: 采用 `launchd` 作为 macOS 服务托管层
- 方案：使用 `~/Library/LaunchAgents` 注册两个服务：
  - `com.ai-weekly.daemon`
  - `com.ai-weekly.tunnel`
- 原因：
  - 原生能力，无额外第三方守护依赖。
  - 支持 `RunAtLoad`、`KeepAlive`、标准日志落盘。
  - 与用户会话绑定，配置成本低，适合当前本地部署形态。

### Decision 2: 运行态配置放在本机，仓库仅存模板
- 方案：
  - 运行态：`~/.cloudflared/config.yml`、`~/.cloudflared/<tunnel-id>.json`
  - 仓库：`infra/cloudflared/config.example.yml`、launchd plist 模板
- 原因：
  - 避免凭证与敏感路径进入仓库。
  - 兼容多机器本地路径差异。

### Decision 3: 增加 bootstrap 与 service runner 两层命令
- bootstrap（一次性/低频）：检查并补齐环境。
- service runner（日常/高频）：管理服务生命周期。
- 原因：把“首次接入复杂性”和“日常运行复杂性”解耦，降低学习和运维负担。

### Decision 4: 模式显式化
- Stable 模式：Named Tunnel + 固定回调域名（推荐）。
- Debug 模式：Quick Tunnel（保留）。
- 通过命令输出明确提示，避免误把 Debug 模式当长期运行。

## Architecture Sketch

```text
pnpm run setup:macos
  -> 依赖检查
  -> env 检查
  -> cloudflared tunnel / credentials 检查
  -> 渲染本机 config
  -> 输出修复建议与下一步命令

pnpm run up
  -> 安装/更新 LaunchAgents (daemon + tunnel)
  -> launchctl bootstrap / kickstart
  -> health 检查 (local + public)

pnpm run status
  -> launchctl print
  -> /health 探测
  -> 汇总为可读状态
```

## Risks / Trade-offs
- 风险：`LaunchAgents` 只在用户登录会话运行，注销后服务停止。
  - 缓解：文档中明确运行边界；若需 24x7，再规划 Linux/systemd 方案。
- 风险：新机器可能未安装 cloudflared 或未 login，导致 tunnel 启动失败。
  - 缓解：bootstrap 前置检查并给出明确修复命令。
- 风险：用户在多台机器同时执行 `up`，会产生重复调度。
  - 缓解：status 与文档增加“单机活跃”警示；本阶段不做自动仲裁。

## Migration Plan
1. 增加模板与脚本，不影响现有 `feishu:dev` / `run:daemon` 手工流程。
2. 引导用户先执行 bootstrap，再启用 `up`。
3. 在文档中标记 Quick Tunnel 为调试模式，并给出迁移到 stable 模式步骤。
4. 完成验证后，作为默认推荐运行方式。

## Open Questions
- 是否需要在 `status` 输出中加入“远端回调 URL 与飞书后台配置一致性”自动检查（可选后续增强）。
- 是否需要增加 `doctor` 命令统一诊断（本 change 可做最小版本，后续再扩展）。
