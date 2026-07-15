#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

ssh -o BatchMode=yes "$SSH_TARGET" "APP_ROOT='$APP_ROOT' bash -s" <<'REMOTE'
set -u
echo "current: $(readlink -f "$APP_ROOT/current" 2>/dev/null || echo none)"
echo
systemctl --no-pager --full status readtailor-api.service readtailor-worker.service || true
echo
curl --silent --show-error --max-time 10 http://127.0.0.1:3001/v1/health || true
echo
curl --silent --show-error --max-time 10 http://127.0.0.1:3002/health || true
echo
free -h
REMOTE
