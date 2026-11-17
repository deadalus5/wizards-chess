#!/bin/bash
# Dev helper: close-ups of each piece type of one side plus a wide shot, as one contact sheet.
#   scripts/lineup.sh <out.png> [side=w] [extra js]
S="${SHOT_DIR:-/tmp/lineup}"; mkdir -p "$S"
out="$1"; side="${2:-w}"; pre="${3:-}"
cd "$(dirname "$0")/.."
node scripts/browser.mjs eval "const t0 = performance.now(); while (!window.__swReady) { await new Promise(r => setTimeout(r, 200)); if (performance.now() - t0 > 40000) throw new Error('not ready'); } const sw = window.__sw; $pre; return 1" > /dev/null || exit 1
shots=()
i=0
for t in p n b r q k; do
  node scripts/browser.mjs eval "window.__sw.at('${side}${t}', 0, 3.4, 0.55, 1.45, 28, 1.2); await new Promise(r => setTimeout(r, 350)); return 1" > /dev/null
  f="$S/l$i.png"; node scripts/browser.mjs shot "$f" --w=560 --h=760 > /dev/null; shots+=("$f"); i=$((i+1))
done
./scripts/sheet.sh "$out" 6 "${shots[@]}"
