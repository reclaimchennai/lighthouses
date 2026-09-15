"""Gather many photos of one lighthouse for a Gaussian-splat reconstruction.

  python3 scripts/splat/fetch_views.py <station id> "<Commons category>" [--max 150] [--list]

Walks the Wikimedia Commons category (and its subcategories, except interiors and "views from"
the tower, which don't show the tower itself), downloads each original photo to
raw/splats/<station id>/images/ and writes raw/splats/<station id>/attribution.json with the author,
licence and page of every file. A splat built from these photos is a derivative work: the
attribution list ships with it.
"""
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
API = "https://commons.wikimedia.org/w/api.php"
UA = "lighthouses-map/1.0 (maps.reclaimchennai.city; splat reconstruction)"
SKIP_SUBCAT = re.compile(r"interior|views? from|inside|staircase|lens|museum", re.I)


def api(**params):
    params.update(format="json")
    req = urllib.request.Request(API + "?" + urllib.parse.urlencode(params), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def members(category, kind):
    out, cont = [], {}
    while True:
        d = api(action="query", list="categorymembers", cmtitle=f"Category:{category}", cmtype=kind, cmlimit=500, **cont)
        out += [m["title"] for m in d.get("query", {}).get("categorymembers", [])]
        if "continue" not in d:
            return out
        cont = d["continue"]


def files_in(category, depth=2, seen=None):
    seen = seen or set()
    if category in seen:
        return []
    seen.add(category)
    found = members(category, "file")
    if depth > 0:
        for sub in members(category, "subcat"):
            name = sub.split(":", 1)[1]
            if not SKIP_SUBCAT.search(name):
                found += files_in(name, depth - 1, seen)
    return found


def info(titles):
    # Wikimedia rate-limits bulk downloads of originals (HTTP 429) and asks for its standard thumbnail
    # widths instead; 2560 px is plenty for camera-pose matching and splat training.
    d = api(action="query", prop="imageinfo", titles="|".join(titles), iiprop="url|size|mime|extmetadata", iiurlwidth=2560)
    for page in d.get("query", {}).get("pages", {}).values():
        ii = (page.get("imageinfo") or [{}])[0]
        meta = ii.get("extmetadata", {})
        strip = lambda k: re.sub(r"<[^>]+>", "", (meta.get(k) or {}).get("value", "")).strip()
        yield {"title": page["title"], "url": ii.get("thumburl") or ii.get("url"), "original": ii.get("url"),
               "page": ii.get("descriptionurl"), "mime": ii.get("mime"),
               "width": ii.get("width"), "height": ii.get("height"), "bytes": ii.get("size"),
               "artist": strip("Artist"), "license": strip("LicenseShortName"), "license_url": strip("LicenseUrl"),
               "date": strip("DateTimeOriginal")}


def download(url, dest, tries=6):
    """Fetch with back-off: honour Retry-After on 429 / 5xx, otherwise wait longer each time."""
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=120) as resp:
                dest.write_bytes(resp.read())
            return True
        except urllib.error.HTTPError as e:
            if e.code != 429 and e.code < 500:
                raise
            wait = int(e.headers.get("Retry-After") or 0) or 20 * (attempt + 1)
            print(f"    HTTP {e.code}, waiting {wait} s")
            time.sleep(wait)
    return False


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) < 2:
        sys.exit(__doc__)
    sid, category = args[0], args[1].replace(" ", "_")
    limit = int(sys.argv[sys.argv.index("--max") + 1]) if "--max" in sys.argv else 150
    titles = [t for t in dict.fromkeys(files_in(category)) if re.search(r"\.(jpe?g|png|tiff?)$", t, re.I)][:limit]
    rows = []
    for i in range(0, len(titles), 40):
        rows += [r for r in info(titles[i:i + 40]) if r["url"] and (r["width"] or 0) >= 1000]
    print(f"{sid}: {len(rows)} photos ≥ 1000 px wide in Category:{category}")
    out = ROOT / "raw" / "splats" / sid
    (out / "images").mkdir(parents=True, exist_ok=True)
    if "--list" in sys.argv:
        for r in rows[:10]:
            print(f"  {r['width']}×{r['height']} {r['license']:<14} {r['title']}")
        return
    for n, r in enumerate(rows, 1):
        stem = Path(re.sub(r"[^\w.-]+", "_", r["title"].split(":", 1)[1])).stem
        dest = out / "images" / (stem + (Path(urllib.parse.urlparse(r["url"]).path).suffix.lower() or ".jpg"))
        if not dest.exists() or dest.stat().st_size == 0:          # resumable: finished files are kept
            if not download(r["url"], dest):
                print(f"  gave up on {r['title']}")
                continue
            time.sleep(2)
        r["file"] = dest.name
        print(f"  [{n}/{len(rows)}] {dest.name}")
    (out / "attribution.json").write_text(json.dumps({"station_id": sid, "category": category, "photos": rows}, indent=1, ensure_ascii=False))
    print(f"wrote {out / 'attribution.json'}")


if __name__ == "__main__":
    main()
