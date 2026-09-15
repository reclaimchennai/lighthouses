"""Merge the tender listings with their transcriptions and attach them to stations.

  in   build/tenders_index.json       listing rows + backed-up documents (fetch_tenders.py)
       build/tender_ai/<nid>.json     transcription per tender (build/tender_schema.md)
       web/data/lighthouses.json      station ids, names, directorates
  out  web/data/tenders.json          the full archive the site serves
       web/tenders/<nid>/<file>       mirror of every document (DGLL removes old notices)
       build/tenders_linked.json      {by_station: {id: [summary…]}, by_directorate: {…}} for build_data.py
"""
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
WEB = ROOT / "web"

# listing directorate label -> station "region"
DIRECTORATE = {"kochi": "Kochi", "cochin": "Kochi", "vts gandhidham": "Gandhidham (VTS)", "gandhidham": "Gandhidham (VTS)",
               "jamnagar": "Jamnagar", "mumbai": "Mumbai", "chennai": "Chennai", "kolkata": "Kolkata", "goa": "Goa",
               "visakhapatnam": "Visakhapatnam", "port blair": "Port Blair", "andaman": "Port Blair",
               "noida": "Headquarters", "headquarters": "Headquarters", "dgll": "Headquarters", "hq": "Headquarters"}


def region_of(label, regions):
    key = (label or "").strip().lower()
    for k, v in DIRECTORATE.items():
        if key.startswith(k) and v in regions | {"Headquarters"}:
            return v
    for r in regions:
        if r.lower() in key:
            return r
    return label or None


def main():
    index = json.loads((BUILD / "tenders_index.json").read_text())
    stations = json.loads((WEB / "data" / "lighthouses.json").read_text())["stations"]
    ids = {s["id"]: s for s in stations}
    regions = {s["region"] for s in stations if s.get("region")}

    out, by_station, by_dir, problems = [], {}, {}, []
    for t in index:
        ai_path = BUILD / "tender_ai" / f"{t['nid']}.json"
        ai = json.loads(ai_path.read_text()) if ai_path.exists() else {}
        docs = []
        for d in t["docs"]:
            if not d.get("path"):
                docs.append({**d, "mirror": None})
                continue
            src = ROOT / d["path"]
            dest = WEB / "tenders" / str(t["nid"]) / src.name
            dest.parent.mkdir(parents=True, exist_ok=True)
            if not dest.exists() or dest.stat().st_size != src.stat().st_size:
                shutil.copy2(src, dest)
            meta = next((x for x in ai.get("documents") or [] if x.get("file") == src.name), {})
            docs.append({"kind": d["kind"], "file": src.name, "url": d["url"], "bytes": d.get("bytes"),
                         "sha256": d.get("sha256"), "mirror": f"tenders/{t['nid']}/{src.name}",
                         "pages": meta.get("pages"), "read": meta.get("read"), "language": meta.get("language"),
                         "unreadable": meta.get("unreadable") or []})
        sites = []
        for site in ai.get("sites") or []:
            sid = site.get("station_id")
            if sid and sid not in ids:
                problems.append(f"{t['nid']}: unknown station_id {sid!r} for {site.get('name')!r}")
                sid = None
            sites.append({**site, "station_id": sid})
        region = region_of(t["directorate"], regions)
        rec = {
            "nid": t["nid"], "title": ai.get("title") or t["title"], "listing_title": t["title"],
            "directorate": t["directorate"], "region": region, "listing": t["listing"],
            "start": t.get("start"), "end": t.get("end"), "bid_opening": t.get("bid_opening"),
            "listing_url": t["listing_url"], "docs": docs, "transcribed": bool(ai),
            **{k: ai.get(k) for k in ("summary", "category", "procurement", "scope_level", "scope", "money",
                                      "period", "dates", "eligibility", "specs", "corrigenda", "confidence", "notes")},
            "sites": sites,
        }
        out.append(rec)
        short = {"nid": t["nid"], "title": rec["title"], "end": rec["end"] or (rec.get("dates") or {}).get("bid_submission_end"),
                 "category": rec.get("category"), "cost": (rec.get("money") or {}).get("estimated_cost_inr")}
        linked = set()
        for site in sites:
            if site["station_id"] and site["station_id"] not in linked:
                linked.add(site["station_id"])
                by_station.setdefault(site["station_id"], []).append({**short, "work": site.get("work")})
        if region:
            by_dir.setdefault(region, []).append(short)

    for v in list(by_station.values()) + list(by_dir.values()):
        v.sort(key=lambda x: x["end"] or "", reverse=True)
    meta = {"tenders": len(out), "transcribed": sum(r["transcribed"] for r in out),
            "documents": sum(len(r["docs"]) for r in out),
            "mirrored": sum(bool(d["mirror"]) for r in out for d in r["docs"]),
            "linked_stations": len(by_station),
            "sources": ["https://www.dgll.nic.in/tenders", "https://www.dgll.nic.in/tenders/tenders-archive"]}
    (WEB / "data" / "tenders.json").write_text(json.dumps({"meta": meta, "tenders": out}, ensure_ascii=False, separators=(",", ":")))
    (BUILD / "tenders_linked.json").write_text(json.dumps({"by_station": by_station, "by_directorate": by_dir}, indent=1, ensure_ascii=False))
    (BUILD / "tender_problems.txt").write_text("\n".join(problems) + "\n")
    print(json.dumps(meta, indent=1))
    print(len(problems), "problems (build/tender_problems.txt)")


if __name__ == "__main__":
    main()
