#!/bin/bash
# Dev helper: play one move under manual stepping and tile frames into a contact sheet.
#   scripts/movesheet.sh <out.png> <fen|start> <uci> <frames> <secondsPerFrame> "<camera js>" [cols] [w] [h] [lead seconds]
S="${SHOT_DIR:-/tmp/movesheet}"; mkdir -p "$S"; find "$S" -name 'f*.png' -delete
out="$1"; fen="$2"; uci="$3"; frames="$4"; dt="$5"; cam="$6"; cols="${7:-6}"; w="${8:-520}"; h="${9:-420}"; lead="${10:-0}"
cd "$(dirname "$0")/.."
load="sw.load()"; [ "$fen" != "start" ] && load="sw.load('$fen')"
node scripts/browser.mjs resize $w $h > /dev/null
node scripts/browser.mjs eval "const t0 = performance.now(); while (!window.__swReady) { await new Promise(r => setTimeout(r, 200)); if (performance.now() - t0 > 60000) throw new Error('not ready'); } const sw = window.__sw; sw.manual(false); $load; await new Promise(r => setTimeout(r, 300)); sw.manual(true); $cam; sw.step(0.2); sw.begin('$uci'); sw.step(Math.max(0.0001, $lead)); return 1" > /dev/null || exit 1
shots=()
for i in $(seq 0 $((frames-1))); do
  f=$(printf "$S/f%02d.png" $i); node scripts/browser.mjs shot "$f" > /dev/null; shots+=("$f")
  node scripts/browser.mjs eval "window.__sw.step($dt); return 1" > /dev/null
done
node scripts/browser.mjs eval "const sw = window.__sw; let n = 0; while (sw.busy() && n++ < 2000) { sw.step(0.05); await Promise.resolve(); } sw.manual(false); return {consistent: sw.consistent(), fen: sw.fen()}"
node scripts/browser.mjs resize 1600 860 > /dev/null
./scripts/sheet.sh "$out" "$cols" "${shots[@]}" > /dev/null
echo "$out"
