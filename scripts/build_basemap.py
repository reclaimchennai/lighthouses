#!/usr/bin/env python3
"""
Build the dark vector basemap and the land mask for the India lighthouse map.

Same idea as tn-flights/scripts/fetch_basemap.py (Natural Earth + DataMeet,
no tile server, no API key), widened to the whole Indian coast and islands.

Outputs (web/data/):
  basemap.json  {land, india, states, lakes}  simplified GeoJSON for drawing
Outputs (build/):
  land_mask.geojson  higher-detail land used to clip light / radio reach to sea

Run with the tn-flights venv (geopandas + shapely):
  ~/projects/tn-flights/flights/.venv/bin/python scripts/build_basemap.py
"""
import json
import os
import urllib.request

import geopandas as gpd
from shapely.geometry import box, mapping
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(HERE, "raw", "basemap")
WEB = os.path.join(HERE, "web", "data")
BUILD = os.path.join(HERE, "build")
UA = {"User-Agent": "reclaimchennai-lighthouses/1.0"}

# lon/lat box, wider than maxBounds so no clipped land edge is ever on screen
VIEW = box(45.0, -12.0, 112.0, 42.0)

NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"
NE_LAYERS = ["ne_10m_land", "ne_10m_minor_islands", "ne_10m_lakes", "ne_10m_admin_0_countries"]
# Survey of India compliant outline + states, from datameet/maps (already vetted in ~/projects/cpi)
CPI_GEO = os.path.expanduser("~/projects/cpi/web/geo")


def fetch(name: str) -> str:
    os.makedirs(RAW, exist_ok=True)
    path = os.path.join(RAW, name + ".geojson")
    if not os.path.exists(path):
        print("  downloading", name)
        with urllib.request.urlopen(urllib.request.Request(NE + name + ".geojson", headers=UA), timeout=300) as r:
            open(path, "wb").write(r.read())
    return path


def fc(geoms, props=None):
    feats = []
    for i, g in enumerate(geoms):
        if g is None or g.is_empty:
            continue
        feats.append({"type": "Feature", "properties": (props[i] if props else {}), "geometry": mapping(g)})
    return {"type": "FeatureCollection", "features": feats}


def rounded(obj, nd=3):
    """Round coordinates to keep the payload small (3 dp ~ 110 m)."""
    if isinstance(obj, float):
        return round(obj, nd)
    if isinstance(obj, (list, tuple)):
        return [rounded(o, nd) for o in obj]
    if isinstance(obj, dict):
        return {k: rounded(v, nd) for k, v in obj.items()}
    return obj


def main():
    os.makedirs(WEB, exist_ok=True)
    os.makedirs(BUILD, exist_ok=True)

    land = gpd.read_file(fetch("ne_10m_land")).clip(VIEW)
    islands = gpd.read_file(fetch("ne_10m_minor_islands")).clip(VIEW)
    lakes = gpd.read_file(fetch("ne_10m_lakes")).clip(VIEW)
    india = gpd.read_file(os.path.join(CPI_GEO, "india-outline.geojson")).to_crs(4326)
    states = gpd.read_file(os.path.join(CPI_GEO, "india-states.geojson")).to_crs(4326)

    land_all = unary_union(list(land.geometry) + list(islands.geometry) + list(india.geometry))

    # detailed mask for sea clipping (light range, NAVTEX reach)
    with open(os.path.join(BUILD, "land_mask.geojson"), "w") as f:
        json.dump(fc([land_all]), f)

    draw_land = land_all.simplify(0.004, preserve_topology=True)
    draw_india = unary_union(list(india.geometry)).simplify(0.004, preserve_topology=True)
    st = states.copy()
    st["geometry"] = st.geometry.simplify(0.006, preserve_topology=True)
    st_lines = [g.boundary for g in st.geometry]
    draw_lakes = [g.simplify(0.004, preserve_topology=True) for g in lakes.geometry if g.area > 0.01]

    out = {
        "land": fc([draw_land]),
        "india": fc([draw_india]),
        "states": fc(st_lines, [{"name": n} for n in st["NAME_1"]]),
        "lakes": fc(draw_lakes),
    }
    path = os.path.join(WEB, "basemap.json")
    with open(path, "w") as f:
        json.dump(rounded(out), f, separators=(",", ":"))
    print(f"basemap.json {os.path.getsize(path) / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
