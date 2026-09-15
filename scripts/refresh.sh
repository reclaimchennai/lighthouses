#!/usr/bin/env bash
# Rebuild the web payload from raw/ and deploy it to maps.reclaimchennai.city/lighthouses/.
#   scripts/fetch_sources.sh   # optional: pull the latest sources first
#   scripts/refresh.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PY=${PY:-$HOME/projects/tn-flights/flights/.venv/bin/python}   # geopandas + shapely

[ -f web/data/basemap.json ] || $PY scripts/build_basemap.py
python3 scripts/parse_ledgers.py
python3 scripts/parse_rowlett.py
$PY scripts/build_data.py
# backups + tender archive: new tenders need transcribing (build/tender_schema.md) before linking
$PY scripts/fetch_photos.py
$PY scripts/fetch_tenders.py ${REFRESH_TENDERS:+--refresh}
$PY scripts/prep_tenders.py
$PY scripts/link_tenders.py
$PY scripts/build_data.py            # again, to attach photos and tenders to stations

DEST=$HOME/projects/maps-site/lighthouses
mkdir -p "$DEST"
# maps-site is bind-mounted read-only into the caddy container at /var/www/maps-site,
# and the existing maps.reclaimchennai.city block serves it: no Caddy change needed.
rsync -a --delete web/ "$DEST/"
echo "deployed to $DEST -> https://maps.reclaimchennai.city/lighthouses/"
