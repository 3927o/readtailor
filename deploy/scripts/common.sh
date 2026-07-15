#!/usr/bin/env bash

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/.." && pwd)"

SSH_TARGET=ali
APP_NAME=readtailor
APP_USER=readtailor
APP_ROOT=/opt/readtailor
DOMAIN=readtailor.narcissus.life
NODE_BIN=/usr/bin/node
RELEASES_TO_KEEP=5
PNPM_VERSION=10.13.1
NPM_REGISTRY=https://registry.npmmirror.com
BUILD_MODE=auto
NODE_BUILD_IMAGE=node:24-bookworm-slim
API_HEAP_MB=384
WORKER_HEAP_MB=512

DEPLOY_CONFIG="${DEPLOY_CONFIG:-$DEPLOY_DIR/deploy.env}"
if [[ -f "$DEPLOY_CONFIG" ]]; then
  # shellcheck disable=SC1090
  source "$DEPLOY_CONFIG"
fi

REMOTE_ENV_FILE=/etc/readtailor/readtailor.env

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

validate_settings() {
  [[ "$SSH_TARGET" =~ ^[A-Za-z0-9._@-]+$ ]] || die "invalid SSH_TARGET"
  [[ "$APP_NAME" =~ ^[A-Za-z0-9_-]+$ ]] || die "invalid APP_NAME"
  [[ "$APP_USER" =~ ^[A-Za-z0-9_-]+$ ]] || die "invalid APP_USER"
  [[ "$APP_ROOT" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "invalid APP_ROOT"
  [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "invalid DOMAIN"
  [[ "$NODE_BIN" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "invalid NODE_BIN"
  [[ "$RELEASES_TO_KEEP" =~ ^[1-9][0-9]*$ ]] || die "invalid RELEASES_TO_KEEP"
  [[ "$PNPM_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "invalid PNPM_VERSION"
  [[ "$BUILD_MODE" =~ ^(auto|local|docker)$ ]] || die "invalid BUILD_MODE"
  [[ -n "$NODE_BUILD_IMAGE" ]] || die "NODE_BUILD_IMAGE must not be empty"
  [[ "$API_HEAP_MB" =~ ^[1-9][0-9]*$ ]] || die "invalid API_HEAP_MB"
  [[ "$WORKER_HEAP_MB" =~ ^[1-9][0-9]*$ ]] || die "invalid WORKER_HEAP_MB"
}

render_template() {
  local source=$1
  local destination=$2
  sed \
    -e "s|__APP_ROOT__|$APP_ROOT|g" \
    -e "s|__APP_USER__|$APP_USER|g" \
    -e "s|__DOMAIN__|$DOMAIN|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__API_HEAP_MB__|$API_HEAP_MB|g" \
    -e "s|__WORKER_HEAP_MB__|$WORKER_HEAP_MB|g" \
    "$source" > "$destination"
}

validate_settings
