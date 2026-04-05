# M4 学习复盘 06：launchd runtime root 隔离 + TCC 权限修复

## 1. 本次实现了什么
- 修复了 macOS `launchd` 模式下后台进程访问仓库 `outputs/` 内部状态时，偶发触发 `EPERM: operation not permitted` 导致 daemon “进程存活但调度失效”的问题。
- 新增 launchd 专用 runtime root 机制：
  - 默认路径：`~/.local/state/ai-weekly/runtime`
  - 可通过 `AI_WEEKLY_RUNTIME_ROOT` 覆盖
- `services:up` 现在会自动：
  - 迁移内部状态目录（DB、scheduler marker、notification、watchdog、runtime config、review instruction）
  - 生成 launchd 专用 env 覆盖块
  - 让 daemon 优先读取低风险路径，而不是直接读写 `Documents` 下的内部状态
- 保持 `outputs/review` 与 `outputs/published` 仍写回仓库，避免影响 GitHub 发布链接与 report 审阅路径。

## 2. 流程图（M4.4 修复版）
```text
services:up
  -> copy .env.local to ~/.config/ai-weekly/.env.launchd
  -> migrate internal runtime state to ~/.local/state/ai-weekly/runtime
  -> append managed runtime path overrides
  -> bootstrap + kickstart daemon/tunnel
  -> daemon uses external DB/marker/notification/watchdog paths
  -> review/published reports still write to repo outputs/
```

## 3. 源码导读（建议阅读顺序）
1. `src/tools/service-ops.ts`
- 看 `ensureLaunchdEnvFile`：理解为什么不能只复制 `.env.local`，还要追加“受管 runtime path 覆盖块”。
- 看 `buildManagedLaunchdEnv`：理解哪些路径必须迁出仓库，哪些路径应继续保留在仓库。
- 看 `migrateManagedRuntimeState`：理解修复为什么要做一次性冷迁移，而不是只改 env 默认值。

2. `src/cli.ts`
- 看 `defaults`：理解 CLI 默认路径如何从 env 接管，避免 launchd 侧传了 env 但业务 CLI 仍忽略。

3. `tests/service-ops.test.ts`
- 看 runtime root 相关断言：理解“路径保护判断 + 覆盖块拼装 + Git include 收敛”的回归边界。

4. `tests/cli-defaults.test.ts`
- 看 env 覆盖默认值测试：理解为什么这类修复必须在 CLI 默认层补回归测试。

## 4. 验证结果
- `pnpm test`：待执行。
- `pnpm build`：待执行。
- 预期运行验证：
  - `pnpm run services:restart`
  - `pnpm run services:status`
  - 检查 `~/.config/ai-weekly/.env.launchd` 中的受管 runtime path 是否生效
  - 检查下一次 `run_daily` 是否继续产出并写入 `outputs/published/daily`

## 5. 设计取舍
- 为什么不直接要求用户手动给 `launchd/node` 打开更高系统权限：
  - 因为这类修复不可迁移、不可审计，而且换机器后仍会重复踩坑。
- 为什么不是把所有 `outputs/` 都迁出仓库：
  - 因为 `review/published` 直接参与 Git 发布与公网链接，全部迁出会破坏现有协作路径。
- 为什么要覆盖 `GIT_SYNC_INCLUDE_PATHS`：
  - 因为内部状态迁出仓库后，继续把 `review-instructions/runtime-config` 作为 Git add 范围只会制造空路径噪音。

## 6. 风险与后续
- 当前修复优先保证 daemon 自动调度恢复；若未来发现 `outputs/review` / `outputs/published` 也会在后台场景触发 TCC，则需要再设计“产物镜像目录 + 发布目录同步”。
- 这次修复假设仓库源码可被 launchd 正常读取；若后续连源码加载都被 TCC 拦截，需要进一步评估“工作副本迁出 Documents”的方案。

## 7. 3 分钟复盘模板
```text
【1】本轮目标（30s）
- 我本轮要修的是：daemon 仍显示 running，但 2026-04-03 之后不再自动生成日报。
- 我想验证的根因是：launchd 对 Documents 下内部状态目录的后台读写触发了 TCC `EPERM`。

【2】关键实现（60s）
- 我改了哪 3 个核心文件：
  1) `src/tools/service-ops.ts`
  2) `src/cli.ts`
  3) `tests/service-ops.test.ts` / `tests/cli-defaults.test.ts`
- 每个文件“为什么要改”：
  - `service-ops.ts`：让 launchd 拥有稳定、低风险的 runtime root，并自动迁移旧状态。
  - `cli.ts`：让运行时路径真正支持 env 覆盖，避免配置写了但业务不认。
  - 测试文件：防止后续把 runtime path 覆盖逻辑回退掉。

【3】运行验证（45s）
- 我执行的命令：
  - `pnpm test`
  - `pnpm build`
  - `pnpm run services:restart`
  - `pnpm run services:status`
- 我期待看到：
  - 不再出现 `EPERM open outputs/db/app.sqlite`
  - 下一次 daily run 能继续入队并完成

【4】设计取舍（30s）
- 我放弃了哪个方案，原因是：
  - 放弃“只让用户手工重启/授权”的方案，因为它不能从工程层面消除路径风险。
- 当前实现的风险点是：
  - 仍有一部分 report 产物保留在仓库目录，未来若 TCC 边界继续收紧，可能还要做第二轮隔离。

【5】下一步（15s）
- 我下一轮最小可执行目标是：验证 restart 后的实际 daily run 恢复，并决定是否需要补跑 2026-04-04/2026-04-05。
```
