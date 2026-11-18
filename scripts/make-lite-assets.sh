#!/bin/bash
# Make the smaller copies of the textures that phones and tablets load, from the full-size files
# already in public/assets, into public/assets/lite (which is committed, like the rest).
#
#   scripts/make-lite-assets.sh
#
# What it makes, and why those sizes:
#   - the board's two marbles at 1024 (the board is what the eye is on, in every shot);
#   - the hall's three stone sets at 512 (seen at a distance, in fog, or out of focus);
#   - the five statue normal maps at 1024, as JPEG (the shader reads only their xyz, and the
#     files' alpha is constant);
#   - the environment at 1k (it lights at 0.2 strength; the cube made from it is a quarter the size).
# Normal maps and the packed AO/roughness/metal maps keep full chroma (4:4:4): their channels are
# data, not colour. The full set stays as it is for the desktop.
#
# Needs ffmpeg (with the hdr codec, i.e. 6.0 or newer).
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=public/assets
OUT=public/assets/lite

# shrink <in> <out> <size> <filter> <pixel format> <jpeg quality 2..31, lower is better>
shrink() {
  mkdir -p "$(dirname "$2")"
  ffmpeg -y -loglevel error -i "$1" -vf "scale=$3:$3:flags=$4" -pix_fmt "$5" -q:v "$6" "$2"
}

for id in Marble014 Marble009; do
  shrink "$SRC/textures/$id/diff.jpg" "$OUT/textures/$id/diff.jpg" 1024 lanczos yuvj420p 3
  shrink "$SRC/textures/$id/rough.jpg" "$OUT/textures/$id/rough.jpg" 1024 lanczos yuvj420p 3
  shrink "$SRC/textures/$id/nor_gl.jpg" "$OUT/textures/$id/nor_gl.jpg" 1024 area yuvj444p 2
done

shrink "$SRC/textures/Marble006/diff.jpg" "$OUT/textures/Marble006/diff.jpg" 512 lanczos yuvj420p 3
shrink "$SRC/textures/Marble006/rough.jpg" "$OUT/textures/Marble006/rough.jpg" 512 lanczos yuvj420p 3
shrink "$SRC/textures/Marble006/nor_gl.jpg" "$OUT/textures/Marble006/nor_gl.jpg" 512 area yuvj444p 2
for id in medieval_blocks_05 monastery_stone_floor; do
  shrink "$SRC/textures/$id/diff.jpg" "$OUT/textures/$id/diff.jpg" 512 lanczos yuvj420p 3
  shrink "$SRC/textures/$id/arm.jpg" "$OUT/textures/$id/arm.jpg" 512 area yuvj444p 3
  shrink "$SRC/textures/$id/nor_gl.jpg" "$OUT/textures/$id/nor_gl.jpg" 512 area yuvj444p 2
done

for name in T_Superhero_Male_Normal T_Superhero_Female_Normal T_Hair_1_Normal T_Hair_2_Normal; do
  shrink "$SRC/models/superhero/$name.png" "$OUT/models/superhero/$name.jpg" 1024 area yuvj444p 2
done
shrink "$SRC/models/chess_set/textures/chess_set_pieces_white_nor_gl_2k.jpg" "$OUT/models/chess_set/textures/chess_set_pieces_white_nor_gl_1k.jpg" 1024 area yuvj444p 2

mkdir -p "$OUT/hdr"
ffmpeg -y -loglevel error -i "$SRC/hdr/sepulchral_chapel_basement_2k.hdr" -vf "scale=1024:512:flags=area" "$OUT/hdr/sepulchral_chapel_basement_1k.hdr"

echo "lite set:"
find "$OUT" -type f | sort | while read -r f; do printf "  %8d  %s\n" "$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f")" "${f#$OUT/}"; done
du -sh "$OUT" | awk '{print "  total " $1}'
