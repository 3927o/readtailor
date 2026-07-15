#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

release_id="${1:-}"
ssh -o BatchMode=yes "$SSH_TARGET" \
  "APP_ROOT='$APP_ROOT' RELEASE_ID='$release_id' bash -s" <<'REMOTE'
set -euo pipefail

current="$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)"
if [[ -n "$RELEASE_ID" ]]; then
  target="$APP_ROOT/releases/$RELEASE_ID"
else
  target="$(find "$APP_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
    | sort -nr \
    | awk -v current="$current" '$2 != current { print $2; exit }')"
fi

[[ -n "$target" && -d "$target" ]] || { echo 'rollback release not found' >&2; exit 1; }
ln -sfn "$target" "$APP_ROOT/current.next"
mv -Tf "$APP_ROOT/current.next" "$APP_ROOT/current"
systemctl restart readtailor-api.service readtailor-worker.service
curl --fail --silent --show-error --retry 15 --retry-delay 2 --retry-connrefused \
  http://127.0.0.1:3001/v1/health >/dev/null
curl --fail --silent --show-error --retry 15 --retry-delay 2 --retry-connrefused \
  http://127.0.0.1:3002/health >/dev/null
echo "rolled back to $(basename "$target")"
REMOTE
