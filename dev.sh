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

if [[ ! -d frontend/node_modules ]]; then
  echo "→ installing frontend deps (first run only)..."
  (cd frontend && npm install)
fi

echo
echo "  backend  → http://localhost:9527"
echo "  frontend → http://localhost:19527"
echo "  Ctrl-C to stop both"
echo

# Tag each output line so interleaved logs stay readable.
(cd backend  && cargo run   2>&1 | awk '{ print "\033[36m[BE]\033[0m " $0; fflush() }') &
(cd frontend && npm run dev 2>&1 | awk '{ print "\033[35m[FE]\033[0m " $0; fflush() }') &
wait
