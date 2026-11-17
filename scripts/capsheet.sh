#!/bin/bash
# Dev helper: play one move from a position with the game's own (cinematic) camera and tile frames.
#   scripts/capsheet.sh <out.png> <fen> <uci> [frames=30] [secondsPerFrame=0.22] [cols=6] [w=640] [h=344] [lead=0]
out="$1"; fen="$2"; uci="$3"; frames="${4:-30}"; dt="${5:-0.22}"; cols="${6:-6}"; w="${7:-640}"; h="${8:-344}"; lead="${9:-0}"
exec "$(dirname "$0")/seqsheet.sh" "$out" "sw.free(); sw.load('$fen')" "sw.begin('$uci')" "$frames" "$dt" "$cols" "$w" "$h" "$lead"
