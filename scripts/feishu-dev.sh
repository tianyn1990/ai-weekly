#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${FEISHU_CALLBACK_HOST:-127.0.0.1}"
PORT="${FEISHU_CALLBACK_PORT:-8787}"
CALLBACK_PATH="${FEISHU_CALLBACK_PATH:-/feishu/review-callback}"
LOCAL_HEALTH_URL="http://${HOST}:${PORT}/health"
LOCAL_CALLBACK_URL="http://${HOST}:${PORT}${CALLBACK_PATH}"

CALLBACK_PID=""
TUNNEL_PID=""

cleanup() {
  # 统一收尾，避免后台进程残留占用端口。
  if [[ -n "${TUNNEL_PID}" ]] && kill -0 "${TUNNEL_PID}" 2>/dev/null; then
    kill "${TUNNEL_PID}" 2>/dev/null || true
  fi
  if [[ -n "${CALLBACK_PID}" ]] && kill -0 "${CALLBACK_PID}" 2>/dev/null; then
    kill "${CALLBACK_PID}" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

echo "[feishu-dev] start callback server..."
(
  cd "${ROOT_DIR}"
  exec npx tsx src/cli.ts run --serve-feishu-callback
) &
CALLBACK_PID=$!

echo "[feishu-dev] callback local-url=${LOCAL_CALLBACK_URL}"
echo "[feishu-dev] waiting callback health..."
ready=0
for _ in $(seq 1 40); do
  if curl -fsS "${LOCAL_HEALTH_URL}" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.25
done

if [[ "${ready}" -ne 1 ]]; then
  echo "[feishu-dev-error] callback server 未就绪，请检查端口 ${PORT} 是否被占用。" >&2
  exit 1
fi

echo "[feishu-dev] callback ready, start tunnel..."
(
  cd "${ROOT_DIR}"
  exec bash scripts/feishu-tunnel.sh
) &
TUNNEL_PID=$!

echo "[feishu-dev] running (callback pid=${CALLBACK_PID}, tunnel pid=${TUNNEL_PID})"
echo "[feishu-dev] press Ctrl+C to stop both processes."

# macOS 默认 bash 3.2 不支持 wait -n，这里用轮询方式兼容。
while kill -0 "${CALLBACK_PID}" 2>/dev/null && kill -0 "${TUNNEL_PID}" 2>/dev/null; do
  sleep 1
done

if ! kill -0 "${CALLBACK_PID}" 2>/dev/null; then
  wait "${CALLBACK_PID}" || true
  echo "[feishu-dev-exit] callback server exited."
else
  wait "${TUNNEL_PID}" || true
  echo "[feishu-dev-exit] tunnel process exited."
fi
