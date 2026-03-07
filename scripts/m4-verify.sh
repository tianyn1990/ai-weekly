#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

# 可通过环境变量覆盖。默认自动生成 9xxx 年随机日期，最大化规避历史数据冲突。
if [[ -z "${REPORT_DATE:-}" ]]; then
  seed="$(( $(date +%s) + $$ + RANDOM ))"
  year="$((9000 + (seed % 1000)))"
  month="$(printf "%02d" $((seed % 12 + 1)))"
  day="$(printf "%02d" $(((seed / 12) % 28 + 1)))"
  REPORT_DATE="${year}-${month}-${day}"
fi
GENERATED_AT_INIT="${GENERATED_AT_INIT:-${REPORT_DATE}T01:00:00.000Z}"
GENERATED_AT_RECHECK1="${GENERATED_AT_RECHECK1:-${REPORT_DATE}T01:20:00.000Z}"
GENERATED_AT_RECHECK2="${GENERATED_AT_RECHECK2:-${REPORT_DATE}T01:40:00.000Z}"
API_HOST="${REVIEW_API_HOST:-127.0.0.1}"
API_PORT="${REVIEW_API_PORT:-8790}"
API_TOKEN="${REVIEW_API_AUTH_TOKEN:-demo-token}"
DB_PATH="${STORAGE_DB_PATH:-outputs/db/app.sqlite}"
BACKEND="${STORAGE_BACKEND:-db}"

contains_text() {
  local pattern="$1"
  local file="$2"
  if command -v rg >/dev/null 2>&1; then
    rg -q "${pattern}" "${file}"
    return $?
  fi
  grep -q "${pattern}" "${file}"
}

if [[ "${BACKEND}" != "db" ]]; then
  echo "[m4-verify-error] STORAGE_BACKEND 必须为 db，当前=${BACKEND}" >&2
  exit 1
fi

echo "[m4-verify] 0) 构建与测试基线"
pnpm build >/dev/null
pnpm test >/dev/null

echo "[m4-verify] 1) 执行文件到 DB 迁移（可重复执行）"
npx tsx src/cli.ts run --migrate-file-to-db --storage-backend db --storage-db-path "${DB_PATH}" || true

echo "[m4-verify] 2) 生成待审核周报（DB 模式）"
npx tsx src/cli.ts run \
  --mode weekly \
  --mock \
  --storage-backend db \
  --storage-db-path "${DB_PATH}" \
  --report-date "${REPORT_DATE}" \
  --generated-at "${GENERATED_AT_INIT}" >/tmp/m4-verify-run-init.log

API_PID=""
cleanup() {
  if [[ -n "${API_PID}" ]] && kill -0 "${API_PID}" 2>/dev/null; then
    kill "${API_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "[m4-verify] 3) 启动 Review API"
(
  REVIEW_API_AUTH_TOKEN="${API_TOKEN}" \
  npx tsx src/cli.ts run \
    --serve-review-api \
    --review-api-host "${API_HOST}" \
    --review-api-port "${API_PORT}" \
    --storage-backend db \
    --storage-db-path "${DB_PATH}" \
    --review-api-auth-token "${API_TOKEN}"
) >/tmp/m4-verify-api.log 2>&1 &
API_PID=$!

echo "[m4-verify] 4) 等待 API 健康检查"
for _ in $(seq 1 60); do
  if curl -fsS "http://${API_HOST}:${API_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
curl -fsS "http://${API_HOST}:${API_PORT}/health" >/dev/null

echo "[m4-verify] 5) 写入大纲通过动作"
curl -fsS -X POST "http://${API_HOST}:${API_PORT}/api/review-actions" \
  -H "Authorization: Bearer ${API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"mode\":\"weekly\",\"reportDate\":\"${REPORT_DATE}\",\"stage\":\"outline_review\",\"action\":\"approve_outline\",\"decidedAt\":\"${REPORT_DATE}T01:10:00.000Z\",\"source\":\"api\",\"operator\":\"m4-verify\"}" >/dev/null

echo "[m4-verify] 6) recheck #1（应进入 final_review）"
npx tsx src/cli.ts run \
  --mode weekly \
  --recheck-pending \
  --storage-backend db \
  --storage-db-path "${DB_PATH}" \
  --report-date "${REPORT_DATE}" \
  --generated-at "${GENERATED_AT_RECHECK1}" >/tmp/m4-verify-recheck-1.log

if ! contains_text "stage=final_review" /tmp/m4-verify-recheck-1.log; then
  echo "[m4-verify-error] recheck #1 未进入 final_review" >&2
  cat /tmp/m4-verify-recheck-1.log >&2
  exit 1
fi

echo "[m4-verify] 7) 写入终稿通过动作"
curl -fsS -X POST "http://${API_HOST}:${API_PORT}/api/review-actions" \
  -H "Authorization: Bearer ${API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"mode\":\"weekly\",\"reportDate\":\"${REPORT_DATE}\",\"stage\":\"final_review\",\"action\":\"approve_final\",\"decidedAt\":\"${REPORT_DATE}T01:30:00.000Z\",\"source\":\"api\",\"operator\":\"m4-verify\"}" >/dev/null

echo "[m4-verify] 8) recheck #2（应发布）"
npx tsx src/cli.ts run \
  --mode weekly \
  --recheck-pending \
  --storage-backend db \
  --storage-db-path "${DB_PATH}" \
  --report-date "${REPORT_DATE}" \
  --generated-at "${GENERATED_AT_RECHECK2}" >/tmp/m4-verify-recheck-2.log

if ! contains_text "review=approved" /tmp/m4-verify-recheck-2.log; then
  echo "[m4-verify-error] recheck #2 未达到 approved" >&2
  cat /tmp/m4-verify-recheck-2.log >&2
  exit 1
fi

if ! test -f "outputs/published/weekly/${REPORT_DATE}.md"; then
  echo "[m4-verify-error] 发布产物缺失 outputs/published/weekly/${REPORT_DATE}.md" >&2
  exit 1
fi

echo "[m4-verify] 9) 查询 latest action 与 audit events"
LATEST="$(curl -fsS -H "Authorization: Bearer ${API_TOKEN}" "http://${API_HOST}:${API_PORT}/api/review-actions/latest?mode=weekly&reportDate=${REPORT_DATE}&stage=final_review")"
AUDIT="$(curl -fsS -H "Authorization: Bearer ${API_TOKEN}" "http://${API_HOST}:${API_PORT}/api/audit-events?limit=5")"

if [[ "${LATEST}" != *"approve_final"* ]]; then
  echo "[m4-verify-error] latest action 查询结果异常: ${LATEST}" >&2
  exit 1
fi
if [[ "${AUDIT}" != *"review_instruction_appended"* ]]; then
  echo "[m4-verify-error] audit events 查询结果异常: ${AUDIT}" >&2
  exit 1
fi

echo "[m4-verify-ok] M4 DB/API 核心链路验证通过。"
echo "[m4-verify-ok] published=outputs/published/weekly/${REPORT_DATE}.md"
echo "[m4-verify-ok] db=${DB_PATH}"
