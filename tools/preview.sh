#!/bin/bash
# Start THIS checkout's dev preview and open it in Chrome.
#
# Works from any worktree: the script locates its own repo root, so the server
# always serves the tree the script lives in — never whatever another session
# left running on a shared port.
#
#   tools/preview.sh                      → /?autostart=1
#   tools/preview.sh '?autostart=1&spawn=oceanBeach'
#
# Ctrl-C stops the server.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUERY="${1:-?autostart=1}"
cd "$ROOT" || exit 1

# A free (dev, relay) pair. Other live worktree sessions squat ports, and
# --strictPort must never fall through to someone else's build.
PORT=""
for p in $(seq 5300 5399); do
  if ! lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 &&
     ! lsof -nP -iTCP:"$((p + 3000))" -sTCP:LISTEN >/dev/null 2>&1; then
    PORT="$p"
    break
  fi
done
if [ -z "$PORT" ]; then
  echo "[preview] no free port pair in 5300-5399" >&2
  exit 1
fi

URL="http://localhost:${PORT}/${QUERY}"
echo "[preview] worktree: $ROOT"
echo "[preview] url:      $URL"

SF_RELAY_PORT="$((PORT + 3000))" npm run dev -- --port "$PORT" --strictPort &
DEV_PID=$!
trap 'kill "$DEV_PID" 2>/dev/null' EXIT INT TERM

# Open only once the server actually answers — otherwise Chrome races the
# build and lands on a connection error.
READY=""
for _ in $(seq 120); do
  if curl -s -o /dev/null "http://localhost:${PORT}/"; then
    READY=1
    break
  fi
  sleep 0.5
done

if [ -z "$READY" ]; then
  echo "[preview] server never came up — see the log above" >&2
else
  # No single launcher is reliable across environments, and each fails
  # SILENTLY in its own way:
  #   osascript      — needs macOS Automation permission for whatever is
  #                    running this script; denied, it errors (-1743) and,
  #                    with stderr hidden, looks like success.
  #   open -a / open — exit 0 while opening nothing under some sandboxes.
  #   vite --open    — follows the OS default handler, which isn't Chrome.
  # So: find out whether Apple Events actually work before trusting them,
  # try everything, and say plainly what happened.
  apple_events_ok() {
    osascript -e 'tell application "Google Chrome" to count windows' >/dev/null 2>&1
  }
  chrome_has_url() {
    osascript -e "tell application \"Google Chrome\"
      repeat with w in windows
        repeat with t in tabs of w
          if URL of t contains \"localhost:${PORT}\" then return \"yes\"
        end repeat
      end repeat
      return \"no\"
    end tell" 2>/dev/null | grep -q yes
  }

  OPENED=""
  if apple_events_ok; then
    osascript -e "tell application \"Google Chrome\" to open location \"$URL\"" \
              -e 'tell application "Google Chrome" to activate' >/dev/null 2>&1
    sleep 2
    chrome_has_url && OPENED="applescript"
  else
    echo "[preview] (no Automation permission for Chrome — using open(1))"
  fi

  if [ -z "$OPENED" ]; then
    open -a "Google Chrome" "$URL" >/dev/null 2>&1 && OPENED="open -a"
    sleep 2
  fi
  if [ -z "$OPENED" ]; then
    open "$URL" >/dev/null 2>&1 && OPENED="open"
    sleep 2
  fi

  echo ""
  echo "  ────────────────────────────────────────────────────────────"
  echo "   $URL"
  if [ -n "$OPENED" ]; then
    echo "   opened in Chrome via $OPENED — cmd-click above if you lost it"
  else
    echo "   Chrome would not open on its own — cmd-click the URL above"
  fi
  echo "  ────────────────────────────────────────────────────────────"
  echo ""
fi

wait "$DEV_PID"
