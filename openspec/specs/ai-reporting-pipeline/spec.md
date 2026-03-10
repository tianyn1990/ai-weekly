# ai-reporting-pipeline Specification

## Purpose
定义 AI 日报/周报流水线的可执行行为基线，明确从采集、处理、审核到发布的状态流转，并约束超时自动发布与失败容错策略，确保系统可验证、可追踪、可持续迭代。
## Requirements
### Requirement: Pipeline CLI SHALL support daily/weekly report generation
系统 SHALL 提供统一 CLI 入口，用于触发 `daily` 或 `weekly` 模式的报告生成，并支持 `mock` 数据模式用于学习与调试。

#### Scenario: Run weekly report in mock mode
- **WHEN** 用户执行 `pnpm run:weekly:mock`
- **THEN** 系统完成一次 `weekly` 流程执行并输出报告文件
- **AND** 处理链路包含 collect、normalize、dedupe、llm_classify_score、rank、build_report 节点

#### Scenario: Run daily report in live mode
- **WHEN** 用户执行 `pnpm run:daily`
- **THEN** 系统按已启用来源抓取并生成 `daily` 报告
- **AND** 即使部分来源失败，流程仍可结束并产出结果

### Requirement: Processing pipeline SHALL generate review artifacts with traceable metadata
系统 SHALL 在每次执行后产出待审核报告文件与结构化元数据文件，且关键状态文件可按配置进入 Git 同步路径，便于人工审核与后续发布；当启用 LLM 能力时，产物 SHALL 记录分类打分、总结、融合结果、回退状态与诊断信息。

#### Scenario: Review artifact records classify-score metadata and score breakdown
- **WHEN** 本次 run 启用了前置 LLM 分类打分能力
- **THEN** 结构化产物包含 `llmClassifyScoreMeta`（批次、并发、重试、失败分类、回退统计）
- **AND** 条目可追溯规则分、LLM 分与融合后最终分

#### Scenario: Review artifact remains compatible when classify-score metadata is missing
- **WHEN** recheck 或读取历史 artifact 时缺失 `llmClassifyScoreMeta`
- **THEN** 系统使用兼容逻辑继续运行
- **AND** 不因版本差异中断流程

### Requirement: Weekly review report SHALL include review deadline policy
系统 SHALL 在周报待审核文稿中体现人工审核窗口和自动发布兜底规则。

#### Scenario: Weekly report includes timeout publish rule
- **WHEN** 生成 `weekly` 模式的待审核文稿
- **THEN** 文稿包含周一 12:30（北京时间）审核截止信息
- **AND** 文稿明确截止前未审核将自动发布当前版本

### Requirement: Pipeline SHALL record warnings for source failures
系统 SHALL 对来源抓取失败进行 warning 记录，而不是直接中断整个流程。

#### Scenario: One source feed is unavailable
- **WHEN** 某来源返回 HTTP 异常或解析异常
- **THEN** 系统将失败信息写入 `warnings`
- **AND** 系统继续处理其他来源并输出最终报告

### Requirement: Classification SHALL include dedicated agent category
系统 SHALL 以前置 LLM 分类为主、规则分类为兜底，输出既有分类集合（含 `agent`），并在低置信度或异常场景回退到规则结果。

#### Scenario: LLM classifies agent-related item as agent
- **WHEN** 前置 LLM 分类阶段识别到 Agent 工程实践相关条目
- **THEN** 条目分类结果为 `agent`
- **AND** 分类统计中包含 `agent` 维度

#### Scenario: Classification falls back to rules on low confidence or failure
- **WHEN** LLM 分类结果低于置信度阈值或发生超时/解析失败
- **THEN** 系统对该条目回退规则分类
- **AND** 记录回退原因且不中断流程

### Requirement: Weekly pipeline SHALL support human review gates before publish
系统 SHALL 在 weekly 模式提供审核断点，至少包含大纲审核与终稿审核两个阶段，并从持久化审核指令源读取审核动作；M4 阶段持久化源 SHALL 以 DB/API 为主，并维持结构化回流 payload 与 last-write-wins 决策策略。

#### Scenario: Read latest review action from DB/API in recheck path
- **WHEN** recheck 或 watchdog 需要判定某 reportDate 的审核状态
- **THEN** 系统优先从 DB/API 读取最新有效审核动作
- **AND** 若启用 fallback 且 DB 不可用，可回退到文件路径读取

#### Scenario: Instruction source remains compatible with CLI fallback
- **WHEN** 外部回调不可用或 API 写入失败
- **THEN** 系统允许 CLI 参数作为兼容兜底
- **AND** 不破坏既有超时自动发布策略

### Requirement: Weekly pipeline SHALL auto-publish timeout review version at deadline
系统 SHALL 在周一 12:30（Asia/Shanghai）未完成审核时自动发布当前待审核版本，并标记为超时发布。

#### Scenario: Weekly review times out
- **WHEN** 当前时间超过周一 12:30（Asia/Shanghai）且状态仍未 `approved`
- **THEN** 系统发布当前版本
- **AND** 系统状态标记为 `timeout_published`
- **AND** 产物中记录触发时间与发布原因

### Requirement: Weekly pipeline SHALL support pending report recheck publish
系统 SHALL 支持对已生成的 pending 周报执行复检发布，不重新采集或重排内容，仅刷新审核状态、发布状态和最终产物。

#### Scenario: Pending weekly report is manually approved before deadline during recheck
- **WHEN** 待审核周报存在且指令源显示终稿已通过
- **AND** 当前时间未超过周一 12:30（Asia/Shanghai）
- **THEN** 系统将周报状态更新为 `approved`
- **AND** 系统发布该周报的已审核版本

#### Scenario: Pending weekly report is auto-published at deadline during recheck
- **WHEN** 待审核周报存在且当前时间超过周一 12:30（Asia/Shanghai）
- **AND** 指令源中终稿仍未通过
- **THEN** 系统将周报状态更新为 `timeout_published`
- **AND** 系统发布该周报当前版本并记录超时原因

### Requirement: Weekly pipeline SHALL provide watchdog scan for pending reports
系统 SHALL 提供 watchdog 扫描能力，用于批量检测并处理 pending 周报，以支持定时任务自动触发复检发布；watchdog 执行过程 SHALL 具备单实例互斥、失败重试与结构化摘要输出。

#### Scenario: Watchdog exits when lock is already held
- **WHEN** watchdog 启动时发现 lock 文件已存在
- **THEN** 当前实例不执行扫描与复检
- **AND** 输出锁冲突提示并安全退出

#### Scenario: Watchdog retries transient recheck failure
- **WHEN** 某待处理周报在首次复检时发生可重试错误
- **THEN** watchdog 在配置次数内执行重试
- **AND** 若重试成功则该报告继续按成功路径统计

#### Scenario: Watchdog writes structured summary for monitoring
- **WHEN** watchdog 一次执行完成
- **THEN** 系统在 `outputs/watchdog/weekly/` 写入结构化 summary 文件
- **AND** summary 至少包含 processed、published、skipped、failed 与逐条结果

### Requirement: Weekly pipeline SHALL notify review status via Feishu
系统 SHALL 在周报关键节点向 Feishu 发送通知，包括待审核通知、截止提醒、发布结果回执与主动触发操作回执；通知通道 SHALL 使用飞书应用机器人（app-only）。

#### Scenario: Review callback returns immediate acceptance and async execution notice
- **WHEN** 用户点击审核动作或运维操作卡按钮
- **THEN** 系统立即返回 toast/回执说明“动作已受理并进入后台执行”
- **AND** 后续执行完成后再发送最终状态结果消息

#### Scenario: Mention-driven operation result is reported back to group
- **WHEN** 通过 @机器人触发的后台任务执行完成
- **THEN** 系统向群内发送任务结果回执（success/failed）
- **AND** 回执包含关键上下文（action、reportDate、结果摘要）

### Requirement: Weekly pipeline SHALL execute feedback-driven revision loop
系统 SHALL 支持审核意见回流修订能力，在保留原有待审核快照基础上执行结构化调整，并在修订完成后重新进入终稿审核。

#### Scenario: Execute structured revision directives after request_revision
- **WHEN** 审核人提交 `request_revision` 且包含结构化回流指令
- **THEN** 系统基于当前待审核快照执行候选增删与规则调整
- **AND** 系统输出修订审计摘要
- **AND** 报告状态进入 `final_review`

#### Scenario: Persist global tuning from revision directives
- **WHEN** 回流指令包含来源启停、来源权重或排序权重调整
- **THEN** 系统将该调整写入全局配置存储
- **AND** 后续周期 run 读取并生效

#### Scenario: Keep editor notes as non-executable audit metadata
- **WHEN** 回流指令包含 `editor_notes`
- **THEN** 系统记录该备注到审计日志
- **AND** 不将其作为自动执行动作

### Requirement: Reject action SHALL terminate current run publication attempt
系统 SHALL 在收到 `reject` 动作后终止当前 run 的发布尝试，并要求新建 run 才能重新进入发布流程。

#### Scenario: Recheck/watchdog must not publish rejected run
- **WHEN** 某 reportDate 的当前 run 已被标记为 `rejected`
- **THEN** recheck 与 watchdog 不得继续推进该 run 到 published
- **AND** 系统输出明确的终止原因

#### Scenario: New run can re-enter review flow after reject
- **WHEN** 用户为同一 reportDate 触发新 run（runId 不同）
- **THEN** 系统允许新 run 正常进入审核与发布流程
- **AND** 旧 run 保持可追溯且不被覆盖

### Requirement: Review instruction persistence SHALL be database-backed and append-only
系统 SHALL 将审核动作持久化到数据库事件表，并采用 append-only 语义保存完整动作历史，确保可追溯与可重放。

#### Scenario: Persist review action with full audit metadata
- **WHEN** Feishu 回调或 CLI/API 提交一条审核动作
- **THEN** 系统将动作写入数据库事件表并生成唯一记录
- **AND** 记录至少包含 mode、reportDate、stage、action、decidedAt、source、operator、traceId

#### Scenario: Resolve latest effective action by last-write-wins
- **WHEN** 同一 reportDate 同一 stage 存在多条审核动作
- **THEN** 系统按 decidedAt 最新优先选择有效动作
- **AND** 当 decidedAt 相同，系统按写入序最新记录作为有效动作

### Requirement: Runtime configuration SHALL be versioned with optimistic concurrency control
系统 SHALL 使用版本化存储维护 runtime 配置，并在更新时执行乐观并发控制，避免并发写入覆盖。

#### Scenario: Update runtime config with expected version
- **WHEN** 客户端携带 expectedVersion 提交配置变更
- **AND** expectedVersion 与当前版本一致
- **THEN** 系统创建新版本配置并返回最新 version

#### Scenario: Reject stale runtime config update
- **WHEN** 客户端提交的 expectedVersion 落后于当前版本
- **THEN** 系统返回冲突错误（409）
- **AND** 不写入新版本配置

### Requirement: System SHALL expose minimum review and audit APIs
系统 SHALL 提供最小 API 能力以支持审核协同与运维排查，至少包括审核动作写入/查询、runtime 配置读写、审计事件查询。

#### Scenario: Query latest instruction via API
- **WHEN** 调用方请求某 reportDate 某 stage 的最新审核动作
- **THEN** 系统返回最新有效动作或 null
- **AND** 支持基于 reviewStartedAt 过滤历史动作

#### Scenario: Query audit events by trace identifier
- **WHEN** 调用方按 traceId 查询审计事件
- **THEN** 系统返回该 trace 下的事件列表
- **AND** 事件按时间倒序返回

### Requirement: System SHALL support file-to-database migration with compatibility fallback
系统 SHALL 提供从文件存储迁移到数据库的能力，并在迁移期支持 DB 优先 + 文件 fallback，保证流程可用性。

#### Scenario: Import legacy review instructions from file storage
- **WHEN** 执行迁移命令导入历史审核指令
- **THEN** 系统将可解析记录导入数据库
- **AND** 输出导入统计（成功/失败/跳过）

#### Scenario: Fallback to file storage when database read path is unavailable
- **WHEN** 系统启用 fallback 且数据库读取短时不可用
- **THEN** 系统可从文件路径读取审核信息完成关键流程
- **AND** 系统输出降级告警用于后续排查

### Requirement: Feishu review interaction SHALL provide stage-guided and user-readable experience
系统 SHALL 提供以审核者为中心的飞书交互体验，确保用户可快速理解当前阶段、下一步动作与流程结果。

#### Scenario: Outline stage card shows only relevant actions and guidance
- **WHEN** 周报处于 `outline_review` 阶段
- **THEN** 主卡仅展示大纲阶段相关动作
- **AND** 主卡明确展示“当前状态、下一步建议、截止时间、查看待审核稿链接”

#### Scenario: Final stage card shows only final-review actions
- **WHEN** 周报处于 `final_review` 阶段
- **THEN** 主卡仅展示终稿阶段相关动作
- **AND** 不展示与当前阶段无关的按钮

#### Scenario: Action receipt uses concise business wording
- **WHEN** 用户在飞书点击审核动作且系统处理完成
- **THEN** toast 与群内回执使用业务化短句描述结果
- **AND** 默认不展示 traceId/messageId 等技术字段

#### Scenario: Duplicate callback should not spam group receipts
- **WHEN** 同一审核事件被重复回调且命中幂等判重
- **THEN** 系统返回“重复已忽略”反馈
- **AND** 群内不重复发送同类动作回执

### Requirement: Feishu callback SHALL provide explicit click feedback and status echo
系统 SHALL 在处理飞书卡片点击动作后向点击人提供明确反馈，并向群内输出当前状态回执，避免“点击后无感知”。

#### Scenario: Return success feedback when action is accepted
- **WHEN** 回调请求通过鉴权且审核动作成功写入持久化存储
- **THEN** 系统返回飞书可识别的成功反馈
- **AND** 反馈内容包含 reportDate 与动作类型

#### Scenario: Return failure feedback when action processing fails
- **WHEN** 回调请求鉴权失败或动作写入失败
- **THEN** 系统返回飞书可识别的失败反馈
- **AND** 反馈内容包含失败原因摘要

#### Scenario: Send status echo message to group after click handling
- **WHEN** 系统完成一次点击动作处理（成功或失败）
- **THEN** 系统向飞书群发送状态回执消息
- **AND** 回执至少包含 reportDate、action、operator、result、reviewStage、reviewStatus

#### Scenario: Persist callback handling audit after click action
- **WHEN** 系统处理一次飞书卡片点击动作
- **THEN** 系统记录结构化审计事件
- **AND** 审计事件至少包含 action、result、notifyResult、reportDate

### Requirement: System SHALL support daemon-based continuous automation
系统 SHALL 提供常驻 daemon 运行模式，自动执行报告生成、审核提醒与 watchdog 巡检，无需人工手动触发 CLI。

#### Scenario: Daemon triggers scheduled jobs at configured windows
- **WHEN** daemon 已启动并进入调度循环
- **THEN** 系统在配置时间自动触发 daily/weekly/reminder/watchdog 任务
- **AND** 每个任务执行结果可被记录与查询

#### Scenario: Daemon performs compensation scan after restart
- **WHEN** daemon 重启或从休眠恢复
- **THEN** 系统执行补偿扫描以处理错过的关键时间窗口
- **AND** 不重复执行已完成且无变更价值的任务

### Requirement: System SHALL support manual operations via Feishu mention and operation card
系统 SHALL 支持在 Feishu 群内通过 @应用机器人获取主动触发操作卡，并通过卡片按钮触发常见运维动作。

#### Scenario: Mention bot returns operation card
- **WHEN** 用户在群内 @应用机器人并触发运维指令
- **THEN** 系统返回包含常见操作按钮的运维卡片
- **AND** 卡片至少支持日报/周报 run、recheck、watchdog、reminder、status 查询

#### Scenario: Operation card click enqueues async job
- **WHEN** 用户点击运维卡片中的某个动作按钮
- **THEN** 系统先返回“已接收”反馈并创建 operation job
- **AND** 由后台 worker 异步执行该任务并回执最终结果

#### Scenario: Manual daily run action is available in operation card
- **WHEN** 用户打开运维操作卡
- **THEN** 卡片包含 `run_daily` 动作入口（生成日报）
- **AND** 该动作沿用“入队异步执行 + 回执”流程

### Requirement: System SHALL auto-trigger recheck after accepted review action callback
系统 SHALL 在审核动作回调成功写入后自动触发对应 recheck 流程，避免人工补执行命令。

#### Scenario: Approve outline callback auto advances to final review
- **WHEN** 回调写入 `approve_outline` 且动作受理成功
- **THEN** 系统自动触发该 reportDate 的 recheck job
- **AND** 周报状态推进到 `final_review`（若无冲突动作）

#### Scenario: Approve final callback auto publishes after recheck
- **WHEN** 回调写入 `approve_final` 且动作受理成功
- **THEN** 系统自动触发 recheck job
- **AND** 在发布条件满足时完成发布并输出发布回执

### Requirement: System SHALL auto-sync report artifacts and review state to Git repository
系统 SHALL 支持把关键报告产物与审核状态文件自动同步到 Git 仓库，以保障远程可读与可审阅。

#### Scenario: Auto commit and push when tracked artifacts changed
- **WHEN** 待审核/已发布/审核指令/runtime config 在受控路径产生变更
- **THEN** 系统自动执行 add/commit/push
- **AND** commit 信息包含 reportDate、runId 或触发来源等可追踪字段

#### Scenario: Skip git sync when no tracked changes
- **WHEN** 受控路径没有文件内容变更
- **THEN** 系统跳过 commit/push
- **AND** 不产生空提交

#### Scenario: Push supports optional proxy environment injection
- **WHEN** 配置 `GIT_PUSH_HTTP_PROXY` 或 `GIT_PUSH_HTTPS_PROXY`
- **THEN** 系统在 push 阶段注入代理环境变量
- **AND** 未配置时保持默认网络行为不变

### Requirement: System SHALL provide macOS bootstrap for first-time setup
系统 SHALL 提供 macOS 首次初始化命令，用于在新电脑上自动检查与补齐本地运行所需条件，输出可执行的修复建议，降低接入门槛与人工遗漏风险。

#### Scenario: Bootstrap validates local prerequisites and reports actionable result
- **WHEN** 用户执行 `setup:macos` 初始化命令
- **THEN** 系统检查 Node/pnpm/cloudflared/sqlite3 与关键环境变量
- **AND** 系统以结构化方式输出 pass/fail 项与对应修复命令

#### Scenario: Bootstrap prepares local cloudflared runtime config from template
- **WHEN** 本地缺失 `~/.cloudflared/config.yml` 或配置不完整
- **THEN** 系统基于仓库模板生成或更新本机配置文件
- **AND** 系统不将 credentials 与敏感值写入仓库

#### Scenario: Bootstrap warns single-active-host constraint
- **WHEN** 用户准备在新电脑启用长期运行模式
- **THEN** 系统提示当前阶段为单机活跃模型
- **AND** 明确告知多机同时运行可能造成重复调度与重复通知

### Requirement: System SHALL provide one-command service lifecycle management on macOS
系统 SHALL 提供一键化服务生命周期管理能力，以托管 daemon 与 Named Tunnel 双服务，避免手工开启多个终端。

#### Scenario: Up command starts daemon and named tunnel idempotently
- **WHEN** 用户执行 `up` 命令
- **THEN** 系统安装或更新 launchd 服务定义并启动 daemon 与 tunnel
- **AND** 重复执行 `up` 不会重复注册或破坏已有健康服务

#### Scenario: Status command reports service and health summary
- **WHEN** 用户执行 `status` 命令
- **THEN** 系统输出 daemon/tunnel 的运行状态摘要
- **AND** 同时输出本地 `/health` 与公网 callback health 检查结果

#### Scenario: Down and restart commands manage both services consistently
- **WHEN** 用户执行 `down` 或 `restart` 命令
- **THEN** 系统对 daemon 与 tunnel 双服务执行一致的停止或重启操作
- **AND** 操作结果可在后续 `status` 中验证

### Requirement: Stable callback endpoint mode SHALL be explicit and preferred for long-running usage
系统 SHALL 将 Named Tunnel 固定域名模式定义为长期运行推荐模式，并保留 Quick Tunnel 作为临时调试模式且显式提示其 URL 非稳定特性。

#### Scenario: Stable mode keeps callback URL unchanged after process restart
- **WHEN** 用户使用 Named Tunnel 固定域名模式并重启本地进程
- **THEN** 回调 URL 保持不变
- **AND** 无需重新修改飞书后台回调地址

#### Scenario: Debug quick tunnel mode warns URL volatility
- **WHEN** 用户执行 Quick Tunnel 调试命令（如 `feishu:tunnel`）
- **THEN** 系统提示该模式 URL 可能变化，仅适用于临时联调
- **AND** 引导用户使用 stable 模式作为日常运行方式

### Requirement: Pipeline SHALL support item-wise LLM summarization for both daily and weekly reports
系统 SHALL 在 `daily` 与 `weekly` 两种模式下启用 LLM 总结节点，并采用“逐条总结 + 聚合重点”策略，禁止将全部候选内容一次性作为单个 prompt 输入。

#### Scenario: Item-wise summarization is executed instead of one-shot full-batch prompt
- **WHEN** 流水线进入 LLM 总结阶段且存在候选条目
- **THEN** 系统按条目粒度生成结构化摘要结果（可并发但逻辑独立）
- **AND** 不将全量候选正文拼接为单个超长 prompt 做一次性总结

#### Scenario: Quick digest count is adaptive within 4-12
- **WHEN** 系统基于逐条摘要生成顶部快速重点
- **THEN** 输出条目数在 `4-12` 区间内自适应
- **AND** 条目数量随候选规模变化而调整

#### Scenario: Daily mode also receives LLM summary enhancement
- **WHEN** 用户执行 `daily` 报告流程
- **THEN** 系统同样执行 LLM 总结节点
- **AND** 在报告中输出快速重点与结构化摘要（或回退结果）

### Requirement: LLM summary provider SHALL use MiniMax first with strict fallback safety
系统 SHALL 优先支持 MiniMax 作为 M5.1 的首发 provider，并在调用失败、超时、解析失败或证据校验失败时自动回退到规则摘要，且不得阻断审核与发布主流程。

#### Scenario: MiniMax summary succeeds
- **WHEN** MiniMax 配置完整且调用成功
- **THEN** 报告优先使用 LLM 生成的摘要内容
- **AND** 审计记录包含 provider/model/promptVersion/耗时等元信息

#### Scenario: LLM failure triggers non-blocking fallback
- **WHEN** MiniMax 调用异常、超时、响应不合法或证据校验失败
- **THEN** 系统自动回退到规则摘要并继续完成 run/recheck/watchdog 后续流程
- **AND** 不因 LLM 失败导致 pending/review/publish 状态机中断

### Requirement: LLM output SHALL be evidence-bound and auditable
系统 SHALL 对 LLM 输出执行结构化校验与证据绑定校验，确保摘要结论可追溯到本次输入条目，并将关键执行状态写入审计存储。

#### Scenario: Evidence validation rejects unsupported claims
- **WHEN** 某条 LLM 摘要引用的 evidenceItemId 不存在于本次 `rankedItems`
- **THEN** 该次 LLM 输出判定为无效并触发回退
- **AND** 审计中记录失败类型为证据校验失败

#### Scenario: Audit trail records full LLM summary lifecycle
- **WHEN** 一次 LLM 总结执行完成（成功或失败）
- **THEN** 系统写入 started/completed/fallback 审计事件
- **AND** 事件可按 runId/reportDate 追溯

### Requirement: System SHALL send one merged Feishu alert for LLM fallback per run
系统 SHALL 在单次 run 出现 LLM 降级时发送飞书告警，但按 run 维度合并为 1 条，避免重复刷屏。

#### Scenario: Multiple fallback errors in one run produce one merged alert
- **WHEN** 同一 run 内出现多次 LLM 失败或回退事件
- **THEN** 系统只发送 1 条合并告警到飞书
- **AND** 告警包含 runId/reportDate/降级原因摘要

#### Scenario: No alert when LLM completes successfully
- **WHEN** 同一 run 的 LLM 总结链路未触发回退
- **THEN** 系统不发送降级告警
- **AND** 飞书仅保留常规审核/发布通知

### Requirement: Pipeline SHALL enforce provider-safe global LLM concurrency
系统 SHALL 在所有 LLM 节点执行期间施加全局并发上限，默认值为 2（可配置），并确保任意节点的本地并发不超过全局上限，以降低 provider 限流与失败抖动。

#### Scenario: Node concurrency is capped by global limit
- **WHEN** 某 LLM 节点配置并发大于全局并发上限
- **THEN** 系统实际并发取 `min(节点并发, 全局并发)`
- **AND** 运行元数据中可看到生效并发值

#### Scenario: Global default concurrency applies when config is missing
- **WHEN** 未显式配置全局并发上限
- **THEN** 系统采用默认值 `2`
- **AND** 节点并发仍受该默认值约束

#### Scenario: Multiple LLM steps do not exceed global concurrency budget
- **WHEN** 同一 run 内存在多个 LLM 子步骤连续执行
- **THEN** 系统仍遵守全局并发预算
- **AND** 不出现因并发叠加导致的无限放大请求

### Requirement: Pipeline SHALL support LLM-assisted tagging and ranking fusion with safe fallback
系统 SHALL 在排序前通过批量 LLM 节点为全量条目提供分类与打分辅助，并使用可配置融合策略生成最终排序；摘要节点 SHALL 不再承担打分职责。当 LLM 输出异常或置信度不足时，系统 SHALL 回退规则 baseline 且不阻断主流程。

#### Scenario: Batch classify-score returns structured results for multiple items
- **WHEN** 系统执行 `llm_classify_score` 阶段
- **THEN** 每个批次返回多条 item 结构化结果（itemId、category、confidence、llmScore、reason）
- **AND** 输出可稳定映射回原条目

#### Scenario: Final ranking score is fused from rule and pre-rank LLM scores
- **WHEN** item 同时具备规则分与有效前置 LLM 分
- **THEN** 系统按配置权重（默认 `fusionWeight=0.65`）计算融合分并重排
- **AND** 该融合结果覆盖全量候选条目

#### Scenario: Summarize node does not perform scoring
- **WHEN** 流水线进入 `llm_summarize` 阶段
- **THEN** 节点仅生成摘要/导语/翻译/导读能力
- **AND** 不再修改条目打分与排序融合结果

### Requirement: Pipeline SHALL provide lead summary for report readability with non-blocking fallback
系统 SHALL 为每期报告生成“本期导语”区块（2-3 句），用于概括重点趋势；导语生成失败时 SHALL 回退到模板导语，不得阻断报告生成。

#### Scenario: Lead summary is generated from top signals
- **WHEN** 流水线进入报告渲染前阶段
- **THEN** 系统基于速览与高分条目生成导语
- **AND** 导语可在报告顶部稳定展示

#### Scenario: Lead generation failure uses template fallback
- **WHEN** 导语生成调用失败或输出不合法
- **THEN** 系统自动使用模板导语
- **AND** 报告仍按原流程输出

### Requirement: Pipeline SHALL provide Chinese title translation for English headlines
系统 SHALL 对英文标题提供中文翻译字段，并在报告中优先展示中文标题（附原标题）；翻译失败时 SHALL 回退原标题。

#### Scenario: English headline is rendered with Chinese title and original title
- **WHEN** 条目标题判定为英文或中英混合且翻译成功
- **THEN** 报告显示“中文标题（Original Title）”
- **AND** 保留原始链接与证据追溯能力

#### Scenario: Translation failure falls back to original title
- **WHEN** 标题翻译失败或结果不合法
- **THEN** 报告直接展示原标题
- **AND** 不影响排序、审核与发布流程

### Requirement: Pipeline SHALL apply adaptive load shedding for clustered missing_content failures
系统 SHALL 在 LLM item-wise 执行过程中监控短窗口失败模式；当 `missing_content` 失败出现簇状增长时，系统 SHALL 自动触发临时降载并优先重试失败条目，以降低失败扩散。

#### Scenario: Clustered missing_content failures trigger temporary degrade mode
- **WHEN** 短窗口内 `missing_content` 失败占比或连续失败次数达到阈值
- **THEN** 系统进入临时降载模式（降低并发预算）
- **AND** 对失败条目优先执行补偿重试

#### Scenario: Adaptive degrade mode recovers after stability returns
- **WHEN** 降载模式下短窗口成功率恢复到阈值以上
- **THEN** 系统自动恢复到配置并发预算
- **AND** 记录本次恢复事件用于后续诊断

#### Scenario: Adaptive strategy failure still keeps pipeline non-blocking
- **WHEN** 自适应降载与补偿重试后仍存在不可恢复错误
- **THEN** 系统继续执行既有回退策略（条目级或全局回退）
- **AND** 不阻断审核与发布主流程

### Requirement: Pipeline SHALL expose run-level LLM diagnostics for operations
系统 SHALL 为每次 run 输出可操作的 LLM 诊断信息，至少覆盖失败分类、重试统计、生效并发、自适应降载触发/恢复信息，便于快速定位问题主因。

#### Scenario: Diagnostics are persisted in artifact metadata
- **WHEN** run 完成并写入结构化产物
- **THEN** `llmSummaryMeta` 包含失败分类、重试统计与自适应降载统计
- **AND** 历史产物缺失新字段时读取路径保持兼容

#### Scenario: Diagnostics are visible in warning output
- **WHEN** LLM 过程中出现失败、重试或降载
- **THEN** warning 输出包含可读的分类统计与降载摘要
- **AND** 运维可以据此判断主要问题类型（timeout/http/missing_content/parse/quality）

### Requirement: Pipeline SHALL provide category lead summaries for report readability with non-blocking fallback
系统 SHALL 在报告中为主要分类提供“分类导读”区块，帮助用户在进入分类正文前快速理解该类重点；导读生成失败时 SHALL 使用模板导读回退。

#### Scenario: Category lead summary is generated for major categories
- **WHEN** 报告进入渲染阶段且分类正文存在内容
- **THEN** 系统为主要分类生成 1 句导读并展示在对应正文前
- **AND** 导读内容与该分类 Top 条目主题一致

#### Scenario: Category lead summary falls back to template on failure
- **WHEN** 分类导读生成失败或输出不合法
- **THEN** 系统使用模板导读文案
- **AND** 报告仍按原流程产出且不阻断审核/发布

### Requirement: Pipeline SHALL support batch retry and split-degrade for classify-score stability
系统 SHALL 对前置批量分类打分实现分层容错：批次重试、拆批降级、单条回退，保证主流程稳定。

#### Scenario: Batch request retries once before split
- **WHEN** 某批次 classify-score 请求失败
- **THEN** 系统先对该批次重试一次
- **AND** 若重试成功则继续后续流程

#### Scenario: Failed batch degrades by split and eventually falls back per item
- **WHEN** 批次重试后仍失败
- **THEN** 系统执行二分拆批重试
- **AND** 最终对仍失败的单条执行规则回退并继续流程

### Requirement: Pipeline SHALL enforce few-shot constrained JSON output for classify-score
系统 SHALL 在分类打分提示词中使用 few-shot 示例，并要求模型返回 JSON-only 结构化结果，以降低解析失败率。

#### Scenario: Few-shot prompt increases format compliance
- **WHEN** 系统构建 classify-score 请求提示词
- **THEN** 提示词包含正例 few-shot 与字段约束
- **AND** 模型返回结果可通过结构校验

#### Scenario: Invalid format triggers retry path
- **WHEN** 模型返回非 JSON 或字段缺失
- **THEN** 系统按重试/拆批策略处理
- **AND** 不因单批格式异常中断整体运行

### Requirement: Pipeline SHALL support GitHub Search as a first-party source adapter
系统 SHALL 支持 `github_search` 来源类型，用于采集 GitHub 热门/高价值开源仓库，并将结果统一映射到报告候选条目。

#### Scenario: Collect repositories from GitHub Search with token
- **WHEN** 来源配置包含已启用的 `github_search`，且环境中存在 `GITHUB_TOKEN`
- **THEN** 系统向 GitHub Search API 发起带鉴权的请求并采集仓库条目
- **AND** 每条结果至少包含仓库名、链接、简要描述与更新时间上下文

#### Scenario: Continue run when GitHub source hits transient failure
- **WHEN** GitHub Search 请求发生超时、5xx 或可重试网络错误
- **THEN** 系统记录该来源 warning
- **AND** 系统继续处理其他来源并完成本次报告生成

#### Scenario: Handle rate-limit or auth failure as warning
- **WHEN** GitHub Search 返回限流或鉴权相关错误（如 403/429）
- **THEN** 系统输出可读 warning（包含来源与错误摘要）
- **AND** 不中断主流程

### Requirement: Source configuration SHALL support mixed adapters with backward compatibility
系统 SHALL 支持 `rss` 与 `github_search` 混合来源配置，并保持现有 `rss` 配置文件可直接复用。

#### Scenario: Existing RSS-only configuration remains valid
- **WHEN** 配置文件仅包含 `rss` 来源
- **THEN** 系统行为与升级前保持一致
- **AND** 不要求用户补充 GitHub 相关字段

#### Scenario: Mixed source configuration is loaded and executed
- **WHEN** 配置文件同时包含 `rss` 与 `github_search` 来源
- **THEN** 系统按来源类型分别调用对应采集器
- **AND** 最终聚合结果进入统一后续处理链路

### Requirement: Source diagnose SHALL cover mixed source health checks
系统 SHALL 在 `source:diagnose` 中覆盖混合来源健康检查，并对 GitHub 相关配置缺失或限流风险提供明确提示。

#### Scenario: Diagnose reports github token advisory when missing
- **WHEN** 诊断期间发现启用了 `github_search` 且未配置 `GITHUB_TOKEN`
- **THEN** 系统输出“可运行但限流风险较高”的提示
- **AND** 诊断流程继续执行

#### Scenario: Diagnose surfaces per-source failure details
- **WHEN** 任一 `rss` 或 `github_search` 来源抓取失败
- **THEN** 诊断输出按来源列出失败项与错误摘要
- **AND** 用户可据此快速调整 `data/sources.yaml` 或环境配置

