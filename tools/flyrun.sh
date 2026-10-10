#!/usr/bin/env bash
# tools/flyrun.sh -- one-shot driver for the --fly-test paired A/B.
#
# Steps (each of them exists because skipping it produced a wrong verdict once):
#   1. kill leftover electron.exe      -- several instances would fight over the
#      window region and over config.json ("lastRunStarted" flips back and forth).
#   2. note the log's current line count, so only THIS run's lines are parsed.
#   3. launch the app with --fly-test. The fixture starts flying ~2.8 s in.
#   4. wait until a FLYSTATE line actually shows up -- do not guess with a sleep.
#      The whole point is to grab frames while the ball is airborne, and the app's
#      startup time varies with disk cache state.
#   5. run tools/screencap.ps1 in a SEPARATE process. In-process capture is not an
#      option: desktopCapturer returns one stale bitmap forever on this machine,
#      and capturePage() cannot see SetWindowRgn at all.
#   6. kill electron, slice out this run's log lines, print a small summary.
#
# USAGE  bash tools/flyrun.sh <outdir> [hold_ms] [count] [gap_ms] [startpoll_ms] [extra args]
#        bash tools/flyrun.sh tools/shots/ab1 40000 60 40
#        bash tools/flyrun.sh tools/shots/ab_lag45 40000 80 30 0 "--region-lag=45"
#
# Then:  python tools/flyab.py --log <outdir>/run.log --shots <outdir>/shots.txt \
#            --manifest <outdir>/manifest.csv
#        powershell -NoProfile -ExecutionPolicy Bypass -File tools/flyscan.ps1 \
#            -Manifest <outdir>/manifest.csv -R 34 -Box 100 > <outdir>/flyscan.txt
#        python tools/flyab.py --report <outdir>/flyscan.txt \
#            --manifest <outdir>/manifest.csv

set -u
cd "$(dirname "$0")/.."

OUT="${1:-tools/shots/ab}"
HOLD="${2:-40000}"
COUNT="${3:-60}"
GAP="${4:-40}"
STARTPOLL="${5:-0}"
EXTRA="${6:-}"

# The IDE's shell exports this. Left set, electron.exe degrades into plain Node:
# it exits 0 without ever creating a window and prints nothing useful.
unset ELECTRON_RUN_AS_NODE

APP="${APPDATA:-$HOME/AppData/Roaming}/DesktopBasketball"
LOG="$APP/runtime.log"
mkdir -p "$OUT"

taskkill //F //IM electron.exe >/dev/null 2>&1
sleep 1

BEFORE=$(wc -l < "$LOG")

./node_modules/electron/dist/electron.exe . --no-gpu --fly-test \
  --fly-hold="$HOLD" --capture-delay=4000 $EXTRA \
  > "$OUT/app.out" 2>&1 &
APP_PID=$!

detected=0
for i in $(seq 1 400); do
  if tail -n +"$((BEFORE + 1))" "$LOG" 2>/dev/null | grep -qa FLYSTATE; then
    detected=1
    break
  fi
  sleep 0.1
done
echo "FLIGHT detected=$detected after $((i * 100))ms of polling (pid=$APP_PID)"
if [ "$detected" != "1" ]; then
  echo "--- app.out ---"; cat "$OUT/app.out"
  taskkill //F //IM electron.exe >/dev/null 2>&1
  exit 1
fi

if [ "$STARTPOLL" -gt 0 ]; then sleep "$STARTPOLL"; fi

powershell -NoProfile -ExecutionPolicy Bypass -File tools/screencap.ps1 \
  -Out "$OUT/scr.png" -Count "$COUNT" -GapMs "$GAP" > "$OUT/shots.txt" 2>&1

taskkill //F //IM electron.exe >/dev/null 2>&1
sleep 1
tail -n +"$((BEFORE + 1))" "$LOG" > "$OUT/run.log"

echo "--- shots.txt head/tail ---"
head -2 "$OUT/shots.txt"; tail -2 "$OUT/shots.txt"
echo "--- this run ---"
echo "FLYSTATE lines : $(grep -ac FLYSTATE "$OUT/run.log")"
echo "FLYLEAD toggles: $(grep -ac FLYLEAD "$OUT/run.log")"
echo "frames written : $(ls "$OUT"/scr_*.png 2>/dev/null | wc -l)"
echo "leftover electron: $(tasklist //FI "IMAGENAME eq electron.exe" 2>/dev/null | grep -c electron.exe)"
