#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

require_command ssh
require_command rsync

temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT

build_root="$REPO_ROOT"
node_major="$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)"
use_local_build=false
if [[ "$BUILD_MODE" == local ]]; then
  use_local_build=true
elif [[ "$BUILD_MODE" == auto && "$node_major" == 24 ]] \
  && command -v pnpm >/dev/null 2>&1; then
  use_local_build=true
fi

if [[ "$use_local_build" == true ]]; then
  [[ "$node_major" == 24 ]] || die "local build requires Node.js 24"
  require_command pnpm
  pnpm install --frozen-lockfile --registry="$NPM_REGISTRY"
  VITE_API_BASE_URL="https://$DOMAIN" \
    VITE_AUTH_DEVELOPMENT_ENABLED=false \
    pnpm --workspace-concurrency=1 -r --if-present build
else
  require_command docker
  build_root="$temporary/build"
  mkdir -p "$build_root"
  rsync -a --delete \
    --exclude .git \
    --exclude .env \
    --exclude 'deploy/deploy.env' \
    --exclude 'deploy/readtailor.env' \
    --exclude node_modules \
    --exclude coverage \
    --exclude test-results \
    "$REPO_ROOT/" "$build_root/"
  docker run --rm \
    -e CI=1 \
    -e "VITE_API_BASE_URL=https://$DOMAIN" \
    -e VITE_AUTH_DEVELOPMENT_ENABLED=false \
    -v "$build_root:/workspace" \
    -w /workspace \
    "$NODE_BUILD_IMAGE" \
    sh -lc "npm install --global pnpm@$PNPM_VERSION && pnpm install --frozen-lockfile --registry='$NPM_REGISTRY' && pnpm --workspace-concurrency=1 -r --if-present build"
fi

for artifact in \
  apps/api/dist/server.js \
  apps/api/dist/migrate.js \
  apps/api/dist/backfill-preset-books.js \
  apps/worker/dist/server.js \
  apps/worker/dist/ingest-preset.js \
  apps/web/dist/index.html; do
  [[ -f "$build_root/$artifact" ]] || die "missing build artifact: $artifact"
done

release_id="$(date -u +%Y%m%d%H%M%S)-$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
stage="$temporary/release"
mkdir -p "$stage/docs"

rsync -a --exclude node_modules --exclude '*.tsbuildinfo' "$build_root/apps/" "$stage/apps/"
rsync -a --exclude node_modules --exclude '*.tsbuildinfo' "$build_root/packages/" "$stage/packages/"
rsync -a "$build_root/tools/" "$stage/tools/"
rsync -a "$build_root/docs/contracts/" "$stage/docs/contracts/"
cp "$build_root/package.json" "$build_root/pnpm-lock.yaml" "$build_root/pnpm-workspace.yaml" \
  "$build_root/requirements.txt" "$stage/"

render_template "$DEPLOY_DIR/caddy/readtailor.caddy.template" "$temporary/readtailor.caddy"
cp "$DEPLOY_DIR/scripts/adopt-caddy-site.py" "$temporary/adopt-caddy-site.py"

ssh -o BatchMode=yes "$SSH_TARGET" \
  "test -x '$NODE_BIN' && command -v pnpm >/dev/null 2>&1 && test -f '$REMOTE_ENV_FILE' && test -d '$APP_ROOT/releases'" \
  || die "server is not bootstrapped; run deploy/scripts/bootstrap.sh first"

if ssh -o BatchMode=yes "$SSH_TARGET" "grep -q '<[^>]*>' '$REMOTE_ENV_FILE'"; then
  die "$REMOTE_ENV_FILE still contains placeholder values"
fi

remote_release="$APP_ROOT/releases/$release_id"
ssh -o BatchMode=yes "$SSH_TARGET" "mkdir -p '$remote_release'"
rsync -az --delete "$stage/" "$SSH_TARGET:$remote_release/"
rsync -az "$temporary/readtailor.caddy" "$temporary/adopt-caddy-site.py" "$SSH_TARGET:/tmp/"

ssh -o BatchMode=yes "$SSH_TARGET" \
  "APP_USER='$APP_USER' APP_ROOT='$APP_ROOT' NODE_BIN='$NODE_BIN' RELEASE_ID='$release_id' KEEP='$RELEASES_TO_KEEP' REGISTRY='$NPM_REGISTRY' DOMAIN='$DOMAIN' bash -s" <<'REMOTE'
set -euo pipefail

release="$APP_ROOT/releases/$RELEASE_ID"
previous="$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)"
switched=0
services_stopped=0

rollback_on_error() {
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
  elif [[ $services_stopped -eq 1 && -n "$previous" && -d "$previous" ]]; then
    systemctl restart readtailor-api.service readtailor-worker.service || true
  fi
  exit "$status"
}
trap rollback_on_error ERR

[[ "$("$NODE_BIN" --version)" == v24.* ]] || { echo 'Node.js 24 is required' >&2; exit 1; }
export PATH="$(dirname "$NODE_BIN"):$PATH"
chown -R "$APP_USER:$APP_USER" "$release"

runuser -u "$APP_USER" -- env HOME="$APP_ROOT/shared" \
  pnpm --dir "$release" \
    --filter '@readtailor/api...' \
    --filter '@readtailor/worker...' \
    install --prod --frozen-lockfile --registry="$REGISTRY"
runuser -u "$APP_USER" -- "$APP_ROOT/venv/bin/pip" install --disable-pip-version-check \
  --requirement "$release/requirements.txt"
systemctl stop readtailor-api.service readtailor-worker.service
services_stopped=1
runuser -u "$APP_USER" -- "$NODE_BIN" --env-file=/etc/readtailor/readtailor.env \
  "$release/apps/api/dist/migrate.js"

ln -sfn "$release" "$APP_ROOT/current.next"
mv -Tf "$APP_ROOT/current.next" "$APP_ROOT/current"
switched=1

systemctl restart readtailor-api.service
for _ in $(seq 1 30); do
  curl --fail --silent --max-time 10 http://127.0.0.1:3001/v1/health >/dev/null && break
  sleep 2
done
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3001/v1/health >/dev/null

systemctl restart readtailor-worker.service
for _ in $(seq 1 30); do
  curl --fail --silent --max-time 10 http://127.0.0.1:3002/health >/dev/null && break
  sleep 2
done
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3002/health >/dev/null

install -d -o root -g caddy -m 0755 /etc/caddy/sites-enabled
old_snippet="$(mktemp)"
if [[ -f /etc/caddy/sites-enabled/readtailor.caddy ]]; then
  cp /etc/caddy/sites-enabled/readtailor.caddy "$old_snippet"
fi
install -o root -g caddy -m 0644 /tmp/readtailor.caddy \
  /etc/caddy/sites-enabled/readtailor.caddy
python3 /tmp/adopt-caddy-site.py \
  --config /etc/caddy/Caddyfile \
  --domain "$DOMAIN" \
  --import-path '/etc/caddy/sites-enabled/*.caddy'
if ! caddy validate --config /etc/caddy/Caddyfile; then
  cp /etc/caddy/Caddyfile.readtailor-backup /etc/caddy/Caddyfile
  if [[ -s "$old_snippet" ]]; then
    cp "$old_snippet" /etc/caddy/sites-enabled/readtailor.caddy
  else
    rm -f /etc/caddy/sites-enabled/readtailor.caddy
  fi
  exit 1
fi
caddy fmt --overwrite /etc/caddy/Caddyfile
systemctl reload caddy.service

touch "$release/.deployed"
chown "$APP_USER:$APP_USER" "$release/.deployed"
switched=0
services_stopped=0
trap - ERR
rm -f /tmp/readtailor.caddy /tmp/adopt-caddy-site.py "$old_snippet"

current="$(readlink -f "$APP_ROOT/current")"
find "$APP_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
  | sort -nr \
  | awk -v keep="$KEEP" -v current="$current" 'NR > keep && $2 != current { print $2 }' \
  | xargs -r rm -rf

echo "deployed $RELEASE_ID"
REMOTE

printf '部署完成：https://%s\n' "$DOMAIN"
