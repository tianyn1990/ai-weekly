#!/usr/bin/env bash
set -euo pipefail

# 该脚本只负责“把本地回调端口暴露到公网”，不负责启动业务服务。
HOST="${FEISHU_CALLBACK_HOST:-127.0.0.1}"
PORT="${FEISHU_CALLBACK_PORT:-8787}"
CALLBACK_PATH="${FEISHU_CALLBACK_PATH:-/feishu/review-callback}"
LOCAL_URL="http://${HOST}:${PORT}"
CLOUDFLARED_PROTOCOL="${CLOUDFLARED_PROTOCOL:-http2}"

if command -v cloudflared >/dev/null 2>&1; then
  echo "[feishu-tunnel] provider=cloudflared"
  echo "[feishu-tunnel] protocol=${CLOUDFLARED_PROTOCOL}"
  echo "[feishu-tunnel] local-url=${LOCAL_URL}${CALLBACK_PATH}"
  echo "[feishu-tunnel] waiting public url..."

  printed=0
  cloudflared tunnel --protocol "${CLOUDFLARED_PROTOCOL}" --url "${LOCAL_URL}" 2>&1 | while IFS= read -r line; do
    echo "${line}"
    if [[ "${printed}" -eq 0 ]]; then
      public_url="$(echo "${line}" | grep -Eo 'https://[-A-Za-z0-9.]+trycloudflare.com' | head -n 1 || true)"
      if [[ -n "${public_url}" ]]; then
        echo "[feishu-tunnel] callback-url=${public_url}${CALLBACK_PATH}"
        printed=1
      fi
    fi
  done
  exit 0
fi

if command -v ngrok >/dev/null 2>&1; then
  echo "[feishu-tunnel] provider=ngrok"
  echo "[feishu-tunnel] local-url=${LOCAL_URL}${CALLBACK_PATH}"
  echo "[feishu-tunnel] ngrok started; query public url from: http://127.0.0.1:4040/api/tunnels"
  exec ngrok http "${PORT}"
fi

echo "[feishu-tunnel-error] 未检测到 cloudflared 或 ngrok，请先安装其中一个。" >&2
echo "[feishu-tunnel-error] cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" >&2
echo "[feishu-tunnel-error] ngrok: https://ngrok.com/download" >&2
exit 1
