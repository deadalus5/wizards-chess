#!/bin/bash
# Dev helper: four views (front, three-quarter, side, back) of one statue on its own, as one sheet.
#   scripts/piecesheet.sh <out.png> <code e.g. wq> [cols=4] [w=520] [h=760]
# Every other statue and the interface are hidden while the views are taken and shown again
# afterwards. The camera stands back in proportion to the statue's height, head-piece included.
S="${SHOT_DIR:-/tmp/piecesheet}"; mkdir -p "$S"
out="$1"; code="$2"; cols="${3:-4}"; w="${4:-520}"; h="${5:-760}"
cd "$(dirname "$0")/.."
node scripts/browser.mjs eval "const t0 = performance.now(); while (!window.__swReady) { await new Promise(r => setTimeout(r, 200)); if (performance.now() - t0 > 40000) throw new Error('not ready'); } const sw = window.__sw; const keep = sw.cast.living().find(a => a.side + a.type === '${code}'); if (!keep) throw new Error('no ${code}'); for (const a of sw.cast.living()) a.setVisible(a === keep); document.getElementById('hud').style.visibility = 'hidden'; return 1" > /dev/null || exit 1
shots=()
i=0
for az in 0 0.75 1.5708 3.1416; do
  node scripts/browser.mjs eval "const sw = window.__sw; const a = sw.cast.living().find(x => x.side + x.type === '${code}'); const k = a.design.scale; sw.at('${code}', 0, a.height * 2.2, ${az}, (a.height * 0.6) / k, 28, (a.height * 0.5) / k); await new Promise(r => setTimeout(r, 350)); return 1" > /dev/null
  f="$S/${code}-$i.png"; node scripts/browser.mjs shot "$f" --w=$w --h=$h > /dev/null; shots+=("$f"); i=$((i+1))
done
node scripts/browser.mjs eval "for (const a of window.__sw.cast.living()) a.setVisible(true); document.getElementById('hud').style.visibility = ''; window.__sw.free(); return 1" > /dev/null
./scripts/sheet.sh "$out" "$cols" "${shots[@]}"
