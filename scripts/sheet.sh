#!/bin/bash
# Tile a set of images into one contact sheet: sheet.sh <out.png> <columns> <img...>
out="$1"; cols="$2"; shift 2
n=$#
rows=$(( (n + cols - 1) / cols ))
inputs=()
for f in "$@"; do inputs+=(-i "$f"); done
ffmpeg -y -loglevel error "${inputs[@]}" -filter_complex "concat=n=${n}:v=1:a=0,tile=${cols}x${rows}:padding=4:color=black" -frames:v 1 "$out"
echo "$out"
