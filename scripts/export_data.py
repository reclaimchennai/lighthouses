"""Export the site's data as plain, reusable files for anyone to download.

  python3 scripts/export_data.py

Reads web/data/{lighthouses,tenders}.json and build/photos.json and writes data/:

  lighthouses.csv / .geojson / .kml   every DGLL station: position, light, optic, tower, equipment, links
  navtex.csv / .geojson               NAVTEX coast stations with identifiers and UTC broadcast slots
  racons.csv / .geojson               RACON radar beacons and their Morse identifiers
  tenders.csv                         DGLL tenders, transcribed, with value, period and linked stations
  budget.csv                          lighthouse funds allocated and used by year (Lok Sabha answers)
  photos.csv                          the station photo archive: source URL, credit, size, checksum
  lighthouses.gpkg                    stations, navtex and racons as one GeoPackage (needs ogr2ogr)

Coordinates are WGS 84 (EPSG:4326) decimal degrees. List and object fields are JSON in CSV cells.
"""
import csv
import json
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data"

# Station columns in reading order; anything new in the build is appended after these.
STATION_COLS = [
    "id", "name", "kind", "region", "lat", "lon", "pos_src", "address",
    "alol", "char", "ckind", "colour", "group", "period", "phases", "phases_src", "flash_s", "sectored", "sectors_text",
    "lum_nm", "geo_nm", "iala_nm", "reach_nm", "intensity_cd", "elev_m",
    "optic", "optic_order", "optic_evidence", "rpm", "panels", "panels_total", "panels_note",
    "led", "solar", "ais", "dgps", "racon", "navtex", "vts",
    "tower_type", "tower_h_m", "tower_colour", "tower_year", "established",
    "visit", "tourism", "museum", "record",
    "ledger_url", "page_url", "rowlett", "arlhs", "wikidata", "photo",
    "transcribed", "no_ledger", "ledger_issues", "equip_years", "equip_since", "tenders",
]
# Rendering internals that mean nothing outside the web app.
STATION_SKIP = {"sim", "sea_mask", "screen_mask", "screen", "photo_local", "photo_meta", "optic_detail"}
OPTIC_DETAIL = ["make", "model", "type", "size"]
# 19 °07.39’ N 72°06.44’ E  or  19 °17’33.41” N 71°16’54.7” E
DMS = re.compile(r"(\d{1,2})\s*°\s*(\d+(?:\.\d+)?)\s*[’']\s*(?:(\d+(?:\.\d+)?)\s*[”\"])?\s*N\s*"
                 r"(\d{2,3})\s*°\s*(\d+(?:\.\d+)?)\s*[’']\s*(?:(\d+(?:\.\d+)?)\s*[”\"])?\s*E")


def dms(deg, minutes, seconds):
    return int(deg) + float(minutes) / 60 + float(seconds or 0) / 3600


def cell(v):
    if v is None:
        return ""
    if isinstance(v, (list, dict)):
        return json.dumps(v, ensure_ascii=False)
    return v


def write_csv(path, rows, cols):
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({c: cell(r.get(c)) for c in cols})
    print(f"{path.relative_to(ROOT)}: {len(rows)} rows")


def write_geojson(path, rows, cols):
    feats = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [r["lon"], r["lat"]]},
              "properties": {c: r.get(c) for c in cols if c not in ("lat", "lon")}}
             for r in rows if r.get("lat") is not None and r.get("lon") is not None]
    path.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False, indent=1))
    print(f"{path.relative_to(ROOT)}: {len(feats)} features")


def main():
    OUT.mkdir(exist_ok=True)
    d = json.loads((ROOT / "web/data/lighthouses.json").read_text())

    stations = []
    for s in d["stations"]:
        row = {k: v for k, v in s.items() if k not in STATION_SKIP}
        for k in OPTIC_DETAIL:
            row[f"optic_{k}"] = (s.get("optic_detail") or {}).get(k)
        row["photo_credit"] = (s.get("photo_meta") or {}).get("credit")
        row["tenders"] = [t.get("nid", t) if isinstance(t, dict) else t for t in s.get("tenders") or []]
        stations.append(row)
    extra = sorted({k for r in stations for k in r} - set(STATION_COLS) - {f"optic_{k}" for k in OPTIC_DETAIL} - {"photo_credit"})
    cols = STATION_COLS[:STATION_COLS.index("optic_evidence") + 1] + [f"optic_{k}" for k in OPTIC_DETAIL] \
        + STATION_COLS[STATION_COLS.index("optic_evidence") + 1:] + ["photo_credit"] + extra
    write_csv(OUT / "lighthouses.csv", stations, cols)
    write_geojson(OUT / "lighthouses.geojson", stations, cols)

    navtex = [{**n, "slots_518": " ".join(n.get("slots_518") or []), "slots_490": " ".join(n.get("slots_490") or [])} for n in d["navtex"]]
    ncols = ["name", "station", "lat", "lon", "id_518", "slots_518", "id_490", "slots_490", "since", "since_src"]
    write_csv(OUT / "navtex.csv", navtex, ncols)
    write_geojson(OUT / "navtex.geojson", navtex, ncols)

    racons = []
    for r in d["racons"]:
        r = {**r, "pos_src": "DGLL RACON list" if r.get("lat") is not None else None}
        # offshore platform beacons have no station: DGLL types the position into the name instead
        m = r["lat"] is None and DMS.search(r["name"])
        if m:
            r.update(lat=round(dms(*m.group(1, 2, 3)), 5), lon=round(dms(*m.group(4, 5, 6)), 5), pos_src="parsed from the DGLL name")
        racons.append(r)
    rcols = ["name", "code", "station", "lat", "lon", "pos_src"]
    write_csv(OUT / "racons.csv", racons, rcols)
    write_geojson(OUT / "racons.geojson", racons, rcols)

    budget = d["parliament"].get("budget") or {}
    rows = [{**r, "unit": budget.get("unit"), "note": budget.get("note"), "source": budget.get("source")} for r in budget.get("rows", [])]
    write_csv(OUT / "budget.csv", rows, ["year", "allocation", "utilisation", "unit", "note", "source"])
    (OUT / "parliament.json").write_text(json.dumps(d["parliament"], ensure_ascii=False, indent=1))

    t = json.loads((ROOT / "web/data/tenders.json").read_text())
    tcols = ["nid", "title", "directorate", "region", "category", "procurement", "scope_level", "start", "end", "bid_opening",
             "summary", "scope", "money", "period", "dates", "eligibility", "specs", "corrigenda", "sites",
             "confidence", "notes", "transcribed", "listing_url", "docs"]
    write_csv(OUT / "tenders.csv", t["tenders"], tcols)

    photos = json.loads((ROOT / "build/photos.json").read_text())
    prow = [{"station": sid, **{k: v for k, v in p.items() if k != "file"}} for sid, p in sorted(photos.items())]
    write_csv(OUT / "photos.csv", prow, ["station", "src", "credit", "width", "height", "bytes", "sha256", "full"])

    shutil.copy2(ROOT / "web/data/light_audit.csv", OUT / "light_audit.csv")

    if shutil.which("ogr2ogr"):
        gpkg = OUT / "lighthouses.gpkg"
        gpkg.unlink(missing_ok=True)
        for layer in ("lighthouses", "navtex", "racons"):
            subprocess.run(["ogr2ogr", "-f", "GPKG", *(["-update"] if gpkg.exists() else []), str(gpkg),
                            str(OUT / f"{layer}.geojson"), "-nln", layer], check=True)
        kml = OUT / "lighthouses.kml"
        kml.unlink(missing_ok=True)
        subprocess.run(["ogr2ogr", "-f", "KML", str(kml), str(OUT / "lighthouses.geojson"), "-dsco", "NameField=name"], check=True)
        print("data/lighthouses.gpkg, data/lighthouses.kml")
    else:
        print("ogr2ogr not found: skipped GeoPackage and KML")


if __name__ == "__main__":
    main()
