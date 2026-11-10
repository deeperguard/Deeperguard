#!/usr/bin/env bash
# Revoke all live user_sessions after restoring the server database from a snapshot.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIRM_ENV="NOTES_REVOKE_ALL_SESSIONS_AFTER_RESTORE_CONFIRM"

if [[ "${NOTES_REVOKE_ALL_SESSIONS_AFTER_RESTORE_CONFIRM:-}" != "1" && "${1:-}" != "--confirm" ]]; then
  echo "Refusing: export ${CONFIRM_ENV}=1 or pass --confirm." >&2
  exit 2
fi

export NOTES_ROOT="${NOTES_ROOT:-/opt/deeperguard}"
exec python3 "$ROOT/deploy/revoke-all-sessions-after-restore.py" "$@"
