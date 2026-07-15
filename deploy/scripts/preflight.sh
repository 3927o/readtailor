#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

ssh -o BatchMode=yes "$SSH_TARGET" \
  "APP_ROOT='$APP_ROOT' DOMAIN='$DOMAIN' NODE_BIN='$NODE_BIN' REMOTE_ENV_FILE='$REMOTE_ENV_FILE' bash -s" <<'REMOTE'
set -u
failed=0

check() {
  local label=$1
  shift
  if "$@"; then
    printf '[ok] %s\n' "$label"
  else
    printf '[fail] %s\n' "$label"
    failed=1
  fi
}

is_root() { [[ $(id -u) -eq 0 ]]; }
is_ubuntu_2404() { grep -q 'VERSION_ID="24.04"' /etc/os-release; }
has_node_24() { [[ $("$NODE_BIN" --version 2>/dev/null) == v24.* ]]; }
has_pnpm() { command -v pnpm >/dev/null 2>&1; }
has_venv() { [[ -x "$APP_ROOT/venv/bin/python3" ]]; }
has_caddy() { systemctl is-active --quiet caddy.service; }
has_runtime_env() { [[ -f "$REMOTE_ENV_FILE" ]]; }
env_is_filled() { [[ -f "$REMOTE_ENV_FILE" ]] && ! grep -q '<[^>]*>' "$REMOTE_ENV_FILE"; }
api_is_private() { ! ss -ltn | grep -q '0.0.0.0:3001'; }
worker_is_private() { ! ss -ltn | grep -q '0.0.0.0:3002'; }
has_swap() {
  swap_bytes="$(free -b | awk '/Swap:/ {print $2}')"
  [[ "$swap_bytes" =~ ^[0-9]+$ && "$swap_bytes" -ge 2000000000 ]]
}

check 'root SSH user' is_root
check 'Ubuntu 24.04' is_ubuntu_2404
check 'Node.js 24' has_node_24
check 'pnpm available' has_pnpm
check 'Python virtualenv' has_venv
check 'Caddy active' has_caddy
check 'runtime env exists' has_runtime_env
check 'runtime env has no placeholders' env_is_filled
check 'API port is private or unused' api_is_private
check 'Worker port is private or unused' worker_is_private
check 'at least 2 GiB swap' has_swap

exit "$failed"
REMOTE
