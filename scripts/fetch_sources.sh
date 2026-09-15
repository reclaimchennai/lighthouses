#!/usr/bin/env bash
# Re-fetch every source into raw/ so the map can be rebuilt from the latest data.
#   DGLL regional pages -> per-station detail pages -> Master Ledger PDFs (pdftotext)
#   DGLL NAVTEX / RACON / VTS / lighthouse-count pages
#   Lighthouse Directory (Rowlett) India pages
#   OpenStreetMap seamark lights (Overpass), Wikidata lighthouses (SPARQL)
# Natural Earth is fetched by build_basemap.py on first run.
#
# Usage: scripts/fetch_sources.sh && scripts/refresh.sh
set -euo pipefail
cd "$(dirname "$0")/.."
RAW=raw
UA="Mozilla/5.0 (reclaimchennai-lighthouses; maps.reclaimchennai.city)"
DGLL=https://www.dgll.nic.in
mkdir -p $RAW/dgll/detail $RAW/dgll/ledger $RAW/osm $RAW/wikidata $RAW/rowlett $RAW/wikipedia

echo "== DGLL region indexes"
# Region slugs as DGLL publishes them (kochi / vishakhapatnam / vts-gandhi-dham are not in the site menu)
REGIONS="vts-gandhi-dham jamnagar mumbai goa kochi chennai vishakhapatnam kolkata portblair"
for r in $REGIONS; do
  curl -sfL --max-time 90 -A "$UA" -o "$RAW/dgll/reg_$r.html" "$DGLL/DGLL-light-house-location/$r"
done
grep -ohE 'href="/DGLL-light-house-location/[a-z-]+/[a-z0-9-]+"' $RAW/dgll/reg_*.html \
  | sed -E 's/href="//;s/"$//' | grep -v contact | sort -u > $RAW/dgll/links.txt
echo "   $(wc -l < $RAW/dgll/links.txt) station pages"

python3 - <<'EOF'
import json, re
m = {}
for l in open("raw/dgll/links.txt"):
    p = l.strip().split("/")
    m[p[-1]] = re.sub("^about-", "", p[-2])
json.dump(m, open("raw/dgll/regions.json", "w"), indent=1)
EOF

echo "== DGLL station pages + Master Ledgers"
xargs -P 8 -I{} sh -c 'curl -sfL --max-time 60 -A "$1" -o "raw/dgll/detail/$(basename {}).html" "$2{}" || true' _ "$UA" "$DGLL" < $RAW/dgll/links.txt
: > $RAW/dgll/pdfs.txt
for f in $RAW/dgll/detail/*.html; do
  p=$(grep -oE 'href="/sites/default/files/[^"]+\.pdf"' "$f" | head -1 | sed -E 's/href="//;s/"$//' || true)
  [ -n "$p" ] && echo "$(basename "$f" .html) $DGLL$p" >> $RAW/dgll/pdfs.txt
done
xargs -P 8 -L1 sh -c 'curl -sfL --max-time 90 -A "Mozilla/5.0" -o "raw/dgll/ledger/$0.pdf" "$1" && pdftotext -layout "raw/dgll/ledger/$0.pdf" "raw/dgll/ledger/$0.txt" 2>/dev/null || echo "   ledger failed: $0"' < $RAW/dgll/pdfs.txt
echo "   $(ls $RAW/dgll/ledger/*.txt | wc -l) ledgers"

for p in navtex racon vts lighthouses; do
  curl -sfL --max-time 60 -A "$UA" -o "$RAW/dgll/dgll_$p.html" "$DGLL/about-DGLL/Service-reminders/$p"
done

echo "== Lighthouse Directory (Rowlett)"
for p in ingjw ingje ingjs inmh inga inka inkl inld intn inap inod inwb inan; do
  curl -sfL --max-time 60 -A "$UA" -o "$RAW/rowlett/$p.htm" "https://www.ibiblio.org/lighthouse/$p.htm"
done

echo "== OpenStreetMap (Overpass)"
Q='[out:json][timeout:240];(nwr["seamark:type"~"^light_(major|minor|vessel)$"](5.5,67.5,24.5,97.5);nwr["man_made"="lighthouse"](5.5,67.5,24.5,97.5););out center tags;'
for u in https://overpass-api.de/api/interpreter https://overpass.kumi.systems/api/interpreter; do
  if curl -sf --max-time 250 "$u" --data-urlencode "data=$Q" -o $RAW/osm/.tmp.json && python3 -c "import json;json.load(open('raw/osm/.tmp.json'))"; then
    mv $RAW/osm/.tmp.json $RAW/osm/osm_lights_all.json; break
  fi
done
Q2='[out:json][timeout:170];(nwr["man_made"="lighthouse"](5.5,67.5,24.5,97.5);nwr["seamark:type"~"^light_(major|minor)$"]["seamark:light:range"~"^(1[5-9]|[2-9][0-9])"](5.5,67.5,24.5,97.5););out center tags;'
for u in https://overpass-api.de/api/interpreter https://overpass.kumi.systems/api/interpreter; do
  if curl -sf --max-time 200 "$u" --data-urlencode "data=$Q2" -o $RAW/osm/.tmp.json && python3 -c "import json;json.load(open('raw/osm/.tmp.json'))"; then
    mv $RAW/osm/.tmp.json $RAW/osm/osm_bbox.json; break
  fi
done

echo "== Wikidata"
curl -sf --max-time 120 -G https://query.wikidata.org/sparql -H 'Accept: application/sparql-results+json' -A "$UA" \
  --data-urlencode 'query=SELECT ?lh ?lhLabel ?coord ?height ?inception ?statusLabel ?dissolved ?focalHeight ?range ?charac ?adminLabel ?image ?enwiki WHERE { ?lh wdt:P31/wdt:P279* wd:Q39715; wdt:P17 wd:Q668. OPTIONAL{?lh wdt:P625 ?coord} OPTIONAL{?lh wdt:P2048 ?height} OPTIONAL{?lh wdt:P571 ?inception} OPTIONAL{?lh wdt:P5817 ?status} OPTIONAL{?lh wdt:P576 ?dissolved} OPTIONAL{?lh wdt:P2923 ?focalHeight} OPTIONAL{?lh wdt:P2929 ?range} OPTIONAL{?lh wdt:P1030 ?charac} OPTIONAL{?lh wdt:P131 ?admin} OPTIONAL{?lh wdt:P18 ?image} OPTIONAL{?enwiki schema:about ?lh; schema:isPartOf <https://en.wikipedia.org/>} SERVICE wikibase:label{bd:serviceParam wikibase:language "en"} }' \
  -o $RAW/wikidata/lighthouses.json

echo "== Lok Sabha answers (tourism list, technologies, budget)"
mkdir -p $RAW/sansad
for f in AU3233_R4EsOl AU949_4qZANz; do
  curl -sfL --max-time 60 -A "$UA" -o "$RAW/sansad/$f.pdf" "https://sansad.in/getFile/lsapps/loksabhaquestions/annex/188/$f.pdf?source=lsapps" \
    && pdftotext -layout "$RAW/sansad/$f.pdf" "$RAW/sansad/$f.txt"
done
# The tourism list, museums, NW-2 sites and budget rows are transcribed into build_data.py
# (TOURISM / MUSEUMS / PLANNED / BUDGET); re-check them when a newer answer is published.

date -u +%FT%TZ > $RAW/FETCHED_AT
echo "fetched $(cat $RAW/FETCHED_AT)"
