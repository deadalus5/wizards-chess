#!/bin/bash
# Dev helper: play one move with the game's own camera and save full-size stills at given times.
#   scripts/keyframes.sh <out-prefix> <fen> <uci> <w> <h> <t1> [t2 ...]     (seconds after the move starts, increasing)
#   Optional env SETUP: extra JS run after the position loads (e.g. a fixed camera with sw.look).
prefix="$1"; fen="$2"; uci="$3"; w="$4"; h="$5"; shift 5
cd "$(dirname "$0")/.."
node scripts/browser.mjs resize $w $h > /dev/null
node scripts/browser.mjs eval "const t0 = performance.now(); while (!window.__swReady) { await new Promise(r => setTimeout(r, 200)); if (performance.now() - t0 > 60000) throw new Error('not ready'); } const sw = window.__sw; sw.manual(false); sw.free(); sw.load('$fen'); ${SETUP:-} await new Promise(r => setTimeout(r, 400)); sw.manual(true); sw.step(0.1); sw.begin('$uci'); return 1" > /dev/null || exit 1
now=0
for t in "$@"; do
  node scripts/browser.mjs eval "const sw = window.__sw; let left = $t - $now; while (left > 1e-6) { const d = Math.min(left, 1/60); sw.step(d, Math.round(1/d)); left -= d; } await Promise.resolve(); return 1" > /dev/null
  now=$t
  node scripts/browser.mjs shot "${prefix}-${t}.png" > /dev/null
  echo "${prefix}-${t}.png"
done
node scripts/browser.mjs eval "window.__sw.manual(false); return 1" > /dev/null
node scripts/browser.mjs resize 1600 860 > /dev/null
