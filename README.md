# ai-weekly

基于 LangGraph 的 AI 日报/周报自动化项目骨架。

## 当前状态
- 已完成 `docs/PRD.md`（冻结需求）。
- 已完成 `docs/architecture.md`（系统设计）。
- 已提供可运行的 M3.1 流程：`collect -> normalize -> dedupe -> classify -> rank -> build_outline -> review_outline -> review_final -> publish_or_wait -> build_report`。
- 周报审核支持「持久化指令优先，CLI 参数 fallback」、pending 周报复检发布、watchdog 守护扫描（含锁与重试）。
- 已接入 M3.2 第一阶段能力：Feishu 待审核通知、11:30 提醒命令、发布结果回执、本地回调服务（2B：本地 + 隧道）。
- 分布式互斥暂缓，当前以单机定时任务为部署基线。

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

pending 周报守护扫描（批量巡检）：
```bash
# dry-run：仅输出将发布/跳过结果，不写入产物
tsx src/cli.ts run --mode weekly --watch-pending-weekly --dry-run

# 实际执行：对符合条件的 pending 周报执行复检并发布
tsx src/cli.ts run --mode weekly --watch-pending-weekly

# 自定义重试与锁文件
tsx src/cli.ts run --mode weekly --watch-pending-weekly --watch-max-retries 3 --watch-retry-delay-ms 500 --watch-lock-file outputs/watchdog/weekly.lock

# 锁文件异常残留时可强制清锁（谨慎）
tsx src/cli.ts run --mode weekly --watch-pending-weekly --watch-force-unlock
```

Feishu 协同（M3.2）：
```bash
# 1) 启动本地回调服务（2B 形态：本地服务 + 隧道暴露）
tsx src/cli.ts run --serve-feishu-callback

# 2) 周一 11:30 提醒 pending 审核（建议由 cron 触发）
tsx src/cli.ts run --mode weekly --notify-review-reminder
```

Feishu 与工程融合（一键联调）：
```bash
# 0) 确认已加载 .env.local（见下方 direnv 配置）

# 1) 一键启动“本地回调 + 隧道”
pnpm run feishu:dev

# 2) 仅启动本地回调服务
pnpm run feishu:callback

# 3) 仅启动隧道（自动优先 cloudflared，fallback 到 ngrok）
pnpm run feishu:tunnel
```

联调输出说明：
- `pnpm run feishu:dev` 会输出本地回调地址与隧道日志。
- 使用 cloudflared 时，日志会自动打印 `callback-url=.../feishu/review-callback`。
- 使用 ngrok 时，可通过 `http://127.0.0.1:4040/api/tunnels` 获取公网地址。
- 若出现 `sign match fail`，优先检查飞书机器人签名开关与 `FEISHU_WEBHOOK_SECRET` 是否一致。

飞书回调 URL 建议：
```text
https://<your-public-domain>/feishu/review-callback?token=<FEISHU_CALLBACK_AUTH_TOKEN>
```

说明：
- 系统支持三种回调鉴权入口：`Authorization: Bearer`、query `token`、`x-callback-token`。
- 飞书原生回调通常不方便自定义 `Authorization`，建议使用 query `token`。

飞书卡片动作 value 字段约定（建议）：
```json
{
  "action": "approve_outline | approve_final | request_revision | reject",
  "reportDate": "2026-03-09",
  "stage": "outline_review | final_review",
  "reason": "可选审核意见",
  "messageId": "可选"
}
```

兼容说明：
- 已兼容 `report_date`、`review_action`、`action_type` 等别名字段。
- 已兼容 `event.action.value` 与 `event.action.form_value` 两类飞书卡片常见结构。

Feishu 环境变量（推荐 `direnv` 项目级自动加载）：
```bash
# 1) 首次安装 direnv（macOS）
brew install direnv
echo 'eval "$(direnv hook zsh)"' >> ~/.zshrc
source ~/.zshrc

# 2) 在项目根目录初始化本地变量文件
cp .env.local.example .env.local

# 3) 编辑 .env.local 填入你的真实值

# 4) 授权当前目录自动加载
direnv allow
```

之后你每次 `cd` 到项目目录会自动加载 `.env.local`，离开目录自动卸载。

建议在 `.env.local` 同时维护以下变量（长期使用）：
```bash
# webhook 通知
FEISHU_WEBHOOK_URL=""
FEISHU_WEBHOOK_SECRET=""

# 回调服务
FEISHU_CALLBACK_AUTH_TOKEN=""
FEISHU_SIGNING_SECRET=""
FEISHU_CALLBACK_PORT="8787"
FEISHU_CALLBACK_PATH="/feishu/review-callback"

# 自建应用（发送 interactive 卡片时使用）
FEISHU_APP_ID=""
FEISHU_APP_SECRET=""
REVIEW_CHAT_ID=""   # 可选，配置后可直接发卡片
```

Feishu 联调自动化命令：
```bash
# 1) 获取 tenant_access_token（自动）
pnpm run feishu:token

# 2) 查询测试群 chat_id（自动）
pnpm run feishu:chat:list
# 按群名过滤
pnpm run feishu:chat:list -- --chat-name "AI 周报测试群"

# 3) 发送审核卡片（自动）
# 使用 REVIEW_CHAT_ID
pnpm run feishu:card:send -- --report-date 2026-03-09
# 或显式指定 chat_id
pnpm run feishu:card:send -- --chat-id oc_xxx --report-date 2026-03-09
```

隧道依赖（任选其一）：
```bash
# cloudflared（推荐）
brew install cloudflared

# ngrok（可选）
brew install ngrok/ngrok/ngrok
```

联调常见问题：
```text
1) 终端提示 sent，但飞书群无消息：
   - 查看是否返回了飞书业务码非 0（例如 code=19021）。
   - 检查 FEISHU_WEBHOOK_SECRET 与机器人签名配置是否匹配。
   - 检查机器人关键词是否允许“AI 周报”文本。

2) 提醒命令 sent=0：
  - 说明当前没有 pending 周报，或该日期提醒已写入 marker。
  - 可先生成 pending 周报，再删除对应 marker 后重试。

3) 飞书回调 401：
   - 若回调地址使用了 `?token=...`，确认与 `FEISHU_CALLBACK_AUTH_TOKEN` 完全一致。
   - 若启用 `FEISHU_SIGNING_SECRET`，确认飞书应用侧签名 secret 与本地一致。
```

推荐 cron（北京时间）：
```bash
# 每周一 11:30 发送一次审核提醒
30 11 * * 1 cd /path/to/ai-weekly && npx tsx src/cli.ts run --mode weekly --notify-review-reminder

# 每周一 12:31 执行一次 watchdog
31 12 * * 1 cd /path/to/ai-weekly && pnpm run:weekly:watch
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
1. 接入 Feishu 审核协同：通知、审核动作输入、截止提醒。
2. 增加“审核意见回流修订”：新增/删除候选、主题词/搜索词/权重调整。
3. 审核指令存储从文件升级到 DB/API，并补并发写保护。
4. 接入 LLM 总结节点，并逐步扩展到分类/打标/排序辅助。
