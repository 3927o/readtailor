#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

require_command ssh
require_command rsync

temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT

render_template "$DEPLOY_DIR/systemd/readtailor-api.service.template" "$temporary/readtailor-api.service"
render_template "$DEPLOY_DIR/systemd/readtailor-worker.service.template" "$temporary/readtailor-worker.service"
cp "$DEPLOY_DIR/readtailor.env.example" "$temporary/readtailor.env.example"

remote_temporary="/tmp/readtailor-bootstrap-$$"
ssh -o BatchMode=yes "$SSH_TARGET" "mkdir -p '$remote_temporary'"
rsync -az "$temporary/" "$SSH_TARGET:$remote_temporary/"

ssh -o BatchMode=yes "$SSH_TARGET" \
  "APP_USER='$APP_USER' APP_ROOT='$APP_ROOT' NODE_BIN='$NODE_BIN' PNPM_VERSION='$PNPM_VERSION' REMOTE_TMP='$remote_temporary' bash -s" <<'REMOTE'
set -euo pipefail

[[ $(id -u) -eq 0 ]] || { echo 'bootstrap must run as root' >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl python3 python3-venv rsync

node_major="$("$NODE_BIN" --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)"
[[ "$node_major" == 24 ]] || {
  echo 'Node.js 24 is required; install it before running bootstrap' >&2
  exit 1
}
export PATH="$(dirname "$NODE_BIN"):$PATH"

npm install --global "pnpm@$PNPM_VERSION"

if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_ROOT/shared" --shell /usr/sbin/nologin "$APP_USER"
fi

install -d -o root -g root -m 0755 "$APP_ROOT" "$APP_ROOT/releases"
install -d -o "$APP_USER" -g "$APP_USER" -m 0755 "$APP_ROOT/shared"
install -d -o root -g "$APP_USER" -m 0750 /etc/readtailor

if [[ ! -f /etc/readtailor/readtailor.env ]]; then
  install -o root -g "$APP_USER" -m 0640 \
    "$REMOTE_TMP/readtailor.env.example" /etc/readtailor/readtailor.env
  echo 'created /etc/readtailor/readtailor.env; fill its secrets before deploy'
fi

if [[ ! -x "$APP_ROOT/venv/bin/python3" ]]; then
  python3 -m venv "$APP_ROOT/venv"
  chown -R "$APP_USER:$APP_USER" "$APP_ROOT/venv"
fi

install -o root -g root -m 0644 "$REMOTE_TMP/readtailor-api.service" \
  /etc/systemd/system/readtailor-api.service
install -o root -g root -m 0644 "$REMOTE_TMP/readtailor-worker.service" \
  /etc/systemd/system/readtailor-worker.service

systemctl daemon-reload
systemctl enable readtailor-api.service readtailor-worker.service
rm -rf "$REMOTE_TMP"

"$NODE_BIN" --version
pnpm --version
python3 --version
echo 'bootstrap completed'
REMOTE

printf '\n下一步：\n'
printf '1. ssh %s "vi %s"\n' "$SSH_TARGET" "$REMOTE_ENV_FILE"
printf '2. %s/deploy.sh\n' "$SCRIPT_DIR"
