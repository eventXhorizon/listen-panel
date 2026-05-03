#!/usr/bin/env bash
# Listen Panel - one-shot dev launcher
# 同时拉起 Rust 后端(:9527)与 Vite 前端(:19527)。Ctrl-C 同时停。

set -eo pipefail

cd "$(dirname "$0")"

cleanup() {
  echo
  echo "stopping..."
  pkill -P $$ 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

command -v cargo >/dev/null || { echo "error: cargo not found in PATH" >&2; exit 1; }
command -v npm   >/dev/null || { echo "error: npm not found in PATH"   >&2; exit 1; }
command -v lsof  >/dev/null || { echo "error: lsof not found in PATH"  >&2; exit 1; }

stop_port() {
  local port="$1"
  local label="$2"
  local pids

  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    return
  fi

  echo "→ stopping existing ${label} listener on :${port} (PID: ${pids//$'\n'/, })"
  kill $pids 2>/dev/null || true

  for _ in {1..20}; do
    if ! lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      return
    fi
    sleep 0.1
  done

  echo "→ force stopping ${label} listener on :${port}"
  kill -9 $pids 2>/dev/null || true
}

wait_port() {
  local port="$1"
  local label="$2"

  for _ in {1..100}; do
    if lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      return
    fi
    sleep 0.1
  done

  echo "error: ${label} did not start listening on :${port}" >&2
  exit 1
}

stop_port 9527 "backend"
stop_port 19527 "frontend"

if [[ ! -d frontend/node_modules ]]; then
  echo "→ installing frontend deps (first run only)..."
  (cd frontend && npm install)
fi

echo
echo "  backend  → http://localhost:9527"
echo "  frontend → http://localhost:19527  (LAN: http://<your-lan-ip>:19527)"
echo "  Ctrl-C to stop both"
echo

# Tag each output line so interleaved logs stay readable.
(cd backend  && cargo run   2>&1 | awk '{ print "\033[36m[BE]\033[0m " $0; fflush() }') &
wait_port 9527 "backend"
(cd frontend && npm run dev -- --host 0.0.0.0 2>&1 | awk '{ print "\033[35m[FE]\033[0m " $0; fflush() }') &
wait
