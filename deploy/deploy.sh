#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
APP_DIR="$PROJECT_ROOT/app"
DEPLOY_TARGET=${1:-root@106.52.185.151}
RELEASE_ID=$(date -u +%Y%m%dT%H%M%SZ)
REMOTE_RELEASE="/srv/background-board/releases/$RELEASE_ID"
ARCHIVE_DIR=$(mktemp -d)
ARCHIVE_PATH="$ARCHIVE_DIR/background-board-$RELEASE_ID.tar.gz"
trap 'rm -rf "$ARCHIVE_DIR"' EXIT

cd "$APP_DIR"
pnpm install --frozen-lockfile
pnpm build
tar -czf "$ARCHIVE_PATH" build static package.json pnpm-lock.yaml

ssh "$DEPLOY_TARGET" "install -d -m 0755 /srv/background-board/releases"
scp "$ARCHIVE_PATH" "$DEPLOY_TARGET:/tmp/background-board-release.tar.gz"
ssh "$DEPLOY_TARGET" "RELEASE_PATH='$REMOTE_RELEASE' bash -s" <<'REMOTE'
set -euo pipefail
install -d -m 0755 "$RELEASE_PATH"
tar -xzf /tmp/background-board-release.tar.gz -C "$RELEASE_PATH"
rm -f /tmp/background-board-release.tar.gz
cd "$RELEASE_PATH"
corepack pnpm install --prod --frozen-lockfile
chown -R background-board:background-board "$RELEASE_PATH"
ln -sfn "$RELEASE_PATH" /srv/background-board/current.next
if [ -L /srv/background-board/current ]; then
    readlink -f /srv/background-board/current > /srv/background-board/previous-release
fi
mv -Tf /srv/background-board/current.next /srv/background-board/current
systemctl restart background-board.service
REMOTE

ssh "$DEPLOY_TARGET" "curl --fail --silent --show-error --retry 8 --retry-delay 1 http://127.0.0.1:3210/background-board/api/health >/dev/null"
echo "Deployed release $RELEASE_ID"
