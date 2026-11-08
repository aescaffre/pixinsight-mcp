#!/bin/bash
# Relaunch PixInsight headlessly with the RC-Astro suite installed and the MCP watcher started
# (validated 2026-10-29: watcher-state.json appeared 12 s after launch, BXT/NXT/SXT present).
# macOS only (uses open -a / pgrep). On Windows/Linux start PixInsight with -r=<repo>/pjsr/pixinsight-mcp-watcher.js.
# Usage: scripts/pi-relaunch.sh [--kill]   (--kill: terminate a running/stalled instance first)
set -u
PI_BIN="/Applications/PixInsight/PixInsight.app"
MODULE="/Applications/PixInsight/bin/RCAstroSuite-pxm.dylib"
WATCHER="$(cd "$(dirname "$0")/.." && pwd)/pjsr/pixinsight-mcp-watcher.js"
B="$HOME/.pixinsight-mcp/bridge"
if [ "${1:-}" = "--kill" ]; then
  PID=$(pgrep -x PixInsight || true)
  if [ -n "$PID" ]; then echo "killing PixInsight $PID"; kill -9 $PID; sleep 3; fi
  # PI dead: its swap files are orphans (never delete them with images open)
  find /var/folders -name '~PI~*' -user "$USER" -delete 2>/dev/null
fi
if pgrep -x PixInsight >/dev/null; then echo "PixInsight already running — use --kill to restart"; exit 1; fi
node "$(dirname "$0")/setup-watcher.mjs" >/dev/null 2>&1 || true   # (re)generate pjsr/mcp-solver-paths.jsh
JSH="$(dirname "$WATCHER")/mcp-solver-paths.jsh"; [ -f "$JSH" ] || echo "// ImageSolver include not generated (node missing?)" > "$JSH"
rm -f "$B/executing.json" "$B/watcher-state.json"; find "$B/commands" "$B/results" -name '*.json' -delete 2>/dev/null
open -a "$PI_BIN" --args -m="$MODULE" -r="$WATCHER" --no-startup-check-updates
for i in $(seq 1 60); do
  if [ -f "$B/watcher-state.json" ]; then echo "watcher up after ~$((i*3)) s: $(cat "$B/watcher-state.json")"; exit 0; fi
  sleep 3
done
echo "watcher did not come up within 180 s — check the PixInsight console"; exit 2
