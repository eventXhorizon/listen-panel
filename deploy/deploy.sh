#!/usr/bin/env bash
# Roll forward the listen-panel stack to whatever IMAGE_TAG is set in ./.env.
# Idempotent — safe to re-run.
#
# Usage on the server:
#   cd /root/listen-panel/deploy
#   $EDITOR .env       # bump IMAGE_TAG to the tag CI printed
#   ./deploy.sh
#
# Override IMAGE_TAG without editing .env:
#   IMAGE_TAG=20260523-1430-a1b2c3d ./deploy.sh

set -euo pipefail

cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  echo "error: .env not found. Copy .env.example to .env and fill it in." >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a; source .env; set +a

: "${IMAGE_REPO:?IMAGE_REPO not set in .env}"
: "${IMAGE_TAG:?IMAGE_TAG not set in .env}"
: "${DATA_DIR:?DATA_DIR not set in .env}"

mkdir -p "$DATA_DIR"

echo "→ deploying ${IMAGE_REPO}/listen-panel-{backend,frontend}:${IMAGE_TAG}"
docker compose pull
docker compose up -d --remove-orphans

echo
echo "→ status:"
docker compose ps
