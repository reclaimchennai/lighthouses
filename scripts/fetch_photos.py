"""Back up every station photo and publish a local copy for the site.

  raw/photos/<station id>/<original file>   untouched original from DGLL / Wikimedia Commons
  web/photos/<station id>.jpg               800 px wide JPEG served by the site
  build/photos.json                         {station id: {src, file, bytes, sha256, width, height}}

The DGLL detail page carries one station photo (the lazy-loaded /sites/default/files/<yyyy-mm>/
image that is not site chrome). Stations without a DGLL photo use their Wikidata image.
"""
import hashlib
import html
import io
import json
import re
import subprocess
import time
import urllib.parse
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw" / "photos"
WEB = ROOT / "web" / "photos"
UA = "Mozilla/5.0 (lighthouses archive; maps.reclaimchennai.city)"
CHROME = re.compile(r"(f-logo|facebook|instagram|x-white|youtube|dgindia|data\.gov|digital-india|Pdf_Icon|/icons/)", re.I)


def fetch(url, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["curl", "-sSL", "--retry", "3", "-A", UA, "-o", str(dest), url], check=True)
    time.sleep(0.3)


def detail_photo(page):
    """The station photo is the one image DGLL also renders as a photo-gallery thumbnail
    (styles/photo_gallery_…/public/<path>); site chrome such as the india.gov.in logo is not."""
    s = page.read_text(errors="replace")
    gallery = re.findall(r'/sites/default/files/styles/photo_gallery[^/]*/public/([^"?]+)', s)
    if gallery:
        return "https://www.dgll.nic.in/sites/default/files/" + html.unescape(gallery[0])
    for src in re.findall(r'<img[^>]+src="(/sites/default/files/(?!styles/)[^"]+\.(?:jpe?g|png|webp))"', s, re.I):
        if not CHROME.search(src) and not re.search(r"india|gov|logo|emblem|banner", src, re.I):
            return "https://www.dgll.nic.in" + html.unescape(src)
    return None


def commons_file(url):
    """Wikidata image values are Special:FilePath links; fetch the original file."""
    name = urllib.parse.unquote(url.rsplit("/", 1)[-1])
    return "https://commons.wikimedia.org/wiki/Special:FilePath/" + urllib.parse.quote(name)


def main():
    data = json.loads((ROOT / "web" / "data" / "lighthouses.json").read_text())
    ledgers = json.loads((ROOT / "build" / "ledgers.json").read_text()) if (ROOT / "build" / "ledgers.json").exists() else {}
    WEB.mkdir(parents=True, exist_ok=True)
    out = {}
    for st in data["stations"]:
        sid = st["id"]
        src = None
        page = ROOT / "raw" / "dgll" / "detail" / f"{(st.get('page_url') or '').rstrip('/').rsplit('/', 1)[-1]}.html"
        if st.get("page_url") and page.exists():
            src = detail_photo(page)
        if not src and st.get("photo") and not re.search(r"india_gov|data\.gov|digital-india|dgindia|logo|emblem|banner", st["photo"], re.I):
            src = commons_file(st["photo"]) if "wikimedia" in st["photo"] or "wikidata" in st["photo"] else st["photo"]
        if not src:
            # no real photo: remove any earlier wrong copy (a site banner picked up by mistake)
            (WEB / f"{sid}.jpg").unlink(missing_ok=True)
            if (RAW / sid).is_dir():
                for f in (RAW / sid).iterdir():
                    f.unlink()
                (RAW / sid).rmdir()
            continue
        name = urllib.parse.unquote(src.split("?")[0].rsplit("/", 1)[-1]) or "photo.jpg"
        dest = RAW / sid / name
        if not dest.exists() or dest.stat().st_size == 0:
            try:
                fetch(src, dest)
            except subprocess.CalledProcessError:
                print("failed", sid, src)
                continue
        for other in dest.parent.iterdir():      # drop an earlier wrong pick (site chrome)
            if other != dest:
                other.unlink()
        blob = dest.read_bytes()
        try:
            im = ImageOps.exif_transpose(Image.open(io.BytesIO(blob)))    # upright, as a browser shows it
            im = im.convert("RGB")
        except Exception:
            print("not an image", sid, src)
            continue
        w, h = im.size

        def tier(width, path, quality):
            t = im if im.width <= width else im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
            path.parent.mkdir(parents=True, exist_ok=True)
            t.save(path, "JPEG", quality=quality, optimize=True, progressive=True)
            return path.stat().st_size

        tier(480, WEB / "thumb" / f"{sid}.jpg", 72)                   # card: a few tens of KB
        preview = tier(1280, WEB / f"{sid}.jpg", 80)                  # viewer opens on this: legible, fast
        ext = dest.suffix.lower() if dest.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp") else ".jpg"
        full = WEB / "full" / f"{sid}{ext}"                           # the untouched original, loaded on request
        full.parent.mkdir(parents=True, exist_ok=True)
        if not full.exists() or full.stat().st_size != len(blob):
            full.write_bytes(blob)
        out[sid] = {"src": src, "file": str(dest.relative_to(ROOT)), "bytes": len(blob),
                    "sha256": hashlib.sha256(blob).hexdigest(), "width": w, "height": h,
                    "full": f"photos/full/{sid}{ext}", "preview_bytes": preview,
                    "credit": "Wikimedia Commons" if "wikimedia" in src else "DGLL"}
    (ROOT / "build" / "photos.json").write_text(json.dumps(out, indent=1))
    print(f"{len(out)} photos backed up")


if __name__ == "__main__":
    main()
