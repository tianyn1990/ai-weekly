## 1. 规格与设计
- [x] 1.1 明确 Feishu 通知/回调的数据契约与鉴权方式。
- [x] 1.2 明确回调接入形态（2B：本地服务 + 隧道）与联调边界。
- [x] 1.4 明确审核权限与冲突处理策略（群内任意成员 + last-write-wins）。
- [x] 1.5 明确提醒策略（周一 11:30 单次提醒）与 M3.3 待补范围。

## 2. 工程实现
- [x] 2.1 接入 Feishu 通知发送器（待审核通知/截止提醒/发布结果）。
- [x] 2.2 接入 Feishu 审核动作回写（approve/request_revision/reject）。
- [x] 2.3 实现 Feishu 原生 payload 适配（challenge、action value/form_value、字段别名兼容）。
- [x] 2.4 增强回调鉴权与路由匹配（Bearer/query/header token + pathname 匹配）。
- [x] 2.5 增加 Feishu 不可用时的 CLI fallback 兜底路径。
- [x] 2.6 增加联调自动化工具（tenant token、chat 列表、interactive 卡片发送）。

## 3. 测试与文档
- [x] 3.1 补充单测：回调动作解析、last-write-wins、Feishu 不可用 fallback、自动化工具参数与输出。
- [x] 3.2 更新 `README.md` 与 `docs/architecture.md`。
- [x] 3.3 新增 M3.2 学习材料（流程图 + 源码导读 + 已填写复盘模板）。
- [x] 3.4 执行并记录验证：`pnpm test`、`pnpm build`、`openspec validate --specs --strict`。
