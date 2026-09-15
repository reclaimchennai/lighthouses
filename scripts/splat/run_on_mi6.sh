#!/usr/bin/env bash
# Build a Gaussian splat of one lighthouse on a machine with a GPU (the mi6 laptop).
#
#   python3 scripts/splat/fetch_views.py chennai-lighthouse "Chennai Lighthouse"   # photos + attribution
#   scripts/splat/run_on_mi6.sh chennai-lighthouse                                  # this script
#   scripts/splat/publish.sh chennai-lighthouse                                     # send to the server
#
# macOS (Apple Silicon): COLMAP (Homebrew) finds the camera poses, OpenSplat trains on Metal.
# Linux + NVIDIA: nerfstudio runs COLMAP and trains splatfacto on CUDA.
# Output: raw/splats/<id>/<id>.ply (full) and <id>.sog (compressed for the web).
set -euo pipefail
ID=${1:?station id}
ITER=${ITER:-30000}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DIR=$ROOT/raw/splats/$ID
WORK=$DIR/work
[ -d "$DIR/images" ] || { echo "No $DIR/images: run scripts/splat/fetch_views.py first"; exit 1; }
N=$(find "$DIR/images" -type f | wc -l | tr -d ' ')
[ "$N" -ge 20 ] || echo "Warning: only $N photos. Splats need ~30+ overlapping views of the tower from around it."
mkdir -p "$WORK"
ln -sfn "$DIR/images" "$WORK/images"

case "$(uname -s)" in
  Darwin)
    command -v colmap >/dev/null || brew install colmap
    command -v opensplat >/dev/null || { echo "Install OpenSplat with Metal first (README: 'OpenSplat on macOS')"; exit 1; }
    # camera poses: sequential matching is wrong for crowd photos, use exhaustive
    colmap feature_extractor --database_path "$WORK/db.db" --image_path "$WORK/images" --ImageReader.single_camera 0
    colmap exhaustive_matcher --database_path "$WORK/db.db"
    mkdir -p "$WORK/sparse"
    colmap mapper --database_path "$WORK/db.db" --image_path "$WORK/images" --output_path "$WORK/sparse"
    colmap image_undistorter --image_path "$WORK/images" --input_path "$WORK/sparse/0" --output_path "$WORK/undist" --output_type COLMAP
    opensplat "$WORK/undist" -n "$ITER" -o "$DIR/$ID.ply"
    ;;
  Linux)
    command -v nvidia-smi >/dev/null || { echo "No NVIDIA GPU found"; exit 1; }
    command -v ns-train >/dev/null || { echo "Install nerfstudio first (README: 'nerfstudio on Linux')"; exit 1; }
    ns-process-data images --data "$WORK/images" --output-dir "$WORK/ns" --matching-method exhaustive
    ns-train splatfacto --data "$WORK/ns" --output-dir "$WORK/runs" --max-num-iterations "$ITER" \
      --viewer.quit-on-train-completion True
    CFG=$(ls -t "$WORK"/runs/*/splatfacto/*/config.yml | head -1)
    ns-export gaussian-splat --load-config "$CFG" --output-dir "$WORK/export"
    cp "$WORK/export/splat.ply" "$DIR/$ID.ply"
    ;;
  *) echo "Unsupported OS"; exit 1 ;;
esac

# Web copy: SOG is ~10-20x smaller than the training PLY and Spark reads it directly.
npx -y @playcanvas/splat-transform "$DIR/$ID.ply" "$DIR/$ID.sog"
echo
echo "Built $DIR/$ID.sog ($(du -h "$DIR/$ID.sog" | cut -f1))."
echo "Check it (and crop floaters / the sky) in SuperSplat: https://superspl.at/editor, export SOG over $DIR/$ID.sog."
echo "Optionally save the starting view to $DIR/view.json: {\"camera\":[x,y,z],\"target\":[x,y,z],\"quaternion\":[x,y,z,w]}."
echo "Then: scripts/splat/publish.sh $ID"
