#!/bin/bash
# Dev helper: capture a standard set of look-dev views into one contact sheet.
#   scripts/lookdev.sh <out.png> [extra js run before capture]
S="${SHOT_DIR:-/tmp/lookdev}"; mkdir -p "$S"
out="$1"; pre="${2:-}"
cd "$(dirname "$0")/.."
node scripts/browser.mjs eval "while (!window.__swReady) await new Promise(r => setTimeout(r, 200)); const sw = window.__sw; $pre; return 1" > /dev/null || exit 1
i=0
shots=()
for v in "3.6,2.0,5.8, 0,1.0,0, 30" "-2.3,1.55,2.6, -0.75,1.25,0, 26" "2.3,1.55,2.6, 0.75,1.25,0, 26" "-1.5,1.74,1.15, -0.76,1.6,0.03, 20"; do
  node scripts/browser.mjs eval "window.__sw.look($v); await new Promise(r => setTimeout(r, 350)); return 1" > /dev/null
  f="$S/v$i.png"; node scripts/browser.mjs shot "$f" --w=860 --h=640 > /dev/null; shots+=("$f"); i=$((i+1))
done
./scripts/sheet.sh "$out" 2 "${shots[@]}"
