#!/usr/bin/env bash
# Build, launch jode with Chrome DevTools remote debugging, capture screenshots
# of the renderer chrome and the active agent pane, then quit.
#
# Usage: npm run shot        (from apps/desktop)
# Output: /tmp/jode-chrome.png  (sidebar + bordered frame + merged tab)
#         /tmp/jode-pane.png    (active agent pane)
set -e
PORT="${1:-9222}"
cd "$(dirname "$0")/.."

npm run build >/dev/null

npx electron . --remote-debugging-port="$PORT" >/tmp/jode-electron.log 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT

# wait for the DevTools endpoint to come up
for _ in $(seq 1 40); do
  curl -s "http://127.0.0.1:$PORT/json" >/dev/null 2>&1 && break
  sleep 0.25
done
sleep 2

node scripts/cdp-shot.mjs "$PORT" /tmp
echo "→ /tmp/jode-chrome.png and /tmp/jode-pane.png"
