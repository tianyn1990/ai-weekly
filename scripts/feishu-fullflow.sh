#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

TIMEZONE="${TIMEZONE:-Asia/Shanghai}"
REPORT_DATE="${REPORT_DATE:-$(TZ=${TIMEZONE} date +%F)}"
MODE="${MODE:-weekly}"
STORAGE_BACKEND="${STORAGE_BACKEND:-db}"
STORAGE_DB_PATH="${STORAGE_DB_PATH:-outputs/db/app.sqlite}"
CALLBACK_HOST="${FEISHU_CALLBACK_HOST:-127.0.0.1}"
CALLBACK_PORT="${FEISHU_CALLBACK_PORT:-8787}"
CALLBACK_HEALTH_URL="http://${CALLBACK_HOST}:${CALLBACK_PORT}/health"

required_env=(
  FEISHU_APP_ID
  FEISHU_APP_SECRET
  REVIEW_CHAT_ID
)

for name in "${required_env[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "[feishu-fullflow-error] 缺少环境变量: ${name}" >&2
    exit 1
  fi
done

if [[ "${MODE}" != "weekly" ]]; then
  echo "[feishu-fullflow-error] 仅支持 weekly 模式，当前 MODE=${MODE}" >&2
  exit 1
fi

echo "[feishu-fullflow] reportDate=${REPORT_DATE}"
echo "[feishu-fullflow] 1) 检查回调服务健康状态"
if ! curl -fsS "${CALLBACK_HEALTH_URL}" >/dev/null 2>&1; then
  echo "[feishu-fullflow-error] 回调服务不可用: ${CALLBACK_HEALTH_URL}" >&2
  echo "[feishu-fullflow-tip] 请先在另一终端启动: pnpm run feishu:dev" >&2
  exit 1
fi

echo "[feishu-fullflow] 2) 生成待审核周报（DB 模式）"
npx tsx src/cli.ts run \
  --mode weekly \
  --mock \
  --storage-backend "${STORAGE_BACKEND}" \
  --storage-db-path "${STORAGE_DB_PATH}" \
  --report-date "${REPORT_DATE}"

echo "[feishu-fullflow] 3) 请在飞书主审核卡中点击【大纲通过】"
read -r -p "点击完成后按 Enter 继续..."

echo "[feishu-fullflow] 4) recheck #1（预期进入 final_review，并更新主卡为终稿阶段）"
npx tsx src/cli.ts run \
  --mode weekly \
  --recheck-pending \
  --storage-backend "${STORAGE_BACKEND}" \
  --storage-db-path "${STORAGE_DB_PATH}" \
  --report-date "${REPORT_DATE}"

echo "[feishu-fullflow-ok] 请在飞书主审核卡点击【终稿通过并发布】。"
read -r -p "点击完成后按 Enter 继续..."

echo "[feishu-fullflow] 5) recheck #2（预期发布）"
npx tsx src/cli.ts run \
  --mode weekly \
  --recheck-pending \
  --storage-backend "${STORAGE_BACKEND}" \
  --storage-db-path "${STORAGE_DB_PATH}" \
  --report-date "${REPORT_DATE}"

echo "[feishu-fullflow] 6) 输出关键状态与最近审核动作"
node --input-type=module <<'NODE'
import fs from "node:fs";
const reportDate = process.env.REPORT_DATE;
const filePath = `outputs/review/weekly/${reportDate}.json`;
if (fs.existsSync(filePath)) {
  const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
  console.log("[feishu-fullflow-status]", JSON.stringify({
    reportDate: json.reportDate,
    reviewStatus: json.reviewStatus,
    reviewStage: json.reviewStage,
    publishStatus: json.publishStatus,
    shouldPublish: json.shouldPublish,
    publishReason: json.publishReason
  }, null, 2));
} else {
  console.log(`[feishu-fullflow-warning] missing review artifact: ${filePath}`);
}
NODE

sqlite3 "${STORAGE_DB_PATH}" \
  "SELECT id, report_date, stage, action, source, operator, decided_at FROM review_instructions WHERE report_date='${REPORT_DATE}' ORDER BY id DESC LIMIT 10;"

echo "[feishu-fullflow-done] 完整链路执行完成。"
