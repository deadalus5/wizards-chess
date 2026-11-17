#!/bin/bash
# Dev helper: run arbitrary setup + trigger under manual stepping and tile frames.
#   scripts/seqsheet.sh <out.png> "<setup js>" "<trigger js>" <frames> <secondsPerFrame> [cols] [w] [h] [lead seconds]
S="${SHOT_DIR:-/tmp/seqsheet}"; mkdir -p "$S"; find "$S" -name 'f*.png' -delete
out="$1"; setup="$2"; trigger="$3"; frames="$4"; dt="$5"; cols="${6:-6}"; w="${7:-520}"; h="${8:-420}"; lead="${9:-0}"
cd "$(dirname "$0")/.."
node scripts/browser.mjs resize $w $h > /dev/null
node scripts/browser.mjs eval "const t0 = performance.now(); while (!window.__swReady) { await new Promise(r => setTimeout(r, 200)); if (performance.now() - t0 > 60000) throw new Error('not ready'); } const sw = window.__sw; sw.manual(false); $setup; await new Promise(r => setTimeout(r, 400)); sw.manual(true); sw.step(0.1); $trigger; if ($lead > 0) sw.step($lead); return 1" > /dev/null || exit 1
shots=()
for i in $(seq 0 $((frames-1))); do
  f=$(printf "$S/f%02d.png" $i); node scripts/browser.mjs shot "$f" > /dev/null; shots+=("$f")
  node scripts/browser.mjs eval "window.__sw.step($dt); await Promise.resolve(); return 1" > /dev/null
done
node scripts/browser.mjs eval "window.__sw.manual(false); return 1" > /dev/null
node scripts/browser.mjs resize 1600 860 > /dev/null
./scripts/sheet.sh "$out" "$cols" "${shots[@]}" > /dev/null
echo "$out"
