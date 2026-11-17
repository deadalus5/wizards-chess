#!/bin/bash
# Dev helper: contact sheet of one clip in the clip lab.
#   scripts/clipsheet.sh <out.png> <clip> [prop=none] [frames=12] [cols=6] [view "px,py,pz,tx,ty,tz,fov"]
S="${SHOT_DIR:-/tmp/clipsheet}"; mkdir -p "$S"; find "$S" -name 'c*.png' -delete
out="$1"; clip="$2"; prop="${3:-none}"; frames="${4:-12}"; cols="${5:-6}"; view="${6:-3.6,1.5,4.6,1.1,1.0,0,30}"
cd "$(dirname "$0")/.."
dur=$(node scripts/browser.mjs eval "await window.__lab.ready; await window.__lab.show('$clip', 0, '$prop'); window.__lab.look($view); return window.__lab.state.chars[0].clip.duration")
shots=()
for i in $(seq 0 $((frames-1))); do
  t=$(python3 -c "print(round($dur * $i / max(1, $frames - 1), 4))")
  node scripts/browser.mjs eval "window.__lab.setTime($t); await new Promise(r => setTimeout(r, 120)); return 1" > /dev/null
  f=$(printf "$S/c%02d.png" $i); node scripts/browser.mjs shot "$f" --w=420 --h=420 > /dev/null; shots+=("$f")
done
./scripts/sheet.sh "$out" "$cols" "${shots[@]}" > /dev/null
echo "$out (duration $dur s, $frames frames)"
