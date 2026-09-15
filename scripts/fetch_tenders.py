"""DGLL tenders: parse the current and archive listings, back up every document.

  raw/tenders/current.html, archive_<n>.html   listing pages (fetched here when missing)
  raw/tenders/docs/<nid>/<file>                every NIT / bid / corrigendum PDF
  build/tenders_index.json                     one row per tender with local doc paths

Run with --refresh to re-fetch the listing pages.
"""
import hashlib
import html
import json
import re
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw" / "tenders"
DOCS = RAW / "docs"
BASE = "https://www.dgll.nic.in"
UA = "Mozilla/5.0 (lighthouses archive; maps.reclaimchennai.city)"


def fetch(url, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["curl", "-sSL", "--retry", "3", "-A", UA, "-o", str(dest), url], check=True)
    time.sleep(0.4)


def text(cell):
    return html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", cell))).strip()


def dmy(s):
    m = re.match(r"(\d{2})/(\d{2})/(\d{4})", s or "")
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else None


def parse_listing(path, listing):
    s = path.read_text(errors="replace")
    table = re.search(r"<table.*?</table>", s, re.S)
    rows = []
    for tr in re.findall(r"<tr>.*?</tr>", table.group(0) if table else "", re.S):
        cells = dict(re.findall(r'<td headers="view-([a-z0-9-]+)-table-column"[^>]*>(.*?)</td>', tr, re.S))
        if not cells:
            continue
        title = text(cells.get("title") or cells.get("nothing-1", ""))
        directorate = text(cells.get("nothing-1", "") if "title" in cells else cells.get("nothing-2", ""))
        dates = text(cells.get("field-date", ""))
        parts = re.findall(r"\d{2}/\d{2}/\d{4}", dates)
        size = text(cells.get("nothing-2", "") if "title" in cells else cells.get("nothing-3", ""))
        docs = []
        for key, kind in (("nothing", "notice"), ("field-corrigendum-document", "corrigendum")):
            for href in re.findall(r'href="([^"]+)"', cells.get(key, "")):
                href = html.unescape(href)
                if "/sites/default/files/" not in href:
                    continue
                docs.append({"kind": kind, "url": urllib.parse.urljoin(BASE, href)})
        rows.append({
            "nid": int(text(cells.get("nid", "0")) or 0),
            "title": title,
            "directorate": directorate,
            "start": dmy(parts[0]) if len(parts) > 1 else None,
            "end": dmy(parts[-1]) if parts else None,
            "bid_opening": dmy(text(cells.get("field-date-of-opening-bid", ""))),
            "size": size,
            "listing": listing,
            "docs": docs,
        })
    return rows


def main():
    refresh = "--refresh" in sys.argv
    pages = [("current", RAW / "current.html", f"{BASE}/tenders")]
    n = 0
    while True:
        p = RAW / f"archive_{n}.html"
        pages.append(("archive", p, f"{BASE}/tenders/tenders-archive?page={n}"))
        if refresh or not p.exists():
            fetch(pages[-1][2], p)
        last = max([int(x) for x in re.findall(r"\?page=(\d+)", p.read_text(errors="replace"))] or [0])
        if n >= last:
            break
        n += 1
    if refresh or not pages[0][1].exists():
        fetch(pages[0][2], pages[0][1])

    by_nid = {}
    for listing, path, url in pages:
        for r in parse_listing(path, listing):
            r["listing_url"] = url
            old = by_nid.get(r["nid"])
            if old:  # tender appears on both lists: keep the richer record, merge documents
                seen = {d["url"] for d in old["docs"]}
                old["docs"] += [d for d in r["docs"] if d["url"] not in seen]
                old["start"] = old["start"] or r["start"]
                if r["listing"] == "current":
                    old["listing"] = "current"
                continue
            by_nid[r["nid"]] = r

    failed = 0
    for r in by_nid.values():
        for d in r["docs"]:
            name = urllib.parse.unquote(d["url"].rsplit("/", 1)[-1])
            dest = DOCS / str(r["nid"]) / name
            if not dest.exists() or dest.stat().st_size == 0:
                try:
                    fetch(d["url"], dest)
                except subprocess.CalledProcessError:
                    failed += 1
                    d["error"] = "download failed"
                    continue
            data = dest.read_bytes()
            d["path"] = str(dest.relative_to(ROOT))
            d["bytes"] = len(data)
            d["sha256"] = hashlib.sha256(data).hexdigest()
            d["is_pdf"] = data[:5] == b"%PDF-"

    out = sorted(by_nid.values(), key=lambda r: -r["nid"])
    (ROOT / "build").mkdir(exist_ok=True)
    (ROOT / "build" / "tenders_index.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))
    ndocs = sum(len(r["docs"]) for r in out)
    print(f"{len(out)} tenders, {ndocs} documents, {failed} failed downloads")


if __name__ == "__main__":
    main()
