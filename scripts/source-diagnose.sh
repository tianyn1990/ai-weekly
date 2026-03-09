#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

TIMEZONE="${TIMEZONE:-Asia/Shanghai}"
MODE="${MODE:-weekly}"
REPORT_DATE="${REPORT_DATE:-$(TZ=${TIMEZONE} date +%F)}"
GENERATED_AT="${GENERATED_AT:-${REPORT_DATE}T01:00:00.000Z}"
BASE_ENV_FILE="${AI_WEEKLY_ENV_FILE:-${ROOT_DIR}/.env.local}"
DIAG_ENV_FILE="${DIAG_ENV_FILE:-/tmp/ai-weekly-source-diagnose.env}"
LOG_FILE="${LOG_FILE:-/tmp/ai-weekly-source-diagnose.log}"
FAIL_ON_WARNING="${SOURCE_DIAG_FAIL_ON_WARNING:-false}"

if [[ "${MODE}" != "daily" && "${MODE}" != "weekly" ]]; then
  echo "[source-diagnose-error] MODE 仅支持 daily 或 weekly，当前=${MODE}" >&2
  exit 1
fi

if [[ ! -f "${BASE_ENV_FILE}" ]]; then
  echo "[source-diagnose-error] 环境文件不存在: ${BASE_ENV_FILE}" >&2
  echo "[source-diagnose-tip] 请先执行: cp .env.local.example .env.local" >&2
  exit 1
fi

# 诊断模式固定关闭 LLM、飞书通知和自动 git 同步，避免把非采集问题混入结果。
awk '
/^LLM_SUMMARY_ENABLED=/{print "LLM_SUMMARY_ENABLED=\"false\"";next}
/^AUTO_GIT_SYNC=/{print "AUTO_GIT_SYNC=\"false\"";next}
/^GIT_SYNC_PUSH=/{print "GIT_SYNC_PUSH=\"false\"";next}
/^FEISHU_APP_ID=/{print "FEISHU_APP_ID=\"\"";next}
/^FEISHU_APP_SECRET=/{print "FEISHU_APP_SECRET=\"\"";next}
/^REVIEW_CHAT_ID=/{print "REVIEW_CHAT_ID=\"\"";next}
/^FEISHU_WEBHOOK_URL=/{print "FEISHU_WEBHOOK_URL=\"\"";next}
{print}
' "${BASE_ENV_FILE}" > "${DIAG_ENV_FILE}"

echo "[source-diagnose] env=${DIAG_ENV_FILE}"
echo "[source-diagnose] mode=${MODE}, reportDate=${REPORT_DATE}, generatedAt=${GENERATED_AT}"
echo "[source-diagnose] run pipeline with mock=false ..."

AI_WEEKLY_ENV_FILE="${DIAG_ENV_FILE}" \
  npx tsx src/cli.ts run --mode "${MODE}" --report-date "${REPORT_DATE}" --generated-at "${GENERATED_AT}" 2>&1 | tee "${LOG_FILE}"

echo "[source-diagnose] log=${LOG_FILE}"
echo "[source-diagnose] failed sources:"

if command -v rg >/dev/null 2>&1; then
  FAILED_LINES="$(rg "^- \\[.+\\] 抓取失败:" "${LOG_FILE}" || true)"
else
  FAILED_LINES="$(grep -E "^- \\[.+\\] 抓取失败:" "${LOG_FILE}" || true)"
fi

if [[ -z "${FAILED_LINES}" ]]; then
  echo "  (none)"
  echo "[source-diagnose-ok] 采集链路健康。"
  exit 0
fi

echo "${FAILED_LINES}"
echo "[source-diagnose-warning] 检测到抓取失败来源，请检查 data/sources.yaml（URL/可访问性）并重试。"

if [[ "${FAIL_ON_WARNING}" == "true" ]]; then
  exit 2
fi

