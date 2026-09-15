"""Prepare tender documents for transcription.

For every backed-up document in build/tenders_index.json:
  build/tender_text/<nid>/<file>.txt       pdftotext -layout text layer, one form feed per page
  build/tender_pages/<nid>/<file>-<n>.png  150 dpi page image for pages with no usable text layer
  build/tender_prep.json                   per document: pages, text chars, scanned page numbers

Scanned pages are read later with Claude vision; text-layer pages are read from the .txt.
"""
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TXT = ROOT / "build" / "tender_text"
IMG = ROOT / "build" / "tender_pages"
MIN_CHARS = 80


def pages_of(pdf):
    out = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True).stdout
    for line in out.splitlines():
        if line.startswith("Pages:"):
            return int(line.split()[1])
    return 0


def main():
    index = json.loads((ROOT / "build" / "tenders_index.json").read_text())
    prep = {}
    for t in index:
        for d in t["docs"]:
            if not d.get("path") or not d.get("is_pdf"):
                continue
            pdf = ROOT / d["path"]
            stem = pdf.stem
            txt = TXT / str(t["nid"]) / f"{stem}.txt"
            txt.parent.mkdir(parents=True, exist_ok=True)
            if not txt.exists():
                subprocess.run(["pdftotext", "-layout", str(pdf), str(txt)], capture_output=True)
            pages = txt.read_text(errors="replace").split("\f") if txt.exists() else []
            n = pages_of(pdf) or len(pages)
            scanned = [i + 1 for i in range(n) if i >= len(pages) or len(pages[i].strip()) < MIN_CHARS]
            for p in scanned:
                png = IMG / str(t["nid"]) / f"{stem}-{p}.png"
                if not png.exists():
                    png.parent.mkdir(parents=True, exist_ok=True)
                    subprocess.run(["pdftoppm", "-r", "150", "-png", "-singlefile", "-f", str(p), "-l", str(p),
                                    str(pdf), str(png.with_suffix(""))], capture_output=True)
            prep[d["path"]] = {"nid": t["nid"], "pages": n, "text_chars": sum(len(x.strip()) for x in pages),
                               "scanned_pages": scanned, "txt": str(txt.relative_to(ROOT))}
    (ROOT / "build" / "tender_prep.json").write_text(json.dumps(prep, indent=1))
    docs = len(prep)
    pages = sum(v["pages"] for v in prep.values())
    scans = sum(len(v["scanned_pages"]) for v in prep.values())
    print(f"{docs} PDFs, {pages} pages, {scans} scanned pages needing vision")


if __name__ == "__main__":
    main()
