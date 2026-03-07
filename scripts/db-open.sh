#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_PATH="${1:-${ROOT_DIR}/outputs/db/app.sqlite}"
APP_NAME="DB Browser for SQLite"

if [[ ! -f "${DB_PATH}" ]]; then
  echo "[db-open-error] 数据库文件不存在: ${DB_PATH}" >&2
  echo "[db-open-tip] 先执行: pnpm run verify:m4 或 pnpm run run:migrate:file-to-db" >&2
  exit 1
fi

if [[ ! -d "/Applications/${APP_NAME}.app" ]]; then
  echo "[db-open-error] 未检测到 ${APP_NAME}.app，请先安装。" >&2
  echo "[db-open-tip] brew install --cask db-browser-for-sqlite" >&2
  exit 1
fi

echo "[db-open] app=${APP_NAME}"
echo "[db-open] db=${DB_PATH}"
open -a "${APP_NAME}" "${DB_PATH}"
