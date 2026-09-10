#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
APP_DIR="$PROJECT_ROOT/app"
UNIT_FILE="$PROJECT_ROOT/deploy/background-board.service"
NGINX_SNIPPET="$PROJECT_ROOT/deploy/nginx-background-board.conf"
DEPLOY_TARGET=${1:-root@106.52.185.151}
PUBLIC_HEALTH_URL=${BACKGROUND_BOARD_PUBLIC_HEALTH_URL:-https://projects.wangjian7410.cc/background-board/api/health}
RELEASE_ID=$(date -u +%Y%m%dT%H%M%SZ)
REMOTE_RELEASE="/srv/background-board/releases/$RELEASE_ID"
ARCHIVE_DIR=$(mktemp -d)
ARCHIVE_PATH="$ARCHIVE_DIR/background-board-$RELEASE_ID.tar.gz"
trap 'rm -rf "$ARCHIVE_DIR"' EXIT

cd "$APP_DIR"
pnpm install --frozen-lockfile
pnpm build
tar -czf "$ARCHIVE_PATH" build static package.json pnpm-lock.yaml

scp "$UNIT_FILE" "$DEPLOY_TARGET:/tmp/background-board.service.new"
scp "$NGINX_SNIPPET" "$DEPLOY_TARGET:/tmp/background-board-nginx.conf.new"
ssh "$DEPLOY_TARGET" "bash -s" <<'PREFLIGHT'
set -euo pipefail
if ! id background-board >/dev/null 2>&1; then
    useradd --system --home-dir /srv/background-board --shell /usr/sbin/nologin background-board
fi
install -d -m 0755 /srv/background-board/releases
install -d -o background-board -g background-board -m 0750 /srv/background-board/data
if [ ! -f /etc/background-board.env ]; then
    echo 'Missing /etc/background-board.env; create it from app/.env.example using a secret store.' >&2
    exit 1
fi
chown root:root /etc/background-board.env
chmod 0600 /etc/background-board.env
install -o root -g root -m 0644 /tmp/background-board.service.new /etc/systemd/system/background-board.service
install -o root -g root -m 0644 /tmp/background-board-nginx.conf.new /etc/nginx/snippets/background-board.conf
rm -f /tmp/background-board.service.new /tmp/background-board-nginx.conf.new
systemctl daemon-reload
if ! nginx -T 2>/dev/null | grep -F 'location /background-board/' >/dev/null; then
    echo 'Nginx snippet is installed but not included by an active TLS server; follow deploy/README.md.' >&2
    exit 1
fi
nginx -t
PREFLIGHT
scp "$ARCHIVE_PATH" "$DEPLOY_TARGET:/tmp/background-board-release.tar.gz"
ssh "$DEPLOY_TARGET" "RELEASE_PATH='$REMOTE_RELEASE' bash -s" <<'REMOTE'
set -euo pipefail
install -d -m 0755 "$RELEASE_PATH"
tar -xzf /tmp/background-board-release.tar.gz -C "$RELEASE_PATH"
rm -f /tmp/background-board-release.tar.gz
cd "$RELEASE_PATH"
corepack pnpm install --prod --frozen-lockfile --ignore-scripts
chown -R background-board:background-board "$RELEASE_PATH"
# 让 /api/health 反映真实发布版本，而不是 .env 里写死的常量。
sed -i '/^APP_VERSION=/d' /etc/background-board.env
printf 'APP_VERSION=%s\n' "${RELEASE_PATH##*/}" >> /etc/background-board.env
chown root:root /etc/background-board.env
chmod 0600 /etc/background-board.env
ln -sfn "$RELEASE_PATH" /srv/background-board/current.next
if [ -L /srv/background-board/current ]; then
    readlink -f /srv/background-board/current > /srv/background-board/previous-release
fi
mv -Tf /srv/background-board/current.next /srv/background-board/current
systemctl enable background-board.service
systemctl restart background-board.service
REMOTE

ssh "$DEPLOY_TARGET" "curl --fail --silent --show-error --retry 8 --retry-delay 1 http://127.0.0.1:3210/background-board/api/health >/dev/null"
ssh "$DEPLOY_TARGET" "nginx -t && systemctl reload nginx"
curl --fail --silent --show-error --retry 8 --retry-delay 1 "$PUBLIC_HEALTH_URL" >/dev/null
echo "Deployed release $RELEASE_ID"
