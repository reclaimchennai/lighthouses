"""Navigational warnings for India's waters: live from NHO's India WINS map, archived here.

Sources (National Hydrographic Office, hydrobharat.gov.in; public maritime safety information):
  * India WINS (https://hydrobharat.gov.in/india-wins). The public map loads every warning in force from
    /o/nho-headless/map/combined with a token its own page requests. It is read the same way, politely
    (the systemd timer runs every 2 h): NAVTEX (Indian coast, Indian Nav Warnings), NAVAREA VIII and
    Temporary & Preliminary Notices to Mariners (T&P). The page's client key is read from its live
    JavaScript bundle on each run and never written anywhere.
  * "Warnings in force" PDFs (NAVTEX, NAVAREA VIII), parsed with --pdf or --seed-nho, which seed the
    archive with warnings from before this script first ran.

The API only lists what is in force. The archive is built here: every warning keeps first_seen and
last_seen, and becomes "ended" on the first run that no longer lists it.

Outputs
  raw/warnings/api/<yyyy>/<mm>/combined-<utc>.json.gz   each changed API response, untouched
  raw/warnings/pdf/                                     copies of parsed PDFs
  build/warnings_archive.json                           every warning ever seen
  web/data/warnings.json                                in force now, plus those ended in the last 30 days
  web/data/warnings_archive.json                        the full archive (warnings.html)

  python3 scripts/fetch_warnings.py [--deploy]          live ingest
  python3 scripts/fetch_warnings.py --pdf FILE.pdf      seed from a "warnings in force" PDF
  python3 scripts/fetch_warnings.py --seed-nho          seed from the PDFs linked on NHO's pages
"""
import datetime as dt
import gzip
import hashlib
import html
import json
import math
import re
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://hydrobharat.gov.in"
UA = "Mozilla/5.0 (compatible; lighthouses-map/1.0; +https://maps.reclaimchennai.city/lighthouses/)"
RAW = ROOT / "raw" / "warnings"
ARCHIVE = ROOT / "build" / "warnings_archive.json"
STATE = ROOT / "build" / "warnings_state.json"
WEB_DATA = ROOT / "web" / "data"
SITE_DATA = Path.home() / "projects" / "maps-site" / "lighthouses" / "data"
NHO_PDFS = {"NAVTEX": f"{BASE}/documents/d/guest/navtex-warnings-indian-coast",
            "NAVAREA": f"{BASE}/documents/d/guest/in-force-navarea-viii-warnings-2"}
KINDS = {"NavTex": "NAVTEX", "NavArea": "NAVAREA", "NAVTP": "T&P"}
NM = 1852.0
MONTHS = {m: i for i, m in enumerate("JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split(), 1)}


# ------------------------------------------------------------------------------------------ http
def http(url, data=None, headers=None, timeout=90):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def fetch_combined():
    """Exactly what https://hydrobharat.gov.in/india-wins does in a visitor's browser."""
    src = None
    for path in ("/navtex-warnings", "/india-wins", "/navarea-warnings"):   # the bundle is embedded on these pages
        page = http(f"{BASE}{path}").decode("utf-8", "replace")
        src = re.search(r'src="([^"]*india-wins-custom-element/js[^"]*?main\.[0-9a-f]+\.js[^"]*)"', page)
        if src:
            break
    if not src:
        raise RuntimeError("India WINS bundle not found on the page")
    js = http(urllib.parse.urljoin(BASE, html.unescape(src.group(1)).replace("\\", "/"))).decode("utf-8", "replace")
    cid, sec = re.search(r'client_id:"([^"]+)"', js), re.search(r'client_secret:"([^"]+)"', js)
    if not (cid and sec):
        raise RuntimeError("India WINS page key not found in its bundle")
    token = json.loads(http(f"{BASE}/o/oauth2/token",
                            data=urllib.parse.urlencode({"client_id": cid.group(1), "client_secret": sec.group(1),
                                                         "grant_type": "client_credentials"}).encode(),
                            headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}))["access_token"]
    return http(f"{BASE}/o/nho-headless/map/combined",
                headers={"Authorization": f"Bearer {token}", "Accept": "application/json"}, timeout=180)


# ----------------------------------------------------------------------------------- coordinates
TXT_COORD = re.compile(r"(\d{1,2})-(\d{1,2}(?:\.\d+)?)\s*([NS])[\s,]+(\d{1,3})-(\d{1,2}(?:\.\d+)?)\s*([EW])")
TXT_BOX = re.compile(r"WITHIN\s+(\d{1,2})-(\d{1,2}(?:\.\d+)?)\s*N\s+TO\s+(\d{1,2})-(\d{1,2}(?:\.\d+)?)\s*N\s+AND\s+"
                     r"(\d{1,3})-(\d{1,2}(?:\.\d+)?)\s*E\s+TO\s+(\d{1,3})-(\d{1,2}(?:\.\d+)?)\s*E")


def dm(value):
    """'10,33.32', '072,38.05', "17°34'.34N," or "073°04'.58," -> decimal degrees."""
    s = html.unescape(str(value or "")).strip().rstrip(",").strip().replace("’", "'").replace("′", "'")
    neg = bool(re.search(r"[SW]\s*,?$", s))
    s = re.sub(r"[NSEW]\s*,?$", "", s).strip()
    m = re.match(r"^(\d{1,3})\s*[,°º\s]\s*(\d{1,2}(?:\.\d+)?)?\s*'?\s*(\.\d+)?", s)
    if not m:
        return None
    val = int(m.group(1)) + (float(m.group(2) or 0) + float(m.group(3) or 0)) / 60
    return -val if neg else val


def in_region(lat, lon):
    return lat is not None and lon is not None and -40 <= lat <= 35 and 25 <= lon <= 110


def text_coords(msg):
    pts = []
    for d1, m1, h1, d2, m2, h2 in TXT_COORD.findall(msg):
        lat = (int(d1) + float(m1) / 60) * (-1 if h1 == "S" else 1)
        lon = (int(d2) + float(m2) / 60) * (-1 if h2 == "W" else 1)
        if in_region(lat, lon):
            pts.append((round(lat, 5), round(lon, 5)))
    return pts


def text_box(msg):
    m = TXT_BOX.search(msg)
    if not m:
        return None
    g = [float(x) for x in m.groups()]
    la1, la2, lo1, lo2 = g[0] + g[1] / 60, g[2] + g[3] / 60, g[4] + g[5] / 60, g[6] + g[7] / 60
    ring = [[lo1, la1], [lo2, la1], [lo2, la2], [lo1, la2], [lo1, la1]]
    return {"type": "Polygon", "coordinates": [[[round(x, 5), round(y, 5)] for x, y in ring]]}


def circle(lat, lon, r_nm, n=48, a0=0.0, a1=360.0):
    out = []
    for i in range(n + 1):
        b = math.radians(a0 + (a1 - a0) * i / n)
        out.append([round(lon + r_nm * NM * math.sin(b) / (111320 * math.cos(math.radians(lat))), 5),
                    round(lat + r_nm * NM * math.cos(b) / 111320, 5)])
    return out


def bearing(lat1, lon1, lat2, lon2):
    p1, p2, dl = math.radians(lat1), math.radians(lat2), math.radians(lon2 - lon1)
    return (math.degrees(math.atan2(math.sin(dl) * math.cos(p2),
                                    math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl))) + 360) % 360


def km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 12742 * math.asin(math.sqrt(a))


def geometry(feature, pts, radius, msg):
    """GeoJSON from the warning's own feature type; message order wins for polygons (the API list can be
    out of order). Circles and arcs (a sector centred on the first point) become polygons."""
    f = (feature or "").lower()
    try:
        r = float(str(radius).strip()) if str(radius or "").strip() else None
    except ValueError:
        r = None
    if not r:
        m = re.search(r"(?:ARC OF|RADIUS OF|UPTO|UP TO)\s+(\d+(?:\.\d+)?)\s*NM", msg)
        r = float(m.group(1)) if m else None
    if f == "circle" and pts and r:
        return {"type": "Polygon", "coordinates": [circle(pts[0][0], pts[0][1], r)]}
    if f == "arc" and len(pts) >= 3 and r:
        (la, lo), b, c = pts[0], pts[1], pts[2]
        a0, a1 = bearing(la, lo, *b), bearing(la, lo, *c)
        sweep = (a1 - a0) % 360
        if sweep > 180:
            a0, sweep = a1, 360 - sweep
        ring = [[lo, la]] + circle(la, lo, r, 32, a0, a0 + sweep) + [[lo, la]]
        return {"type": "Polygon", "coordinates": [ring]}
    box = text_box(msg)
    if box and f != "point":
        return box
    if f == "polygon" and len(pts) >= 3:
        ring = [[lo, la] for la, lo in pts]
        return {"type": "Polygon", "coordinates": [ring + [ring[0]]]}
    if len(pts) == 1:
        return {"type": "Point", "coordinates": [pts[0][1], pts[0][0]]}
    if pts:
        return {"type": "MultiPoint", "coordinates": [[lo, la] for la, lo in pts]}
    return box


# -------------------------------------------------------------------------------- understanding
def category(types, msg):
    """firing (danger areas), operations (survey, rigs, cables), danger (wrecks, groundings),
    aton (lights, buoys, RACON, DGNSS), notice (T&P) or misc."""
    t = (types or "").strip().lower()
    known = {"firing": "firing", "survey operation": "operations", "rig": "operations",
             "nav danger": "danger", "distress": "danger", "light": "aton", "buoy": "aton"}
    if t in known:
        return known[t]
    for cat, pat in (("firing", r"FIRING|MISSILE|ROCKET|GUNNERY|FLIGHT TRIAL|DANGER (AREA|SECTOR)|LAUNCH"),
                     ("danger", r"SUNK|WRECK|AGROUND|ADRIFT|OBSTRUCTION|DERELICT|LESSER DEPTH|SHOAL|DISTRESS"),
                     ("aton", r"\bLT\b|\bLIGHT\b|BUOY|RACON|DGNSS|DGPS|\bAIS\b|BEACON|LIGHTHOUSE"),
                     ("operations", r"SURVEY|DRILLING|\bRIG\b|CABLE|PIPELINE|DREDG|SEISMIC")):
        if re.search(pat, msg):
            return cat
    return "misc"


EFFECTS = [
    ("racon_off", r"RACON\b[^.]{0,80}?\b(INOPERATIVE|NOT (?:FUNCTIONAL|OPERATIONAL|WORKING)|OFF AIR|UNSERVICEABLE)"),
    ("dgnss_off", r"\b(?:DGNSS|DGPS)\b[^.]{0,80}?\b(OFF AIR|INOPERATIVE|NOT (?:FUNCTIONAL|OPERATIONAL|WORKING))"),
    ("ais_off", r"\bAIS\b[^.]{0,60}?\b(OFF AIR|INOPERATIVE|NOT (?:FUNCTIONAL|OPERATIONAL|WORKING))"),
    ("unlit", r"\b(?:LT|LIGHT|LIGHTHOUSE)\b(?:(?!RACON|BUOY)[^.]){0,60}?\b(UNLIT|EXTINGUISHED|NOT (?:FUNCTIONAL|OPERATIONAL|WORKING)|INOPERATIVE)"),
    ("racon_new", r"NEW RACON|RACON\b[^.]{0,60}?\b(INSTALLED|ESTABLISHED)"),
]


def effects(msg):
    # positions carry decimal points, which would stop the sentence matchers: blank them out first
    plain = TXT_COORD.sub("@", msg).replace("(.)", ".")
    return [name for name, pat in EFFECTS if re.search(pat, plain)]


def cancel_at(msg):
    m = re.search(r"CANCEL THIS (?:MSG|MESSAGE)\s+(\d{2})(\d{2})(\d{2})\s*UTC\s+([A-Z]{3})\s+(\d{2})", msg)
    if m and m.group(4) in MONTHS:
        return f"20{m.group(5)}-{MONTHS[m.group(4)]:02d}-{m.group(1)}T{m.group(2)}:{m.group(3)}:00Z"
    return None


def cancels(msg):
    return sorted({f"{n}/{y}" for n, y in re.findall(r"CANCEL (?:NAVAREA VIII|INW|INDIAN NAV WARNING|NAVTEX)?\s*(\d{1,4})/(\d{2})\b", msg)})


def group_key(msg):
    body = re.sub(r"\b\d\.\s*CANCEL THIS.*$", "", msg)
    body = re.sub(r"^\s*1\.\s*", "", body)
    return hashlib.sha1(re.sub(r"[^A-Z0-9]", "", body.upper()).encode()).hexdigest()[:12]


def link_stations(pts, msg, cat, stations):
    """Lighthouse / RACON / DGNSS warnings name a station: the nearest one within 3 km of a position in
    the warning, or one whose name is in the text within 15 km."""
    # only warnings about a light or a radio aid: buoys and wave-rider moorings near a lighthouse are not about it
    if cat != "aton" or not pts or not re.search(r"\b(LT|LIGHT|LIGHTHOUSE|RACON|DGNSS|DGPS|AIS)\b", TXT_COORD.sub("@", msg)):
        return []
    found = {}
    for s in stations:
        for la, lo in pts[:16]:
            d = km(la, lo, s["lat"], s["lon"])
            core = re.sub(r"\s+(LIGHT ?HOUSE|LT|STATION|AND|DGPS|DGNSS|NAVTEX|VTS).*$", "", s["name"].upper())
            core = re.sub(r"[^A-Z ]", "", core).strip()
            if d <= 3.0 or (d <= 15 and len(core) >= 5 and core in re.sub(r"[^A-Z ]", "", msg)):
                if s["id"] not in found or d < found[s["id"]]:
                    found[s["id"]] = d
    return [sid for sid, _ in sorted(found.items(), key=lambda kv: kv[1])][:2]


def parse_api_date(s):
    try:
        return dt.datetime.strptime(s, "%a %b %d %H:%M:%S GMT %Y").date().isoformat()
    except (TypeError, ValueError):
        return None


def clean(msg):
    msg = html.unescape(msg or "")
    msg = re.sub(r"<[^>]+>", " ", msg)
    return re.sub(r"\s+", " ", msg).strip().upper()


def official_link(kind, ident):
    if kind == "T&P":
        return f"{BASE}/search-by-notice"
    t = "navTax" if kind == "NAVTEX" else "navArea"
    return f"{BASE}/india-wins?identifier={urllib.parse.quote(ident, safe='')}&type={t}"


def record(kind, ident, *, msg, feature, pts, radius, stations, navtex_by_letter, **extra):
    cat = "notice" if kind == "T&P" and category(extra.get("type"), msg) not in ("aton", "danger") else category(extra.get("type"), msg)
    use = pts
    tpts = text_coords(msg)
    if (feature or "").lower() == "polygon" and len(tpts) >= 3:
        use = tpts
    elif not pts:
        use = tpts
    geom = geometry(feature, use, radius, msg)
    b_char = extra.get("b_char") or None
    rec = {
        "key": f"{kind}:{ident}", "kind": kind, "identifier": ident, "category": cat,
        "issued": extra.get("issued"), "dtg": extra.get("dtg"), "b_char": b_char,
        "navtex_stations": sorted({navtex_by_letter[c[0]] for c in (b_char or "").split(",") if c[:1] in navtex_by_letter}),
        "type": extra.get("type"), "place": extra.get("place"), "area": extra.get("area"),
        "charts": extra.get("charts") or [], "notice": extra.get("notice"), "source_note": extra.get("source_note"),
        "message": msg, "feature": (feature or "").lower() or (geom or {}).get("type", "").lower() or None,
        "geometry": geom, "cancel_at": cancel_at(msg), "cancels": cancels(msg), "effects": effects(msg),
        "stations": link_stations(use, msg, cat, stations), "group": group_key(msg), "link": official_link(kind, ident),
    }
    return {k: v for k, v in rec.items() if v not in (None, "", [])} | {"key": rec["key"], "kind": kind, "identifier": ident}


def from_api(block, it, stations, navtex_by_letter):
    kind = KINDS[block]
    msg = clean(it.get("message"))
    try:
        raw = json.loads(it.get("coordinates") or "[]")
    except ValueError:
        raw = []
    pts = [(round(dm(p.get("lat")), 5), round(dm(p.get("long")), 5)) for p in raw
           if isinstance(p, dict) and dm(p.get("lat")) is not None and dm(p.get("long")) is not None]
    pts = [p for p in pts if in_region(*p)]
    try:
        charts = [str(c) for c in json.loads(it.get("charts") or "[]")]
    except ValueError:
        charts = []
    ident = (it.get("identifier") or it.get("notice") or "").strip()
    return record(kind, ident, msg=msg, feature=it.get("feature"), pts=pts, radius=it.get("radius"),
                  stations=stations, navtex_by_letter=navtex_by_letter,
                  issued=parse_api_date(it.get("date")), dtg=it.get("dtg"), b_char=it.get("b_char"), type=it.get("types"),
                  place=(it.get("place") or "").strip() or None, area=it.get("general_area"), charts=charts,
                  notice=it.get("notice"), source_note=clean(it.get("source")) or None)


# --------------------------------------------------------------------------------------- PDFs
def parse_pdf(path, stations, navtex_by_letter):
    text = subprocess.run(["pdftotext", "-layout", str(path), "-"], capture_output=True, text=True).stdout
    text = re.sub(r"(\d)-\s*\n\s*(\d)", r"\1-\2", text)                 # positions broken across lines
    m = re.search(r"IN FORCE AS ON\s+(\d{1,2})\s+([A-Z]{3})\s+(\d{2,4})", text)
    as_of = None
    if m:
        y = int(m.group(3)) + (2000 if len(m.group(3)) == 2 else 0)
        as_of = dt.date(y, MONTHS[m.group(2)], int(m.group(1))).isoformat()
    kind = "NAVAREA" if "NAVAREA VIII" in text[:400] else "NAVTEX"
    blocks = [b.strip() for b in re.split(r"\n\s*-{20,}\s*\n", text) if b.strip()]
    recs, pending = [], None
    for b in blocks:
        lines = [ln.strip() for ln in b.splitlines() if ln.strip()]
        if kind == "NAVTEX":
            date = next((ln for ln in lines if re.match(r"^\d{1,2} [A-Z]{3} \d{4}$", ln)), None)
            inw = next((re.search(r"\(INW\)\s*(\d+)", ln) for ln in lines if "(INW)" in ln), None)
            if not (date and inw):
                continue
            d = dt.datetime.strptime(date.title(), "%d %b %Y").date()
            i_inw = next(i for i, ln in enumerate(lines) if "(INW)" in ln)
            i_ch = next((i for i, ln in enumerate(lines) if ln.startswith("CHARTS IN")), None)
            b_char = next((ln for ln in lines if re.match(r"^[A-Z]{2}\d{2}(,[A-Z]{2}\d{2})*$", ln)), None)
            place = " ".join(lines[i_inw + 1:i_ch]) if i_ch and i_ch > i_inw + 1 else None
            charts = lines[i_ch][len("CHARTS IN"):].split() if i_ch is not None else []
            msg = clean(" ".join(lines[(i_ch if i_ch is not None else i_inw) + 1:]))
            ident = f"{inw.group(1)}/{d:%y}"
            recs.append(pdf_record(kind, ident, msg, stations, navtex_by_letter, issued=d.isoformat(),
                                   b_char=b_char, place=place, charts=charts))
        else:
            head = re.search(r"NAVAREA VIII\s*-\s*(\d+)/(\d{2})", b)
            dtg = re.search(r"\b(\d{6}Z/[A-Z]{3} \d{2})\b", b)
            if head and dtg and len(lines) <= 3:
                pending = (f"{head.group(1)}/{head.group(2)}", dtg.group(1))
                continue
            if not pending:
                continue
            ident, dtgv = pending
            pending = None
            body = clean(" ".join(lines))
            parts = [p.strip() for p in body.split("(.)")]
            area_place = parts[0] if parts else ""
            charts_part = next((p for p in parts if p.startswith("CHARTS IN")), "")
            msg = clean(" (.) ".join(p for p in parts[1:] if not p.startswith("CHARTS IN")))
            area, _, place = area_place.partition(" - ")
            dd = re.match(r"(\d{2})(\d{2})(\d{2})Z/([A-Z]{3}) (\d{2})", dtgv)
            issued = dt.date(2000 + int(dd.group(5)), MONTHS[dd.group(4)], int(dd.group(1))).isoformat() if dd else None
            recs.append(pdf_record(kind, ident, msg, stations, navtex_by_letter, issued=issued, dtg=dtgv,
                                   area=area.title() or None, place=place or None,
                                   charts=re.sub(r"INT\s+\d+", "", charts_part[len("CHARTS IN"):]).split()))
    return kind, as_of, recs, text


def pdf_record(kind, ident, msg, stations, navtex_by_letter, **extra):
    pts = text_coords(msg)
    if re.search(r"ARC OF \d+(\.\d+)? NM", msg) and len(pts) >= 3:
        feature = "arc"
    elif text_box(msg) or (len(pts) >= 3 and re.search(r"BOUNDED|AREA|SECTOR|ROUTE", msg)):
        feature = "polygon"
    elif re.search(r"RADIUS", msg) and pts:
        feature = "circle"
    else:
        feature = "point"
    return record(kind, ident, msg=msg, feature=feature, pts=pts, radius=None, stations=stations,
                  navtex_by_letter=navtex_by_letter, **extra)


# ------------------------------------------------------------------------------------ archive
def load_json(path, default):
    return json.loads(path.read_text()) if path.exists() else default


def merge_live(archive, recs, now_iso):
    seen = set()
    for r in recs:
        seen.add(r["key"])
        old = archive.get(r["key"])
        if old:
            first = old.get("first_seen", now_iso)
            sources = sorted(set(old.get("sources", [])) | {"api"})
            old.clear()
            old.update(r, first_seen=first, last_seen=now_iso, status="active", sources=sources)
        else:
            archive[r["key"]] = dict(r, first_seen=now_iso, last_seen=now_iso, status="active", sources=["api"])
    for r in archive.values():
        if r.get("status") == "active" and r["key"] not in seen:
            r["status"], r["ended"] = "ended", now_iso           # first run that no longer lists it
    return seen


def merge_pdf(archive, recs, as_of, pdf_name):
    seen = f"{as_of}T00:00:00Z" if as_of else None
    added = 0
    for r in recs:
        old = archive.get(r["key"])
        if old:
            if seen and seen < old.get("first_seen", seen):
                old["first_seen"] = seen
            for k, v in r.items():
                old.setdefault(k, v)
            old["sources"] = sorted(set(old.get("sources", [])) | {f"pdf:{pdf_name}"})
        else:
            archive[r["key"]] = dict(r, first_seen=seen, last_seen=seen, status="ended", ended=None,
                                     sources=[f"pdf:{pdf_name}"])
            added += 1
    return added


def publish(archive, meta):
    recs = sorted(archive.values(), key=lambda r: (r.get("issued") or "", r["key"]), reverse=True)
    active = [r for r in recs if r.get("status") == "active"]
    # the same event issued as NAVTEX and NAVAREA VIII shares its lighthouse links (one copy may lack a position)
    by_group = {}
    for r in active:
        by_group.setdefault(r.get("group"), set()).update(r.get("stations", []))
    for r in active:
        if by_group.get(r.get("group")):
            r["stations"] = sorted(by_group[r["group"]])
    cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=30)).isoformat()
    recent = [r for r in recs if r.get("status") == "ended" and (r.get("ended") or r.get("last_seen") or "") >= cutoff]
    meta = dict(meta, in_force={k: sum(r["kind"] == k for r in active) for k in KINDS.values()},
                archive_total=len(recs),
                outages={e: sorted({s for r in active if e in r.get("effects", []) for s in r.get("stations", [])})
                         for e in ("unlit", "racon_off", "dgnss_off", "ais_off")})
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    (WEB_DATA / "warnings.json").write_text(json.dumps({"meta": meta, "active": active, "recent_ended": recent},
                                                       ensure_ascii=False, separators=(",", ":")))
    slim = [{k: v for k, v in r.items() if k != "geometry"} | {"has_geometry": bool(r.get("geometry"))} for r in recs]
    (WEB_DATA / "warnings_archive.json").write_text(json.dumps({"meta": meta, "warnings": slim},
                                                               ensure_ascii=False, separators=(",", ":")))
    return meta


def main():
    args = sys.argv[1:]
    lh = json.loads((WEB_DATA / "lighthouses.json").read_text())
    stations = lh["stations"]
    navtex_by_letter = {n["id_518"]: n["station"] or n["name"] for n in lh["navtex"]}
    archive = load_json(ARCHIVE, {})
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    now_iso = now.isoformat().replace("+00:00", "Z")
    state = load_json(STATE, {})
    meta = {"source": f"{BASE}/india-wins", "source_name": "National Hydrographic Office, India WINS",
            "last_live_fetch": state.get("last_live_fetch"), "built": now_iso}

    pdfs = []
    if "--pdf" in args:
        pdfs.append(Path(args[args.index("--pdf") + 1]))
    if "--seed-nho" in args:
        for kind, url in NHO_PDFS.items():
            dest = RAW / "pdf" / f"nho-{kind.lower()}-in-force-latest.pdf"
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(http(url, timeout=120))
            pdfs.append(dest)
    for p in pdfs:
        kind, as_of, recs, _ = parse_pdf(p, stations, navtex_by_letter)
        keep = RAW / "pdf" / f"{kind.lower()}-in-force-{as_of or 'undated'}.pdf"
        keep.parent.mkdir(parents=True, exist_ok=True)
        if p.resolve() != keep.resolve():
            shutil.copy2(p, keep)
        added = merge_pdf(archive, recs, as_of, keep.name)
        print(f"{p.name}: {kind} in force on {as_of}: {len(recs)} warnings, {added} new to the archive")

    if not pdfs:
        body = fetch_combined()                                   # raises on failure: last good files stay
        data = json.loads(body)
        digest = hashlib.sha256(body).hexdigest()
        if digest != state.get("hash"):
            snap = RAW / "api" / f"{now:%Y}" / f"{now:%m}" / f"combined-{now:%Y%m%dT%H%MZ}.json.gz"
            snap.parent.mkdir(parents=True, exist_ok=True)
            snap.write_bytes(gzip.compress(body))
            state.update(hash=digest, snapshot=str(snap.relative_to(ROOT)))
        blocks = {k: v for b in data for k, v in b.items()}
        recs = [from_api(k, it, stations, navtex_by_letter) for k in KINDS for it in blocks.get(k, [])]
        merge_live(archive, recs, now_iso)
        state["last_live_fetch"] = meta["last_live_fetch"] = now_iso
        print("live: " + ", ".join(f"{KINDS[k]} {len(blocks.get(k, []))}" for k in KINDS))

    ARCHIVE.parent.mkdir(parents=True, exist_ok=True)
    ARCHIVE.write_text(json.dumps(archive, indent=1, ensure_ascii=False))
    STATE.write_text(json.dumps(state, indent=1))
    meta = publish(archive, meta)
    print(f"in force: {meta['in_force']} · archive {meta['archive_total']} · outages {meta['outages']}")
    if "--deploy" in args and SITE_DATA.exists():
        for f in ("warnings.json", "warnings_archive.json"):
            shutil.copy2(WEB_DATA / f, SITE_DATA / f)
        print(f"deployed to {SITE_DATA}")


if __name__ == "__main__":
    main()
