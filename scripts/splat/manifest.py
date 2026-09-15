"""List every finished 3D scan for the site.

  raw/splats/<id>/<id>.sog|.spz + attribution.json [+ view.json]
    -> web/splats/<id>.<ext>, web/splats/<id>.attribution.json, web/data/splats.json
"""
import datetime
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW, WEB = ROOT / "raw" / "splats", ROOT / "web"


def main():
    stations = json.loads((WEB / "data" / "lighthouses.json").read_text())["stations"]
    ids = {s["id"] for s in stations}
    out = {}
    (WEB / "splats").mkdir(exist_ok=True)
    for d in sorted(p for p in RAW.iterdir() if p.is_dir()) if RAW.exists() else []:
        sid = d.name
        scan = next((d / f"{sid}{ext}" for ext in (".sog", ".spz") if (d / f"{sid}{ext}").exists()), None)
        attr = d / "attribution.json"
        if not scan or not attr.exists():
            continue
        if sid not in ids:
            print(f"skip {sid}: not a station id")
            continue
        shutil.copy2(scan, WEB / "splats" / scan.name)
        shutil.copy2(attr, WEB / "splats" / f"{sid}.attribution.json")
        a = json.loads(attr.read_text())
        photos = [p for p in a["photos"] if p.get("file")]
        artists = list(dict.fromkeys(p["artist"] for p in photos if p.get("artist")))
        authors = ", ".join(artists[:3]) + (f" and {len(artists) - 3} others" if len(artists) > 3 else "")
        rec = {"url": f"splats/{scan.name}", "photos": len(photos), "authors": authors or "Wikimedia Commons contributors",
               "licenses": ", ".join(sorted({p["license"] for p in photos if p.get("license")})),
               "attribution": f"splats/{sid}.attribution.json",
               "built": datetime.date.fromtimestamp(scan.stat().st_mtime).isoformat()}
        view = d / "view.json"
        if view.exists():
            rec.update({k: v for k, v in json.loads(view.read_text()).items() if k in ("camera", "target", "quaternion")})
        out[sid] = rec
        print(f"{sid}: {scan.name} {scan.stat().st_size / 1e6:.1f} MB from {len(photos)} photos")
    (WEB / "data" / "splats.json").write_text(json.dumps({"stations": out}, indent=1, ensure_ascii=False))
    print(f"{len(out)} scans listed in web/data/splats.json")


if __name__ == "__main__":
    main()
