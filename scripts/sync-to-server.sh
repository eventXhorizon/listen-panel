#!/usr/bin/env bash
#
# Push the local listen-panel data directory to the server.
#
# One-way: local is the source of truth. The server's database is replaced,
# uploads are added to. Both sides are the same person's single-user install,
# so this is a sync, not a migration -- but the server's database is still
# copied aside first, because a 16 MB copy is the only undo there is.
#
#   ./scripts/sync-to-server.sh --host 1.2.3.4
#   ./scripts/sync-to-server.sh --host 1.2.3.4 --dry-run
#
# The address is passed in, the password is typed at ssh's own prompt. Neither
# is stored. One ssh connection is opened and reused for every step, so the
# password is asked for exactly once rather than per rsync.
#
# config.json / tts.json / asr.json hold API keys and are left alone unless
# --with-config: the server may legitimately be pointed at different ones.

set -euo pipefail

HOST=""
SSH_USER="root"
DEPLOY_DIR="/root/listen-panel/deploy"
DRY_RUN=0
WITH_CONFIG=0
DELETE_EXTRA=0
ASSUME_YES=0

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_DATA="$REPO_ROOT/backend/data"

usage() {
  cat <<'EOF'
Push local listen-panel data to the server.

  ./scripts/sync-to-server.sh --host 1.2.3.4

Options:
  --host HOST        server address (prompted if omitted)
  --user USER        ssh user (default: root)
  --deploy-dir DIR   remote compose dir (default: /root/listen-panel/deploy)
  --dry-run          show what would transfer, write nothing
  --with-config      also copy config.json / tts.json / asr.json (API keys)
  --delete-extra     delete server uploads that no longer exist locally
  --yes              don't ask before writing
  -h, --help         this
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)         HOST="${2:?--host needs a value}"; shift 2 ;;
    --user)         SSH_USER="${2:?--user needs a value}"; shift 2 ;;
    --deploy-dir)   DEPLOY_DIR="${2:?--deploy-dir needs a value}"; shift 2 ;;
    --dry-run)      DRY_RUN=1; shift ;;
    --with-config)  WITH_CONFIG=1; shift ;;
    --delete-extra) DELETE_EXTRA=1; shift ;;
    --yes)          ASSUME_YES=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }

# --------------------------------------------------------------------------- #
# Preflight
# --------------------------------------------------------------------------- #

for tool in ssh rsync sqlite3; do
  command -v "$tool" >/dev/null || die "$tool not found"
done

[[ -f "$LOCAL_DATA/app.db" ]]  || die "no local database at $LOCAL_DATA/app.db"
[[ -d "$LOCAL_DATA/uploads" ]] || die "no local uploads at $LOCAL_DATA/uploads"

if [[ -z "$HOST" ]]; then
  # `|| true`: read returns non-zero at EOF, and under `set -e` that kills the
  # script before it can say why (piping anything in, or running from cron).
  read -r -p "server address: " HOST || true
  [[ -n "$HOST" ]] || die "no server address — pass --host"
fi
TARGET="$SSH_USER@$HOST"

# --------------------------------------------------------------------------- #
# One ssh connection, reused: otherwise every rsync and every remote command
# prompts for the password again.
# --------------------------------------------------------------------------- #

SSH_CTL="$(mktemp -u "${TMPDIR:-/tmp}/lp-sync-ctl.XXXXXX")"
SNAPSHOT=""

cleanup() {
  [[ -n "$SNAPSHOT" ]] && rm -f "$SNAPSHOT" "$SNAPSHOT-journal" 2>/dev/null
  [[ -S "$SSH_CTL" ]] && ssh -o ControlPath="$SSH_CTL" -O exit "$TARGET" 2>/dev/null
  return 0
}
trap cleanup EXIT

echo "→ connecting to $TARGET (password asked once, then reused)"
ssh -o ControlMaster=yes -o ControlPath="$SSH_CTL" -o ControlPersist=600 \
    -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new -Nf "$TARGET" \
  || die "ssh connection to $TARGET failed"

rsh() { ssh -o ControlPath="$SSH_CTL" "$TARGET" "$@"; }

# Read DATA_DIR rather than assume it, so this keeps working if it moves.
rsh "test -f '$DEPLOY_DIR/.env'" || die "no .env at $DEPLOY_DIR (pass --deploy-dir)"
REMOTE_DATA="$(rsh "grep -E '^DATA_DIR=' '$DEPLOY_DIR/.env' | tail -1 | cut -d= -f2- | tr -d '\"'\''[:space:]'")"
[[ -n "$REMOTE_DATA" ]] || die "DATA_DIR not set in $DEPLOY_DIR/.env"
rsh "mkdir -p '$REMOTE_DATA/uploads' '$REMOTE_DATA/tts-cache'"

# --------------------------------------------------------------------------- #
# Both sides, before touching anything
# --------------------------------------------------------------------------- #

uploads_size="$(du -sh "$LOCAL_DATA/uploads" | cut -f1)"
uploads_n="$(find "$LOCAL_DATA/uploads" -type f | wc -l | tr -d ' ')"
db_query() { sqlite3 "file:$LOCAL_DATA/app.db?mode=ro" "$1" 2>/dev/null || echo '?'; }

echo
echo "  local   app.db $(du -h "$LOCAL_DATA/app.db" | cut -f1) — $(db_query 'SELECT COUNT(*) FROM materials;') materials, $(db_query 'SELECT COUNT(*) FROM vocab;') vocab"
echo "          uploads $uploads_size in $uploads_n files"
echo
echo "  server  $REMOTE_DATA"
rsh "
  db='$REMOTE_DATA/app.db'
  if [ -f \"\$db\" ] && command -v sqlite3 >/dev/null; then
    echo \"          app.db \$(du -h \"\$db\" | cut -f1) — \$(sqlite3 \"\$db\" 'SELECT COUNT(*) FROM materials;') materials, \$(sqlite3 \"\$db\" 'SELECT COUNT(*) FROM vocab;') vocab  (replaced)\"
  elif [ -f \"\$db\" ]; then
    echo \"          app.db \$(du -h \"\$db\" | cut -f1)  (replaced)\"
  else
    echo '          app.db — none yet'
  fi
  echo \"          uploads \$(find '$REMOTE_DATA/uploads' -type f | wc -l | tr -d ' ') files, \$(df -h '$REMOTE_DATA' | awk 'NR==2 {print \$4}') disk free\"
"

RSYNC=(rsync -a --human-readable --partial -e "ssh -o ControlPath=$SSH_CTL")
DELETE_ARG=()
((DELETE_EXTRA)) && DELETE_ARG=(--delete)

if ((DRY_RUN)); then
  echo
  echo "→ dry run — uploads that would transfer (last 20 lines):"
  "${RSYNC[@]}" --dry-run --itemize-changes "${DELETE_ARG[@]}" \
    "$LOCAL_DATA/uploads/" "$TARGET:$REMOTE_DATA/uploads/" | tail -20
  echo
  echo "   plus app.db and tts-cache$( ((WITH_CONFIG)) && echo ' and the config json' )"
  exit 0
fi

if ((ASSUME_YES == 0)); then
  echo
  read -r -p "Replace the server's database and push $uploads_size of uploads? [y/N] " ans || true
  [[ "${ans:-}" == [yY] ]] || die "cancelled"
fi

# --------------------------------------------------------------------------- #
# Write
# --------------------------------------------------------------------------- #

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$REMOTE_DATA/backups/pre-sync-$STAMP"

echo
echo "→ copying the server's database aside → $BACKUP"
rsh "
  set -e
  mkdir -p '$BACKUP'
  for f in app.db config.json tts.json asr.json; do
    [ -f \"$REMOTE_DATA/\$f\" ] && cp -a \"$REMOTE_DATA/\$f\" '$BACKUP/'
  done
  ls -la '$BACKUP' | tail -n +2
" || true

echo
echo "→ stopping the backend so the database is not swapped under it"
rsh "cd '$DEPLOY_DIR' && docker compose stop backend"

# A plain copy of a live SQLite file can be torn. .backup uses the online
# backup API, so the local app can stay running while this is taken.
SNAPSHOT="$(mktemp "${TMPDIR:-/tmp}/lp-app-db.XXXXXX")"
echo
echo "→ consistent snapshot of the local database"
sqlite3 "$LOCAL_DATA/app.db" ".backup '$SNAPSHOT'"
echo "   integrity: $(sqlite3 "$SNAPSHOT" 'PRAGMA integrity_check;' | head -1)"

echo
echo "→ uploads — resumable, just re-run if it dies"
"${RSYNC[@]}" --progress "${DELETE_ARG[@]}" \
  "$LOCAL_DATA/uploads/" "$TARGET:$REMOTE_DATA/uploads/"

echo
echo "→ tts-cache"
"${RSYNC[@]}" "$LOCAL_DATA/tts-cache/" "$TARGET:$REMOTE_DATA/tts-cache/" || true

if ((WITH_CONFIG)); then
  echo
  echo "→ config json"
  for f in config.json tts.json asr.json; do
    [[ -f "$LOCAL_DATA/$f" ]] && "${RSYNC[@]}" "$LOCAL_DATA/$f" "$TARGET:$REMOTE_DATA/$f"
  done
fi

# Database last: if a transfer above dies, the server still has an old database
# that matches its old uploads, rather than a new one referencing files that
# never arrived.
echo
echo "→ database"
"${RSYNC[@]}" "$SNAPSHOT" "$TARGET:$REMOTE_DATA/app.db"

echo
echo "→ starting the backend"
rsh "cd '$DEPLOY_DIR' && docker compose up -d backend"

for i in $(seq 1 30); do
  state="$(rsh "docker inspect -f '{{.State.Health.Status}}' listen-panel-backend 2>/dev/null" || echo unknown)"
  [[ "$state" == healthy ]] && { echo "   healthy"; break; }
  [[ "$state" == unhealthy ]] && die "backend unhealthy — restore: cp $BACKUP/app.db $REMOTE_DATA/app.db"
  [[ $i -eq 30 ]] && echo "   still '$state' after 60s — check: docker compose logs backend"
  sleep 2
done

echo
rsh "
  db='$REMOTE_DATA/app.db'
  command -v sqlite3 >/dev/null && echo \"→ server now has \$(sqlite3 \"\$db\" 'SELECT COUNT(*) FROM materials;') materials, \$(sqlite3 \"\$db\" 'SELECT COUNT(*) FROM vocab;') vocab\"
  echo \"  uploads \$(find '$REMOTE_DATA/uploads' -type f | wc -l | tr -d ' ') files\"
"
echo
echo "Rollback: docker compose stop backend && cp $BACKUP/app.db $REMOTE_DATA/app.db && docker compose up -d backend"
