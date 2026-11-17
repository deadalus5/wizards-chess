#!/bin/bash
# Dev helper: all six piece types of one side standing in a row (pawn, knight, bishop, rook,
# queen, king), from the front and from behind, as one contact sheet.
#   scripts/lineup.sh <out.png> [side=w] [extra js]
# The interface is hidden while the views are taken; the starting position is put back afterwards.
S="${SHOT_DIR:-/tmp/lineup}"; mkdir -p "$S"
out="$1"; side="${2:-w}"; pre="${3:-}"
cd "$(dirname "$0")/.."
if [ "$side" = "w" ]; then fen="7k/8/8/8/PNBRQK2/8/8/8 w - - 0 1"; z=0.625; front=-1; else fen="8/8/8/pnbrqk2/8/8/8/7K b - - 0 1"; z=-0.625; front=1; fi
node scripts/browser.mjs eval "const t0 = performance.now(); while (!window.__swReady) { await new Promise(r => setTimeout(r, 200)); if (performance.now() - t0 > 40000) throw new Error('not ready'); } const sw = window.__sw; document.getElementById('hud').style.visibility = 'hidden'; sw.load('$fen'); $pre; return 1" > /dev/null || exit 1
shots=()
i=0
for dir in $front $((-front)); do
  node scripts/browser.mjs eval "window.__sw.look(-1.25 + 1.2 * $dir, 1.55, $z + 7.6 * $dir, -1.25, 1.18, $z, 30); await new Promise(r => setTimeout(r, 400)); return 1" > /dev/null
  f="$S/lineup$i.png"; node scripts/browser.mjs shot "$f" --w=1600 --h=640 > /dev/null; shots+=("$f"); i=$((i+1))
done
node scripts/browser.mjs eval "document.getElementById('hud').style.visibility = ''; window.__sw.free(); window.__sw.load(); return 1" > /dev/null
./scripts/sheet.sh "$out" 1 "${shots[@]}"
