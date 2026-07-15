#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

release_id="${1:-}"
if [[ -n "$release_id" && ! "$release_id" =~ ^[0-9]{14}-[0-9a-f]+$ ]]; then
  die "invalid release id"
fi
ssh -o BatchMode=yes "$SSH_TARGET" \
  "APP_ROOT='$APP_ROOT' RELEASE_ID='$release_id' bash -s" <<'REMOTE'
set -euo pipefail

current="$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)"
previous="$current"
switched=0

restore_on_error() {
  status=$?
  if [[ $switched -eq 1 ]]; then
    if [[ -n "$previous" && -d "$previous" ]]; then
      ln -sfn "$previous" "$APP_ROOT/current.rollback"
      mv -Tf "$APP_ROOT/current.rollback" "$APP_ROOT/current"
      systemctl restart readtailor-api.service readtailor-worker.service || true
    else
      rm -f "$APP_ROOT/current"
      systemctl stop readtailor-api.service readtailor-worker.service || true
    fi
  fi
  exit "$status"
}
trap restore_on_error ERR

if [[ -n "$RELEASE_ID" ]]; then
  target="$APP_ROOT/releases/$RELEASE_ID"
else
  target="$(find "$APP_ROOT/releases" -mindepth 2 -maxdepth 2 -type f -name .deployed -printf '%T@ %h\n' \
    | sort -nr \
    | awk -v current="$current" '$2 != current { print $2; exit }')"
fi

[[ -n "$target" && -d "$target" && -f "$target/.deployed" ]] \
  || { echo 'rollback release not found or was never deployed successfully' >&2; exit 1; }
ln -sfn "$target" "$APP_ROOT/current.next"
mv -Tf "$APP_ROOT/current.next" "$APP_ROOT/current"
switched=1
systemctl restart readtailor-api.service readtailor-worker.service
curl --fail --silent --show-error --retry 15 --retry-delay 2 --retry-connrefused \
  http://127.0.0.1:3001/v1/health >/dev/null
curl --fail --silent --show-error --retry 15 --retry-delay 2 --retry-connrefused \
  http://127.0.0.1:3002/health >/dev/null
switched=0
trap - ERR
echo "rolled back to $(basename "$target")"
REMOTE
