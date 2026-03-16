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

# 若启用了 github_search 且未配置 token，提前给出诊断建议，避免用户误以为“偶发失败”。
HAS_GITHUB_SEARCH_ENABLED="$(
  node -e 'const fs=require("fs");const YAML=require("yaml");const list=YAML.parse(fs.readFileSync("data/sources.yaml","utf8"))||[];process.stdout.write(list.some((s)=>s && s.enabled && s.type==="github_search")?"1":"0");'
)"
HAS_GITHUB_TOKEN="$(
  DIAG_ENV_FILE="${DIAG_ENV_FILE}" node - <<'NODE'
const fs = require("fs");
const filePath = process.env.DIAG_ENV_FILE;
const content = fs.readFileSync(filePath, "utf8");
const lines = content.split(/\r?\n/);
let tokenFromFile = "";
for (const rawLine of lines) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const index = line.indexOf("=");
  if (index <= 0) continue;
  const key = line.slice(0, index).trim();
  if (key !== "GITHUB_TOKEN") continue;
  const valueRaw = line.slice(index + 1).trim();
  if (valueRaw.startsWith("\"")) {
    const end = valueRaw.indexOf("\"", 1);
    tokenFromFile = end > 0 ? valueRaw.slice(1, end).trim() : valueRaw.trim();
  } else if (valueRaw.startsWith("'")) {
    const end = valueRaw.indexOf("'", 1);
    tokenFromFile = end > 0 ? valueRaw.slice(1, end).trim() : valueRaw.trim();
  } else {
    tokenFromFile = valueRaw.split(" #")[0].trim();
  }
  break;
}
const tokenFromEnv = (process.env.GITHUB_TOKEN || "").trim();
process.stdout.write(tokenFromFile || tokenFromEnv ? "1" : "0");
NODE
)"

echo "[source-diagnose] env=${DIAG_ENV_FILE}"
echo "[source-diagnose] mode=${MODE}, reportDate=${REPORT_DATE}, generatedAt=${GENERATED_AT}"
if [[ "${HAS_GITHUB_SEARCH_ENABLED}" == "1" && "${HAS_GITHUB_TOKEN}" != "1" ]]; then
  echo "[source-diagnose-advice] 检测到已启用 github_search，但未配置 GITHUB_TOKEN；可运行但更容易触发限流。"
fi
echo "[source-diagnose] run pipeline with mock=false ..."

AI_WEEKLY_ENV_FILE="${DIAG_ENV_FILE}" \
  npx tsx src/cli.ts run --mode "${MODE}" --report-date "${REPORT_DATE}" --generated-at "${GENERATED_AT}" 2>&1 | tee "${LOG_FILE}"

echo "[source-diagnose] log=${LOG_FILE}"
ARTIFACT_JSON="outputs/review/${MODE}/${REPORT_DATE}.json"
if [[ -f "${ARTIFACT_JSON}" ]]; then
  echo "[source-diagnose] github diagnostics:"
  node -e 'const fs=require("fs");const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,"utf8"));const m=j.githubSelectionMeta||j.snapshot?.githubSelectionMeta; if(!m){console.log("  (none)"); process.exit(0);} const failed=(m.queryStats||[]).filter((q)=>q.failedReason).length; console.log(`  queryMode=${m.queryMode}, sourceCount=${m.sourceCount}, collected=${m.collectedRepoCount}, merged=${m.mergedRepoCount}, kept=${m.keptRepoCount}, selected=${m.selectedRepoCount}`); console.log(`  history=${m.historicalRepoCount}, cooldownDays=${m.cooldownDays}, suppressed=${m.cooldownSuppressedCount}, breakout=${m.breakoutAllowedCount}, failedQueries=${failed}`);' "${ARTIFACT_JSON}"
else
  echo "[source-diagnose] github diagnostics: artifact not found (${ARTIFACT_JSON})"
fi
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
