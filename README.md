# ai-weekly

基于 LangGraph 的 AI 日报/周报自动化项目骨架。

## 当前状态
- 已完成 `docs/PRD.md`（冻结需求）。
- 已完成 `docs/architecture.md`（系统设计）。
- 已提供可运行流程：`collect -> normalize -> dedupe -> llm_classify_score -> rank -> build_outline -> review_outline(兼容) -> review_final -> publish_or_wait -> llm_summarize -> build_report`。
- 周报审核支持「持久化指令优先，CLI 参数 fallback」、pending 周报复检发布、watchdog 守护扫描（含锁与重试）。
- 已完成 M3.2：Feishu 待审核通知、11:30 提醒命令、发布结果回执、本地回调服务（2B：本地 + 隧道）。
- 已完成 M3.3：`request_revision` 回流修订执行、runtime config 全局沉淀、`reject` 终止当前 run 发布。
- 已完成 M4：审核指令与 runtime config 升级到 SQLite（DB 优先 + 文件 fallback），并提供最小 Review API 与文件迁移命令。
- 已完成 M4.1：飞书通知统一为应用机器人（app-only）；卡片点击后支持即时反馈与群内状态回执。
- 已完成 M4.2：飞书审核交互重构为“阶段引导主卡 + 单卡更新 + 去噪回执”，降低误操作与群消息噪音。
- 已完成 M4.3：daemon 常驻自动调度 + @机器人主动触发面板 + 自动 Git 同步（可选 push 代理）。
- 已完成 M4.4：macOS 初始化引导 + 一键服务托管（launchd 托管 daemon + Named Tunnel）。
- 已完成 M5.1：MiniMax 逐条总结（daily/weekly）、4-12 条自适应“3 分钟速览”、失败自动回退与飞书合并告警。
- 已完成 M5.2：前置 LLM 批量分类与全量打分（含重试/拆批降级）、排序融合、报告导语与英文标题中文化展示。
- 已完成 M5.3：窗口型自适应降载与恢复、run 级诊断元数据、分类导读（LLM + 模板回退）。
- 已完成 M5.4：采集层支持 `rss + github_search` 混合来源，新增 GitHub 热门开源一手采集与来源诊断增强。
- 已完成 M5.5：周报单阶段终稿审核 + 受限 ReAct 修订回路（自由文本、checkpoint 续跑、失败分型）。
- 分布式互斥暂缓，当前以单机 daemon 为部署基线。

## 环境要求
- Node.js >= 20
- pnpm >= 9

## 新手最短路径（10 分钟）
适用人群：第一次在新电脑跑本项目，希望先跑通稳定模式（daemon + Named Tunnel）。

1) 安装依赖
```bash
pnpm install
```

2) 准备环境变量
```bash
cp .env.local.example .env.local
```
- 至少填好：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`REVIEW_CHAT_ID`、`FEISHU_CALLBACK_AUTH_TOKEN`。
- 若你已完成 Cloudflare Named Tunnel，补充：`CLOUDFLARED_TUNNEL_NAME`、`CLOUDFLARED_CONFIG_PATH`。
- 若启用了 `github_search` 来源，建议补充：`GITHUB_TOKEN`（未配置仍可运行，但更容易触发限流）。
- 说明：`src/cli.ts` 与 `src/tools/feishu-ops.ts` 启动时会自动加载 `.env.local`（或 `AI_WEEKLY_ENV_FILE` 指定文件）并覆盖同名进程变量，避免全局 shell 变量污染当前项目。

3) 执行初始化自检（会给出缺失项修复建议）
```bash
pnpm run setup:macos
```

4) 启动常驻服务（daemon + tunnel）
```bash
pnpm run services:up
```
- 说明：该命令会自动把 `AI_WEEKLY_ENV_FILE` 同步到 `~/.config/ai-weekly/.env.launchd`，规避 macOS 对 `Documents/Desktop` 的读取限制。
- 说明：`launchd` 模式还会把 DB、scheduler marker、notification、watchdog 等内部状态默认迁移到 `~/.local/state/ai-weekly/runtime`，降低后台读写 `Documents` 时被 TCC 拦截的概率；日报/周报产物仍写回仓库 `outputs/review` 与 `outputs/published`，保持 GitHub 发布链路不变。

5) 检查运行状态（必须看这一条）
```bash
pnpm run services:status
```
预期：`daemon=running`、`tunnel=running`、`local=ok`、`public=ok`。

6) 飞书内触发一次实际流程
- 在群里 `@应用机器人` 并发送：`运维`。
- 在操作卡点击：`生成日报（真实）` 或 `生成周报（真实）`。

7) 完成审核动作
- 直接点击 `终稿通过并发布`（`大纲通过`仅保留历史兼容，不再是必经步骤）。

8) 排障日志（如果步骤 5/6 异常）
```bash
pnpm run services:logs
```

常见故障提示：
- 若 `services:status` 显示 `running` 但日报未继续生成，优先执行 `pnpm run services:restart`，并检查日志中是否仍有 `EPERM: operation not permitted, open 'outputs/db/app.sqlite'` 一类报错。
- 若需要自定义 launchd 运行态目录，可设置 `AI_WEEKLY_RUNTIME_ROOT`，例如 `~/.local/state/ai-weekly/runtime-dev`。

说明：
- `pnpm run feishu:tunnel` 是临时联调模式，URL 可能变化；长期运行请使用 `services:up`。
- 如果只想本地看骨架，不走飞书协同，可直接执行 `pnpm run:weekly:mock`。

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
# 常驻自动化模式（推荐）
pnpm run run:daemon
```

来源配置说明：
- 配置文件：`data/sources.yaml`
- 支持类型：`rss`、`github_search`
- `github_search` 推荐配置 `GITHUB_TOKEN`，提高 API 配额稳定性
- `github_search` 默认采用 dual-query（`active_window + new_repo_window`）：
  - `activeWindowDays`：近期活跃窗口（默认 7 天，基于 `pushed`）
  - `newRepoWindowDays`：近期新仓窗口（默认 14 天，基于 `created`）
  - `cooldownDays`：跨天去重窗口（默认 10 天）
  - `breakoutMinStars + breakoutRecentHours`：突破 cooldown 的高强度动态阈值

示例（AI 领域 Trending-like 配置）：
```yaml
- id: github-hot-open-source
  name: GitHub 热门开源（AI）
  type: github_search
  query: "topic:artificial-intelligence archived:false stars:>=200"
  queryMode: dual
  activeWindowDays: 7
  newRepoWindowDays: 14
  cooldownDays: 10
  breakoutMinStars: 200000
  breakoutRecentHours: 24
  sort: updated
  order: desc
  perPage: 20
  language: mixed
  weight: 88
  enabled: true
```

仅用于“数据源健康诊断”时，建议使用一键诊断命令（自动关闭 LLM/通知/自动 git 同步）：
```bash
pnpm run source:diagnose
# 可选：
# MODE=daily pnpm run source:diagnose
# SOURCE_DIAG_FAIL_ON_WARNING=true pnpm run source:diagnose
```

当启用 `github_search` 且未配置 `GITHUB_TOKEN` 时，诊断会输出 advisory 提示（流程仍会继续执行）。
同时会输出 GitHub 结构化诊断统计：`queryMode/sourceCount/collected/merged/kept/selected/history/suppressed/breakout`，用于解释“为什么某条被入选或过滤”。

可选参数：
```bash
tsx src/cli.ts run --mode weekly --source-config data/sources.yaml --runtime-config-path outputs/runtime-config/global.json --source-limit 6 --timezone Asia/Shanghai
```

M4 存储参数（默认 DB 模式）：
```bash
# 默认：--storage-backend db --storage-db-path outputs/db/app.sqlite
tsx src/cli.ts run --mode weekly --mock

# 强制回到纯文件模式
tsx src/cli.ts run --mode weekly --mock --storage-backend file

# DB 模式关闭文件回退（严格模式）
tsx src/cli.ts run --mode weekly --mock --storage-backend db --storage-no-fallback
```

审核相关参数：
```bash
# 周报终稿审核通过，立即发布（单阶段）
tsx src/cli.ts run --mode weekly --mock --approve-final

# 历史兼容：若传 --approve-outline，只会返回兼容提示，不再推进独立阶段
tsx src/cli.ts run --mode weekly --mock --approve-outline

# 指定生成时间（用于回放“周一 12:30 超时自动发布”场景）
tsx src/cli.ts run --mode weekly --mock --generated-at 2026-03-09T05:00:00.000Z
```

LLM 增强参数（M5.2+，MiniMax）：
```bash
# 方式 1：环境变量开启（推荐）
export LLM_SUMMARY_ENABLED=true
export ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic
export ANTHROPIC_API_KEY=your_coding_plan_key
# 或使用 MINIMAX_API_KEY（二选一）
# export MINIMAX_API_KEY=your_coding_plan_key
export LLM_GLOBAL_MAX_CONCURRENCY=2
export LLM_CLASSIFY_SCORE_ENABLED=true
export LLM_CLASSIFY_SCORE_BATCH_SIZE=10
export LLM_CLASSIFY_SCORE_TIMEOUT_MS=60000
export LLM_CLASSIFY_SCORE_MAX_CONCURRENCY=2
export LLM_CLASSIFY_SCORE_MIN_CONFIDENCE=0.6
export LLM_CLASSIFY_SCORE_PROMPT_VERSION=m5.4-v1
export LLM_SUMMARY_MAX_CONCURRENCY=2
export LLM_RANK_FUSION_WEIGHT=0.65
export LLM_SUMMARY_PROMPT_VERSION=m5.3-v1
pnpm run run:weekly

# 方式 2：命令行临时覆盖
tsx src/cli.ts run --mode weekly \
  --llm-classify-score-enabled \
  --llm-classify-score-batch-size 10 \
  --llm-classify-score-timeout-ms 60000 \
  --llm-classify-score-max-concurrency 2 \
  --llm-classify-score-min-confidence 0.6 \
  --llm-classify-score-prompt-version m5.4-v1 \
  --llm-summary-enabled \
  --llm-summary-minimax-api-key your_key \
  --llm-summary-minimax-model MiniMax-M2.5 \
  --llm-global-max-concurrency 2 \
  --llm-rank-fusion-weight 0.65
```

ReAct 修订与自动 recheck 护栏参数（M5.5+）：
```bash
# 默认值：enabled=true, max-steps=20, max-wall-clock-ms=600000, max-llm-calls=30, max-tool-errors=5
# 自动 recheck（飞书审核动作触发）默认总超时：600000ms
tsx src/cli.ts run --mode weekly --mock \
  --revision-agent-enabled \
  --revision-agent-max-steps 20 \
  --revision-agent-max-wall-clock-ms 600000 \
  --revision-agent-max-llm-calls 30 \
  --revision-agent-max-tool-errors 5 \
  --revision-agent-planner-timeout-ms 30000 \
  --revision-recheck-max-wall-clock-ms 600000
```

M5.3 输出增强说明：
- 报告会新增“本期导语”区块（2-3 句）。
- 报告会新增“分类导读”区块（主要分类 1 句导读，失败时模板回退）。
- 英文标题会尝试显示为“中文标题（原标题）”。
- 结构化产物会记录 `llmClassifyScoreMeta`（批量配置、重试与失败分类统计）以及 `scoreBreakdown`（规则分/LLM 分/融合分）。
- 结构化产物会记录 `githubSelectionMeta`（双查询命中、cooldown 抑制、breakout 放行、最终入选统计）。
- 结构化产物会记录 `adaptiveDegradeStats`（降载触发/恢复、窗口统计）用于运行诊断。

持久化审核指令（默认目录：`outputs/review-instructions/`）：
```bash
# 文件路径：outputs/review-instructions/weekly/2026-03-09.json
{
  "mode": "weekly",
  "reportDate": "2026-03-09",
  "instructions": [
    { "stage": "final_review", "approved": true, "decidedAt": "2026-03-09T02:00:00.000Z" }
  ]
}
```

回流修订示例（`request_revision`）：
```json
{
  "mode": "weekly",
  "reportDate": "2026-03-10",
  "instructions": [
    {
      "stage": "final_review",
      "action": "request_revision",
      "decidedAt": "2026-03-10T09:20:00.000Z",
      "feedback": {
        "revisionRequest": "补充两条 agent 工程化案例，并删除重复条目；若超时可继续执行未完成任务。",
        "revisionScope": "all",
        "revisionIntent": "content_update",
        "continueFromCheckpoint": true,
        "candidateAdditions": [
          { "title": "新增 Agent 实战案例", "link": "https://example.com/agent-case", "category": "agent" }
        ],
        "sourceToggles": [{ "sourceId": "openai-news", "enabled": false }],
        "rankingWeightAdjustments": [{ "dimension": "keyword", "weight": 1.2 }],
        "editorNotes": "补充工程实践并降低泛新闻噪音"
      }
    }
  ]
}
```

pending 周报复检发布（不重跑采集链路）：
```bash
tsx src/cli.ts run --mode weekly --recheck-pending --report-date 2026-03-05
```

`reject` 语义（M3.3）：
- 被 reject 的当前 run 在 recheck/watchdog 下不会发布。
- 同一 reportDate 如需继续发布，必须新建 run（新 runId）。

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

Feishu 协同（M3.2 + M4.1）：
```bash
# 1) 启动本地回调服务（2B 形态：本地服务 + 隧道暴露）
tsx src/cli.ts run --serve-feishu-callback

# 2) 周一 11:30 提醒 pending 审核（建议由 cron 触发）
tsx src/cli.ts run --mode weekly --notify-review-reminder

# 3) 可选：覆盖报告公网前缀（用于通知里的可点击链接）
tsx src/cli.ts run --mode weekly --notify-review-reminder --report-public-base-url https://raw.githubusercontent.com/<org>/<repo>/<branch>
```

Review API（M4）：
```bash
# 启动最小 API（默认 127.0.0.1:8790）
pnpm run run:review:api

# 或手动指定
tsx src/cli.ts run --serve-review-api --review-api-host 127.0.0.1 --review-api-port 8790
```

主要接口：
- `POST /api/review-actions`
- `GET /api/review-actions/latest`
- `GET /api/review/pending`
- `GET /api/runtime-config`
- `PATCH /api/runtime-config`（支持 `expectedVersion` 冲突检测）
- `GET /api/audit-events`
- `GET /api/operation-jobs`

文件迁移到 DB（M4）：
```bash
# 将 outputs/review-instructions + runtime-config 文件导入 SQLite
pnpm run run:migrate:file-to-db

# 一键跑完 M4 核心链路验证（生成 -> API 审核 -> recheck 发布 -> 审计查询）
pnpm run verify:m4

# 用 DB Browser for SQLite 打开本地数据库（macOS）
pnpm run db:open
```

SQLite 本地查看（CLI）：
```bash
pnpm run db:sqlite
# 进入 sqlite3 后可执行：
# .tables
# .headers on
# .mode column
# SELECT id, mode, report_date, stage, action, decided_at FROM review_instructions ORDER BY id DESC LIMIT 20;
```

macOS 安装 DB Browser：
```bash
brew install --cask db-browser-for-sqlite
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

# 4) 完整链路脚本（生成周报 -> 发卡片 -> 两次点击 -> 两次 recheck）
pnpm run feishu:fullflow
```

Feishu 主动触发（M4.3）：
- 在群里 `@应用机器人` 并发送包含“运维/操作卡/ops/触发”等关键词的文本。
- 机器人会下发“主动触发面板”卡片，支持按钮触发：
  - 生成日报（真实）
  - 生成周报（真实）
  - recheck
  - watchdog dry-run
  - 发送审核提醒
  - 查询本期状态
- 点击按钮后先“受理入队”，任务完成后再群内回执 success/failed。
- 说明：该入口默认走真实数据采集链路；如需 mock 演练，请使用 CLI 显式加 `--mock`。
- 进度可观测：每个 `job` 会维护一张“运行进度卡”并持续更新当前节点（默认 milestone 粒度，不刷屏）。

M4.3 运维备忘（防遗漏）：
- 常驻运行命令：`pnpm run run:daemon`
- 关键自动化开关：
  - `AUTO_GIT_SYNC=true|false`
  - `GIT_SYNC_PUSH=true|false`
  - `GIT_SYNC_INCLUDE_PATHS=outputs/review,outputs/published,outputs/review-instructions,outputs/runtime-config`
- push 代理（仅 push 使用）：
  - `GIT_PUSH_HTTP_PROXY`
  - `GIT_PUSH_HTTPS_PROXY`
  - `GIT_PUSH_NO_PROXY`
- 默认会被自动同步的路径：
  - `outputs/review/**`
  - `outputs/published/**`
  - `outputs/review-instructions/**`
  - `outputs/runtime-config/**`
- 默认不会被同步的路径：
  - `outputs/db/**`
  - `outputs/notifications/**`
  - `outputs/daemon/**`
  - `outputs/service-logs/**`

macOS 初始化与一键服务托管（M4.4）：
```bash
# 1) 首次在新电脑执行（检查依赖/配置/隧道资产）
pnpm run setup:macos

# 2) 一键启动双服务（daemon + tunnel）
pnpm run services:up

# 3) 查看运行状态与健康检查（local + public）
pnpm run services:status

# 4) 查看服务日志（默认 tail 80 行）
pnpm run services:logs

# 5) 重启/停止
pnpm run services:restart
pnpm run services:down
```

M4.4 说明：
- `services:up` 会写入 `~/Library/LaunchAgents/com.ai-weekly.{daemon,tunnel}.plist` 并执行 `launchctl bootstrap/kickstart`。
- `services:up` 启动前会同步 launchd 专用 env 文件（默认 `~/.config/ai-weekly/.env.launchd`），降低 `source .env.local` 被系统拦截概率。
- callback 稳定模式推荐使用 Named Tunnel（`CLOUDFLARED_TUNNEL_NAME` + 固定域名）。
- `pnpm run feishu:tunnel` 仅用于临时联调，URL 可能变化，不建议长期运行。
- 如需修改默认环境文件位置，可设置 `AI_WEEKLY_ENV_FILE=/path/to/.env.local`。

联调输出说明：
- `pnpm run feishu:dev` 会输出本地回调地址与隧道日志。
- 使用 cloudflared 时，日志会自动打印 `callback-url=.../feishu/review-callback`。
- 使用 ngrok 时，可通过 `http://127.0.0.1:4040/api/tunnels` 获取公网地址。
- 若点击后无反馈，优先检查飞书后台回调 URL 是否为当前隧道地址并重新发布应用。

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
  "action": "approve_final | request_revision | reject | approve_outline(兼容)",
  "reportDate": "2026-03-09",
  "stage": "final_review",
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

环境变量优先级说明（防全局污染）：
- `src/cli.ts` 与 `src/tools/feishu-ops.ts` 启动时会自动加载 `.env.local`（或 `AI_WEEKLY_ENV_FILE` 指定文件）并覆盖同名进程变量。
- 这意味着即使 shell 里残留了错误的全局变量（如 `ANTHROPIC_BASE_URL`），项目命令仍以仓库内配置为准。
- 新电脑初始化时只要完成 `cp .env.local.example .env.local` 并填写真实值，即可避免同类污染问题。

建议在 `.env.local` 同时维护以下变量（长期使用）：
```bash
# 回调服务
FEISHU_CALLBACK_AUTH_TOKEN=""
FEISHU_SIGNING_SECRET=""
FEISHU_CALLBACK_PORT="8787"
FEISHU_CALLBACK_PATH="/feishu/review-callback"

# 自建应用（通知 + 卡片发送 + 点击反馈回执）
FEISHU_APP_ID=""
FEISHU_APP_SECRET=""
REVIEW_CHAT_ID=""   # 必填

# 可选：用于把本地文件路径转换为飞书可点击 URL
# 例如 https://raw.githubusercontent.com/<org>/<repo>/<branch>
REPORT_PUBLIC_BASE_URL=""
# 可选但强烈建议：github_search 数据源鉴权 token
GITHUB_TOKEN=""

# Service Runner（M4.4）
# 可选：显式指定“源配置”路径（建议保持为项目 .env.local）
AI_WEEKLY_ENV_FILE="/Users/<your-user>/Documents/github/ai-weekly/.env.local"
# 可选：launchd “运行快照”路径；不填默认 ~/.config/ai-weekly/.env.launchd
AI_WEEKLY_LAUNCHD_ENV_FILE="/Users/<your-user>/.config/ai-weekly/.env.launchd"
# 重要：不要把 AI_WEEKLY_ENV_FILE 配成与 AI_WEEKLY_LAUNCHD_ENV_FILE 相同路径
# Named Tunnel 固定模式（长期运行推荐）
CLOUDFLARED_TUNNEL_NAME="ai-weekly-callback"
CLOUDFLARED_CONFIG_PATH="/Users/<your-user>/.cloudflared/config.yml"
# 首次自动生成 config 时使用；若 config 已存在可留空
CLOUDFLARED_TUNNEL_ID=""
CLOUDFLARED_TUNNEL_HOSTNAME="callback.example.com"
CLOUDFLARED_CREDENTIALS_FILE=""
# services:logs 默认 tail 行数
SERVICE_LOGS_TAIL="80"

# daemon 常驻调度配置
DAEMON_SCHEDULER_INTERVAL_MS="30000"
DAEMON_WORKER_POLL_MS="2000"
DAEMON_MARKER_ROOT="outputs/daemon/schedule-markers"

# 运维进度通知粒度（M5.6）
# off | milestone | verbose（默认 milestone）
OP_PROGRESS_NOTIFY_LEVEL="milestone"
OP_PROGRESS_CARD_ENABLED="true"
OP_PROGRESS_NOTIFY_THROTTLE_MS="15000"
OP_PROGRESS_NOTIFY_MAX_UPDATES="20"

# ReAct 修订 Agent（M5.5）
REVISION_AGENT_ENABLED="true"
REVISION_AGENT_MAX_STEPS="20"
REVISION_AGENT_MAX_WALL_CLOCK_MS="600000"
REVISION_AGENT_MAX_LLM_CALLS="30"
REVISION_AGENT_MAX_TOOL_ERRORS="5"
REVISION_AGENT_PLANNER_TIMEOUT_MS="30000"

# 自动 Git 同步（默认关闭）
AUTO_GIT_SYNC="false"
GIT_SYNC_PUSH="false"
GIT_SYNC_INCLUDE_PATHS="outputs/review,outputs/published,outputs/review-instructions,outputs/runtime-config"
GIT_SYNC_REMOTE="origin"
GIT_SYNC_BRANCH=""

# push 代理（可选，只有 git push 使用）
GIT_PUSH_HTTP_PROXY=""
GIT_PUSH_HTTPS_PROXY=""
GIT_PUSH_NO_PROXY=""
```

飞书点击反馈（M4.1）：
- 点击卡片动作后，回调接口会返回 toast（success/error），飞书侧可立即看到处理结果。
- 系统会向群内追加“审核动作回执”消息，包含 `reportDate/action/operator/result/reviewStage/reviewStatus/publishStatus`。
- 若动作写入成功但回执发送失败，回调仍返回成功并附带 warning，避免通知链路反向阻断审核主流程。
- 回调幂等采用双层策略：`traceId/messageId` 去重 + 语义去重（短窗口内同动作仅受理一次）。

飞书交互体验（M4.2）：
- 待审核卡片为单主卡入口，同一 `reportDate + runId` 优先更新原卡，避免重复发卡。
- 周报卡片按单阶段收敛：支持“终稿通过并发布 / 提交修订并重跑 / 拒绝本次”，并内置修订表单字段（`revision_request/revision_scope/revision_intent/continue_from_checkpoint`）。
- 重复点击命中幂等后，仅返回“忽略重复提交，请以最新状态卡为准”反馈，不重复群发动作回执。
- 审核动作自动触发的 `recheck` 也可见生命周期进度（`queued/started/progress/success|failed|cancelled`），失败或中断时会下发“修订恢复卡”（编辑后重试/继续执行/直接发布）。

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
   - 检查 `FEISHU_APP_ID/FEISHU_APP_SECRET/REVIEW_CHAT_ID` 是否正确。
   - 确认应用机器人已在目标群，并且应用版本已发布。
   - 检查是否发到了错误群（常见是 `REVIEW_CHAT_ID` 不是当前测试群）。

2) 提醒命令 sent=0：
  - 说明当前没有 pending 周报，或该日期提醒已写入 marker。
  - 可先生成 pending 周报，再删除对应 marker 后重试。

3) 飞书回调 401：
   - 若回调地址使用了 `?token=...`，确认与 `FEISHU_CALLBACK_AUTH_TOKEN` 完全一致。
   - 若启用 `FEISHU_SIGNING_SECRET`，确认飞书应用侧签名 secret 与本地一致。
4) 飞书消息里的 `reviewFile/publishedFile` 点不开：
   - 这是本地路径，默认不可公网访问。
   - 配置 `REPORT_PUBLIC_BASE_URL` 后，通知会附加 `reviewUrl/publishedUrl` 可点击链接。
```

推荐运行方式：
- 优先使用 `pnpm run run:daemon` 常驻运行，自动触发 daily/weekly/reminder/watchdog。
- 若暂不启用 daemon，可继续使用 cron 触发 `--notify-review-reminder` 与 `--watch-pending-weekly`。

## 测试
```bash
pnpm test
```

## 设计取舍
- 采集层采用 `rss + github_search` 双适配器：媒体资讯与开源一手信号并行，且维持 fail-soft。
- 总结能力采用“逐条 LLM + 聚合速览”，避免全量单 prompt 导致上下文劣化。
- LLM 调用失败时自动回退规则摘要，且不阻断审核/发布主流程。

## 下一步（建议）
1. 进入 M5.4：继续优化分类/排序提示词与质量闸门，降低长尾回退比例。
2. 增加 LLM 成本预算开关与周期统计看板（日报/周报维度）。
3. 评估多实例部署后再启动分布式互斥方案。
