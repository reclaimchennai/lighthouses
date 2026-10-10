#!/usr/bin/env bash
# Encode the frames rendered by film.mjs into an H.264 MP4.
#   film_encode.sh <framesdir> <out.mp4> [ffmpeg]
# Needs an ffmpeg with libx264 (e.g. `pip install imageio-ffmpeg`, then its bundled binary).
set -euo pipefail
dir=$1; out=$2; ff=${3:-ffmpeg}
list=$(mktemp)
for d in $(ls -d "$dir"/shot-* | sort); do
  for f in $(ls "$d"/f*.jpg | sort); do echo "file '$f'"; done
done > "$list"
"$ff" -y -loglevel error -r 12 -f concat -safe 0 -i "$list" -r 12 \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart "$out"
rm -f "$list"
