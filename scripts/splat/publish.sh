#!/usr/bin/env bash
# Send a finished scan from mi6 to the server, then list it in the site's manifest.
#   LH_SERVER=user@host scripts/splat/publish.sh chennai-lighthouse
set -euo pipefail
ID=${1:?station id}
SERVER=${LH_SERVER:?set LH_SERVER=user@host of the server that runs maps.reclaimchennai.city}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DIR=$ROOT/raw/splats/$ID
FILES=("$DIR/attribution.json")
for f in "$ID.sog" "$ID.spz" "view.json"; do [ -f "$DIR/$f" ] && FILES+=("$DIR/$f"); done
ssh "$SERVER" "mkdir -p ~/projects/lighthouses/raw/splats/$ID"
rsync -av "${FILES[@]}" "$SERVER:projects/lighthouses/raw/splats/$ID/"
ssh "$SERVER" "cd ~/projects/lighthouses && python3 scripts/splat/manifest.py && rsync -a --delete web/ ~/projects/maps-site/lighthouses/"
echo "Published: https://maps.reclaimchennai.city/lighthouses/#$ID (card → 3D scan)"
