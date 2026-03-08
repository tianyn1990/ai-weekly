# M4 学习复盘 05：macOS 初始化引导 + 一键服务托管

## 1. 本次实现了什么
- 新增 `src/tools/service-ops.ts`，提供 `setup-macos | up | down | restart | status | logs` 子命令。
- 新增本机初始化检查能力：
  - 依赖检查（Node/pnpm/cloudflared/sqlite3）
  - 环境变量检查（Feishu 凭证与回调参数）
  - tunnel 资产检查（`cloudflared tunnel info`）
  - cloudflared config 存在性与关键字段校验（hostname/service/credentials）
- 新增 macOS `launchd` 托管能力：
  - 统一托管 `com.ai-weekly.daemon` 与 `com.ai-weekly.tunnel`
  - 支持一键启动、停止、重启、状态检查与日志查看
- 保留 `feishu:tunnel` 作为临时联调模式，并增加“URL 非稳定”显式提示。

## 2. 流程图（M4.4）
```text
setup:macos
  -> check binary/env/tunnel/config
  -> optional generate cloudflared config
  -> print fix hints + next command

services:up
  -> write launchd plist
  -> bootstrap + kickstart daemon/tunnel
  -> status health summary (local + public)
```

## 3. 源码导读（建议阅读顺序）
1. `src/tools/service-ops.ts`
- 看 `collectSetupChecks`：理解初始化阶段如何把“隐性环境问题”转成可执行修复项。
- 看 `runUp/runDown/runRestart`：理解 launchd 幂等托管逻辑。
- 看 `runStatus`：理解本地 health 与公网 health 的联合探测。

2. `tests/service-ops.test.ts`
- 看参数解析与配置渲染测试：理解命令默认值、环境覆盖和配置摘要提取逻辑。

3. `infra/cloudflared/config.example.yml`
- 看固定域名配置模板：理解 stable callback 模式的运行时形态。

4. `infra/launchd/*.plist.tmpl`
- 看双服务模板：理解 daemon 与 tunnel 分离托管的原因（可观测、可重启、可定位）。

## 4. 验证结果
- `pnpm test`：通过（22 files / 101 tests）。
- `pnpm build`：通过。
- 新增测试覆盖：
  - `tests/service-ops.test.ts`：新增非法端口与日志行数回退默认值场景。

## 4.1 追加修复（运行稳定性与协同去重）
- 现象 1：`services:up` 后偶发 `launchctl bootstrap ... Input/output error`。
  - 原因：`bootout` 后服务状态切换存在短暂窗口，直接 bootstrap 偶发失败。
  - 修复：增加 stop 态等待 + bootstrap 重试。
- 现象 2：launchd 读取项目目录 `.env.local` 报 `operation not permitted`（常见于 Documents 路径）。
  - 原因：macOS TCC 对 LaunchAgent 读取受保护目录文件有限制。
  - 修复：`services:up` 启动前自动同步 env 到 `~/.config/ai-weekly/.env.launchd`，launchd 固定读取该文件。
- 现象 3：飞书“@机器人 运维”或审核动作偶发重复展示。
  - 原因：飞书回调在弱网场景可能重试投递。
  - 修复：回调服务新增短窗口去重（mention/operation/action-receipt），并为主审核卡增加“同 stage 短时间 no-op”抑制重复更新。

## 5. 3 分钟复盘模板（M4.4 版本）
```text
【1】本轮目标（30s）
- 我本轮要验证的能力点是：新机器是否能快速完成初始化，并通过一组命令稳定托管 daemon+tunnel。
- 我完成后的可见结果是：setup 能报告缺失项并给修复建议；services:* 能统一管理服务生命周期。

【2】关键实现（60s）
- 我改了哪 3 个核心文件：
  1) `src/tools/service-ops.ts`
  2) `tests/service-ops.test.ts`
  3) `scripts/feishu-tunnel.sh`
- 每个文件“为什么要改”：
  - `service-ops.ts`：把分散的手工运维动作沉淀成可重复命令，降低运行门槛。
  - `service-ops.test.ts`：保证参数解析与配置渲染稳定，避免运维命令回归破坏。
  - `feishu-tunnel.sh`：明确 debug 模式边界，避免误用临时 URL 作为长期回调地址。

【3】运行验证（45s）
- 我执行的命令：
  - `pnpm test`
  - `pnpm build`
- 结果是否符合预期：符合，新增命令和既有链路均可编译并通过测试。
- 有无 warning/边界场景：
  - 有，setup 若缺少 tunnel 登录或 credentials 会给出 FAIL，但不会隐式修改凭证文件。

【4】设计取舍（30s）
- 我放弃了哪个方案，原因是：放弃“直接依赖临时 Quick Tunnel 作为常驻模式”，因为 URL 不稳定且会导致飞书后台反复改配置。
- 当前实现的风险点是：仍是单机活跃模型，多机同时 `services:up` 可能造成重复调度。

【5】下一步（15s）
- 我下一轮最小可执行目标是：进入 M5，先接入 LLM 总结节点，并保持规则链路可回退。
```
