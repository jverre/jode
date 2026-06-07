#!/bin/bash
set -euo pipefail

REHOST_ROOT="${1:-/opt/claude-rehost}"

cd "${REHOST_ROOT}"

VERSION="$(node -p "require('./node_modules/electron/package.json').version")"
ZIP_PATH="/tmp/electron-v${VERSION}-linux-x64.zip"
DOWNLOAD_URL="https://github.com/electron/electron/releases/download/v${VERSION}/electron-v${VERSION}-linux-x64.zip"

rm -rf node_modules/electron/dist node_modules/electron/path.txt "${ZIP_PATH}"
mkdir -p node_modules/electron/dist

echo "[install-electron-linux] downloading ${DOWNLOAD_URL}"
wget -qO "${ZIP_PATH}" "${DOWNLOAD_URL}"

echo "[install-electron-linux] extracting ${ZIP_PATH}"
unzip -q "${ZIP_PATH}" -d node_modules/electron/dist

chmod +x node_modules/electron/dist/electron
printf 'electron' > node_modules/electron/path.txt

test -x node_modules/electron/dist/electron
test -f node_modules/electron/path.txt

echo "[install-electron-linux] installed Electron ${VERSION}"
