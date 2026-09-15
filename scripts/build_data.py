#!/usr/bin/env python3
"""
Merge every source into the web payload and compute sea-only reach.

Sources (all fetched 2026-09-13, see raw/FETCHED_AT):
  DGLL Master Ledgers ........ build/ledgers.json   (primary: position, light, tower, kit)
  DGLL NAVTEX / RACON / VTS .. raw/dgll/dgll_{navtex,racon,vts}.html
  OpenStreetMap / OpenSeaMap . raw/osm/osm_*.json   (position check via Admiralty no.)
  Wikidata ................... raw/wikidata/lighthouses.json (photos, inception)
  Rowlett Lighthouse Directory build/rowlett.json   (tower year, visitor access)
  Natural Earth + DataMeet ... build/land_mask.geojson

Outputs:
  web/data/lighthouses.json  stations + attributes
  web/data/reach.json        {lights: {id: [[ring...]...]}, navtex: {...}} sea-only polygons

Run with the tn-flights venv:
  ~/projects/tn-flights/flights/.venv/bin/python scripts/build_data.py
"""
import html
import json
import math
import os
import re

import numpy as np
import shapely
from shapely.geometry import Point, Polygon, box, mapping, shape
from shapely.ops import unary_union
from shapely.prepared import prep

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(HERE, "raw")
BUILD = os.path.join(HERE, "build")
WEB = os.path.join(HERE, "web", "data")

NM = 1852.0
R_EARTH = 6371008.8
EYE_M = 5.0          # observer's eye height on a small vessel's bridge (IALA uses 5 m)
NAVTEX_NM = 250      # DGLL: "NAVTEX system is ensuring 250NM coverage from the Indian coast line"

REGION_LABEL = {
    "vts-gandhi-dham": "Gandhidham (VTS)", "vts-gandhidham": "Gandhidham (VTS)", "jamnagar": "Jamnagar",
    "mumbai": "Mumbai", "goa": "Goa", "kochi": "Kochi", "chennai": "Chennai",
    "vishakhapatnam": "Visakhapatnam", "kolkata": "Kolkata", "portblair": "Port Blair",
}


# ------------------------------------------------------------------ helpers
def dest(lat, lon, bearing_deg, dist_m):
    """Great-circle destination point."""
    p1, l1, b = math.radians(lat), math.radians(lon), math.radians(bearing_deg)
    d = dist_m / R_EARTH
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), math.degrees(l2)


def haversine_m(a_lat, a_lon, b_lat, b_lon):
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = p2 - p1, math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_EARTH * math.asin(math.sqrt(h))


def key(s):
    s = html.unescape(s or "").lower()
    s = re.sub(r"\b(?:lighthouse|light house|light|station|and|dgps|d\.g\.p\.s|navtex|vts|repeater|the|point|pt|island|head)\b|&amp;|&", " ", s)
    s = s.replace("’", "").replace("'", "")
    s = re.sub(r"[^a-z]", "", s)
    return {"villinjam": "vizhinjam", "vengrularocks": "vengurlarocks", "ramyapatnam": "ramayapatnam",
            "paradeep": "paradeep", "paradip": "paradeep", "porto": "portonovo", "portonovo": "portonovo",
            "muttam": "muttom", "vakalpudi": "vakalapudi", "prongsreef": "prongsreef", "prongs": "prongsreef",
            "pondicherry": "puducherry", "chennai": "chennai", "dolphinsnose": "dolphinnose",
            "kiltansouth": "kiltansouth", "navlakhi": "navlakhi", "kachhigadh": "kachhigadh",
            "kachchigadh": "kachhigadh", "luhara": "luhara", "gopnath": "gopnath", "diu": "diu",
            "villingili": "vizhinjam", "pandiantivu": "pandiyantivu", "ramyaptnam": "ramayapatnam",
            "umargaon": "umergam", "kadmath": "kadamat"}.get(s, s)


# Positions that are wrong in every DGLL record and have no OSM/Wikidata twin.
POSITION_FIX = {
    # Ledger and https://www.dgll.nic.in/DGLL-light-house-location/kochi/kalpeni-lighthouse both give
    # 73° 58.54' E, which is 36 km east of the atoll in open sea; Kalpeni island is at 73° 38-39' E.
    "kalpeni-lighthouse": (10 + 4.50 / 60, 73 + 38.54 / 60, "DGLL position with 58'->38' digit slip corrected"),
    # Ledger 93° 56.10' E is a 1-degree slip; Lighthouse Directory map link puts the tower on Aves Island.
    "aves-lighthouse": (12.914274, 92.935106, "Lighthouse Directory map link (ledger 93°E -> 92°E slip)"),
}

# ------------------------------------------------------------------ Parliament
# Lok Sabha Unstarred Question 3233, answered 07.08.2026 ("Tourism at Lighthouses"), Annexure I:
# 75 lighthouses developed for tourism, state-wise. Names mapped to DGLL station slugs by hand.
LS_3233 = "https://sansad.in/getFile/lsapps/loksabhaquestions/annex/188/AU3233_R4EsOl.pdf?source=lsapps"
LS_949 = "https://sansad.in/getFile/lsapps/loksabhaquestions/annex/188/AU949_4qZANz.pdf?source=lsapps"
TOURISM = {
    "Gujarat": {"Mandvi": "mandvi-lighthouse-vts-station", "Rawalpir": "rawal-pir-lighthouse",
                "Samiyani": "samiyani-island-lighthouse-station", "Okha": "okha-lighthouse-dgps-and-vts-station",
                "Kachchhigadh": "kachhigadh-lighthouse", "Porbandar": "porbandar-lighthouse", "Mangrol": "mangrol-lighthouse",
                "Jaffrabad": "jafrabad-lighthouse", "Jegri": "jegri-island-lighthouse", "Alang": "alang-lighthouse",
                "Ghogha": "ghogha-lighthouse", "Hazira": "hazira-lighthouse-and-dgps-station",
                "Valsad Khadi": "valsad-khadi-lighthouse", "Gopnath": "gopnath-lighthouse-dgps-station",
                "Veraval": "veraval-lighthouse", "Dwarka": "dwarka-point-lighthouse", "Umargaon": "umergam-lighthouse"},
    "Goa": {"Aguada": "aguada-lighthouse-and-dgps-station"},
    "Karnataka": {"Tadri": "tadri-lighthouse", "Bhatkal": "bhatkal-lighthouse", "Kaup": "kaup-lighthouse",
                  "Surathkal": "surathkal-lighthouse-and-dgps-station", "Kundapur": "kundapur-lighthouse"},
    "Kerala": {"Kannur": "kannur-lighthouse", "Ponnani": "ponnani-lighthouse", "Chetwai": "chetwai-lighthouse",
               "Vypin": "vypin-lighthouse", "Alappuzha": "alappuzha-lighthouse", "Valiyazhikal": "valiazheekal-lighthouse",
               "Thangasseri": "thangasseripoint-lighthouse", "Anjengo": "anjengo-lighthouse", "Vizhinjam": "vizhinjam-lighthouse",
               "Azhikode": "azhikode-lighthouse-and-dgps-station", "Kadalur Point": "kadalur-point-lighthouse"},
    "Tamil Nadu": {"Kanniyakumari": "kanyakumari-lighthouse", "Kuthenkuli": "kuthenkuli-lighthouse",
                   "Manappad": "manapad-point-lighthouse", "Kilakkarai": "kilakkarai-lighthouse",
                   "Dhanushkodi": "dhanushkodi-lighthouse", "Pamban": "pamban-lighthouse", "Karaikal": "karaikal-lighthouse",
                   "Mallipattinam": "mallipattinam-lighthouse", "Kodikkarai": "kodikkarai-lighthouse",
                   "Nagapattinam": "nagapattinam-lighthouse-and-dgps-station", "Poompuhar": "poompuhar-lighthouse",
                   "Pulicat": "pulicat-lighthouse-and-dgps-station", "Muttom Point": "muttom-point-lighthouse-and-navtex-station",
                   "Mahabalipuram": "mahabalipuram-lighthouse", "Chennai": "chennai-lighthouse"},
    "Andhra Pradesh": {"Ramayapatnam": "ramayapatnam-lighthouse", "Machilipatnam": "machilipatnam-lighthouse",
                       "Antervedi": "antervedi-lighthouse", "Sacramento": "sacramento-lighthouse",
                       "Vakalapudi": "vakalapudi-lighthouse", "Santapalli": "santapalli-lighthouse",
                       "Kalingapatnam": "kalingapatnam-lighthouse", "Baruva": "baruva-lighthouse",
                       "Vodarevu": "vodarevu-lighthouse", "Pudimadaka": "pudimadaka-lighthouse"},
    "Odisha": {"Gopalpur": "gopalpur-lighthouse", "Puri": "puri-lighthouse", "Chandrabhaga": "chandrabhaga-lighthouse",
               "Paradip": "paradeep-lighthouse", "False Point": "false-point-lighthouse"},
    "West Bengal": {"Tajpur": "tajpur-lighthouse", "Dariapur": "dariapur-lighthouse", "Sagar Island": "sagar-island-lighthouse"},
    "Maharashtra": {"Uttan Point": "uttan-point-lighthouse-and-dgps-station", "Korlai Fort": "korlai-fort-lighthouse",
                    "Jaigarh": "jaigarh-lighthouse", "Ratnagiri": "ratnagiri-town-and-dgps-station",
                    "Vengurla Point": "vengurla-point-lighthouse", "Kelshi": "kelshi-lighthouse"},
    "Andaman and Nicobar Islands": {"North Point": "north-point-lighthouse",
                                    "Keating Point": "keating-point-lighthouse-and-dgps-station"},
}
MUSEUMS = {"chennai-lighthouse", "mahabalipuram-lighthouse", "alappuzha-lighthouse", "kannur-lighthouse",
           "muttom-point-lighthouse-and-navtex-station", "dwarka-point-lighthouse", "gopnath-lighthouse-dgps-station"}

# Tourism-list lighthouses that DGLL's regional pages do not carry (no Master Ledger).
# Light and tower from the Lighthouse Directory; positions as noted.
EXTRA = [
    dict(id="kannur-lighthouse", name="Kannur Lighthouse", region="Kochi", lat=11.86045, lon=75.35591,
         pos_src="OpenStreetMap node/2588063897", rowlett="Kannur (Cannanore)", alol="F 0672"),
    dict(id="kelshi-lighthouse", name="Kelshi (Anjarle) Lighthouse", region="Mumbai", lat=17.86222, lon=73.08225,
         pos_src="Lighthouse Directory map link", rowlett="Anjarle (Kelshi)", alol="F 0563.5"),
    dict(id="rawal-pir-lighthouse", name="Rawal Pir Lighthouse", region="Gandhidham (VTS)", lat=22.81479, lon=69.39204,
         pos_src="Lighthouse Directory map link", rowlett="Rawal Pir", alol="F 0360"),
    # DGLL's Mahe page carries Kannur's ledger (LEDGER_IS), so Mahe's own light comes from the Directory
    dict(id="mahe-lighthouse", name="Mahe Lighthouse", region="Kochi", lat=11.70214, lon=75.53002,
         pos_src="OpenStreetMap way/841683098", rowlett="Mah", alol="F 0678"),
]

# Lok Sabha Q 3233: DGLL–IWAI MoU (08.04.2025); work orders issued for lighthouses on National
# Waterway-2 (Brahmaputra). Exact tower sites are not published: points are the named river-port
# localities from OpenStreetMap Nominatim.
PLANNED = [
    dict(name="Bogibeel", place="Bogibeel Ghat, Dibrugarh", lat=27.38610, lon=94.77332),
    dict(name="Biswanath Ghat", place="Bishwanath Ghat, Biswanath", lat=26.66148, lon=93.16578),
    dict(name="Silghat", place="Silghat, Nagaon", lat=26.60145, lon=92.92611),
    dict(name="Pandu", place="Pandu Port, Guwahati", lat=26.17020, lon=91.67782),
]

# Lok Sabha Unstarred Question 949, answered 24.07.2026 ("Modernisation of Indian Lighthouses").
BUDGET = [
    dict(year="2023-24", allocation=100.0, utilisation=99.89),
    dict(year="2024-25", allocation=90.0, utilisation=80.23),
    dict(year="2025-26", allocation=90.0, utilisation=81.82),
]


AI_DIR = os.path.join(BUILD, "ledger_ai")


def load_ai():
    """Per-ledger transcriptions (build/ledger_ai/<slug>.json), made by reading each Master
    Ledger's text layer AND its rendered pages, so degree signs, superscripts and wrapped
    table cells are resolved. They are the source of truth; the regex parse is a fallback."""
    out = {}
    if os.path.isdir(AI_DIR):
        for fn in os.listdir(AI_DIR):
            if fn.endswith(".json"):
                try:
                    d = json.load(open(os.path.join(AI_DIR, fn)))
                    out[d.get("slug") or fn[:-5]] = d
                except (ValueError, OSError) as e:
                    print("bad ledger_ai file", fn, e)
    return out


KIND = {"Fl": "Fl", "Gp Fl": "Fl", "LFl": "Fl", "Oc": "Oc", "Gp Oc": "Oc", "Iso": "Iso", "F": "F", "Q": "Q", "VQ": "Q",
        "Mo": "Fl", "Al": "Fl"}


def apply_ai(r, ai):
    """Overlay the ledger transcription onto the regex record; return [(field, regex, ledger)]."""
    diffs = []

    def put(field, value):
        if value is None:
            return
        old = r.get(field)
        if old != value and not (isinstance(old, float) and isinstance(value, (int, float)) and abs(old - value) < 1e-3):
            diffs.append((field, old, value))
        r[field] = value

    pos = ai.get("position") or {}
    lat, lon = pos.get("lat"), pos.get("lon")
    r["lat_text"], r["lon_text"] = pos.get("lat_text"), pos.get("lon_text")
    # Seconds printed as 60+ (Vypin 59'82", Karaikal 54'99") are decimal minutes typed into a
    # seconds column; the transcription converts them as printed, so re-read those texts.
    from parse_ledgers import parse_coord
    for axis, txt in (("lat", pos.get("lat_text")), ("lon", pos.get("lon_text"))):
        m = re.search(r"(\d{1,2})\s*['’′]\s*(\d{2,3}(?:\.\d+)?)\s*[\"”″]", txt or "")
        if m and float(m.group(2)) >= 60:
            v = parse_coord(txt, axis)
            if v:
                if axis == "lat":
                    lat = v
                else:
                    lon = v
    put("lat", lat); put("lon", lon)
    put("alol", ai.get("alol"))
    put("elev_m", ai.get("elevation_m"))
    put("char_raw", ai.get("characteristic_text"))
    lt = ai.get("light") or {}
    if lt.get("kind"):
        put("kind", KIND.get(lt["kind"], lt["kind"]))
    g = lt.get("flashes_per_period")
    if g and g > 8 and not lt.get("sequence_s"):
        # e.g. Agatti "Fl (30) W 30 sec": no light shows 30 flashes a period; keep the regex group
        r.setdefault("_extra_issues", []).append(f"characteristic reads Fl ({g}); treated as a typo, not simulated as {g} flashes")
    else:
        put("group", g)
    cols = lt.get("colours") or []
    if cols:
        put("colour", cols[0] if cols[0] in "WRG" else "W")
    put("period", lt.get("period_s"))
    seq = lt.get("sequence_s")
    if seq and len(seq) % 2 == 0:
        put("phases", [float(x) for x in seq])
    elif seq is not None or lt.get("period_s"):
        if r.get("phases"):
            diffs.append(("phases", r["phases"], None))
        r["phases"] = []
    put("flash_s", lt.get("flash_duration_s"))
    r["sectored"] = len(cols) > 1 or bool(ai.get("sectors_text"))
    r["sectors_text"] = ai.get("sectors_text")
    rg = ai.get("range") or {}
    put("range_lum_nm", rg.get("luminous_nm")); put("range_geo_nm", rg.get("geographical_nm"))
    tw = ai.get("tower") or {}
    put("tower_type", tw.get("type")); put("tower_h_m", tw.get("height_m")); put("tower_colour", tw.get("colour_scheme"))
    op = ai.get("optic") or {}
    rpm = op.get("rpm")
    r["rpm"] = rpm if rpm and 0.05 <= rpm <= 20 else None
    r["panels"] = op.get("panels")
    rot = op.get("rotates")
    new_optic = "revolving" if rot is True else "flasher" if rot is False else None
    if new_optic != r.get("optic"):
        diffs.append(("optic", r.get("optic"), new_optic))
    r["optic"], r["optic_evidence"] = new_optic, op.get("rotates_evidence")
    dh = op.get("divergence_horizontal_deg")
    r["div_h_cands"] = [dh] if dh else None
    r["optic_detail"] = {k: op.get(k) for k in ("make", "model", "type", "size", "order", "rotation_device", "divergence_text", "illuminant") if op.get(k)}
    put("intensity_cd", ai.get("intensity_cd"))
    for key in ("ais", "dgps"):
        v = (ai.get(key) or {}).get("present")
        if v is not None:
            put(key, bool(v))
    rc = ai.get("racon") or {}
    r["racon_ledger"] = rc.get("code") if rc.get("present") else None
    pw = ai.get("power") or {}
    if pw.get("solar") is not None:
        put("solar", bool(pw["solar"]))
    if ai.get("established_year"):
        r["established"] = ai["established_year"]
    r["station_type"] = ai.get("station_type")
    r["ledger_issues"] = (ai.get("issues") or []) + r.pop("_extra_issues", [])
    return diffs


# A DGLL station page that carries another station's ledger.
LEDGER_IS = {
    # The "Mahe Lighthouse" page links an untitled ledger whose postal address (Kannur Lighthouse,
    # Burnacherry Post), position (11° 51.5' N, 75° 21.4' E, 1 km from OSM's Kannur light) and
    # light (Fl W 10 s) are Kannur's.
    "mahe-lighthouse": ("kannur-lighthouse", "Kannur Lighthouse",
                        "This ledger is published on DGLL's Mahe Lighthouse page, but its address, position and light are Kannur Lighthouse's"),
}


def active_panels(slug, panels):
    """Lens panels that actually shine. Ledgers count blanked ones too: 'No. of lens 6 (5 Nos
    Blanking with aluminum sheet)', '6 (4 Fresnel lens + 2 blanks)', '6 Nos (4 in service)',
    '06Nos (2Nos fixed and others blocked)'. Lantern *panes* blanked on the landward side are glazing,
    not lenses, and are ignored."""
    path = os.path.join(RAW, "dgll", "ledger", slug + ".txt")
    if not panels or not os.path.exists(path):
        return panels, None
    t = re.sub(r"\s+", " ", open(path, errors="ignore").read())
    m = re.search(r"No\.?\s*of\s*(?:lens\w*|panels?)[^|]{0,90}", t, re.I)
    seg = m.group(0) if m else ""
    pats = [
        (r"(\d+)\s*(?:nos\.?\s*)?(?:fresnel\s*lens\w*|lanes|lens\w*)?\s*\+\s*(\d+)\s*blank", lambda mm: int(mm.group(1))),
        (r"\(\s*0?(\d+)\s*in\s*se\w*", lambda mm: int(mm.group(1))),
        (r"0?(\d+)\s*nos?\.?\s*fixed\s*and\s*others\s*blocked", lambda mm: int(mm.group(1))),
        (r"\(\s*(\d+)\s*nos?\.?\s*blank\w*\s*with", lambda mm: panels - int(mm.group(1))),
    ]
    for p, f in pats:
        mm = re.search(p, seg, re.I)
        if mm:
            v = f(mm)
            if 0 < v <= panels:
                return v, mm.group(0).strip()
    return panels, None


def alt_decimal_minutes(text):
    """"8° 04' 8\"" read the other way: 8° 04.8'. Several ledgers type decimal minutes into a
    seconds column; used only when it lands on the same-named light in OSM/Wikidata."""
    m = re.search(r"(\d{1,3})\s*[°º*`o]?\s*[\s.]*(\d{1,2})\s*['’′]\s*\.?\s*(\d{1,2})\s*['’\"”″]", text or "")
    if not m:
        return None
    return int(m.group(1)) + float(f"{m.group(2)}.{m.group(3)}") / 60


FULL_DIR = os.path.join(BUILD, "ledger_full")

# Earliest plausible year per equipment, with the reason. Years before it inside that
# section belong to something else (Aguada's NAIS block also carries its 1998 DGPS date).
EQUIP = {
    "navtex": (r"navtex", 2000, "India's NAVAREA VIII NAVTEX chain is a 2010s network"),
    "racon": (r"racon", 1980, None),
    "ais": (r"\bn\.?a\.?i\.?s\b|\bais\b", 2010, "NAIS contract signed November 2010, completed 2012 (Saab)"),
    "dgps": (r"dgps|dgnss|differential global", 1995, None),
}
ANCILLARY = r"batter|charger|\bups\b|inverter|solar|monitor|receiver|fire|stabili|a/?c\b|air.?condition"


def equipment_years(full):
    """Earliest installation/commissioning year per equipment from its own ledger section."""
    found = {}
    for sec in (full or {}).get("sections", []):
        title = sec.get("title") or ""
        for key, (pat, floor, _) in EQUIP.items():
            if not re.search(pat, title, re.I) or re.search(ANCILLARY, title, re.I):
                continue
            texts = [f"{f.get('label', '')}: {f.get('value', '')}" for f in sec.get("fields") or []]
            for tb in sec.get("tables") or []:
                cols = tb.get("columns") or []
                for row in tb.get("rows") or []:
                    texts.append(" | ".join(f"{c}: {v}" for c, v in zip(cols, row)))
            if sec.get("text"):
                texts.append(sec["text"])
            for tx in texts:
                if not re.search(r"date|install|commission|year|since|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}", tx, re.I):
                    continue
                for m in re.finditer(r"\b\d{1,2}[./-]\d{1,2}[./-]((?:19|20)?\d{2})\b|\b((?:19|20)\d{2})\b", tx):
                    y = m.group(1) or m.group(2)
                    y = int(y) if len(y) == 4 else 2000 + int(y)
                    if floor <= y <= 2026:
                        found.setdefault(key, []).append(y)
    return {k: min(v) for k, v in found.items()}


def light_sim(s):
    """Everything the animation does, derived from this station's own Master Ledger.

    revolving: seconds per turn from the ledger RPM when it is a whole number of flash periods;
               else from the panel count (panels / flashes-per-period turns = one period per
               panel group); else one turn per period. Beam width = ledger horizontal
               divergence, choosing between OCR readings ("30" = 3°) the one consistent with
               the ledger flash duration; else width implied by flash duration.
    flashing : LED flasher / fixed optic / optic not stated: whole light blinks.
    fixed    : 'F' characteristic, steady.
    Every disagreement between the ledger's own numbers is kept in `flags`."""
    ph, P = s.get("phases"), s.get("period")
    if not ph or not P:
        return None
    flashes, acc = [], 0.0
    for i in range(0, len(ph), 2):
        flashes.append((acc, ph[i]))
        acc += ph[i] + (ph[i + 1] if i + 1 < len(ph) else 0)
    n = len(flashes)
    flags = []
    if s.get("ckind") == "F":
        return dict(mode="fixed", flags=flags)
    if s.get("optic") != "revolving":
        why = {"flasher": "ledger: LED flasher / fixed optic", None: "ledger does not state the optic"}.get(s.get("optic"))
        if s.get("no_ledger"):
            why = "no DGLL ledger online"
        return dict(mode="flashing", reason=why, flags=flags)

    rpm, panels = s.get("rpm"), s.get("panels")
    whole = lambda rev: rev / P >= 0.95 and abs(rev / P - round(rev / P)) < 0.12
    rev = src = None
    if rpm:
        if whole(60 / rpm):
            rev, src = round(60 / rpm / P) * P, f"ledger {rpm:g} rpm"
        else:
            flags.append(f"{rpm:g} rpm = {60 / rpm:.1f} s per turn, not a whole number of {P:g} s periods")
    if rev is None and panels:
        if panels % n == 0:
            rev, src = P * panels / n, f"{panels} panels × {P:g} s"
        else:
            flags.append(f"{panels} panels do not divide into groups of {n} flashes")
    if rev is None:
        rev, src = P, "one turn per period (no usable rpm or panel count)"
    k = round(rev / P)
    if panels and panels != k * n:
        flags.append(f"ledger lists {panels} panels; its rpm and rhythm imply {k * n}")

    implied = sum(360.0 * d / rev for _, d in flashes) / n       # beam width a revolving lens needs
    width, wsrc = None, "implied by flash duration and rotation"
    cands = [c for c in (s.get("div_h_cands") or []) if 0.3 <= c <= 40]
    if cands:
        width = min(cands, key=lambda c: abs(math.log(c / max(implied, 0.05))))
        wsrc = "ledger horizontal divergence"
        seen = width / 360.0 * rev
        mean_fl = sum(d for _, d in flashes) / n
        if not 0.33 <= seen / max(mean_fl, 0.01) <= 3:
            flags.append(f"divergence {width:g}° at {rev:g} s/turn gives a {seen:.2f} s flash; ledger says {mean_fl:g} s")
    if width is None:
        width = max(1.5, implied)
    return dict(mode="revolving", rev_s=round(rev, 3), rev_src=src, groups_per_turn=k, panels=panels, rpm=rpm,
                width_deg=round(width, 2), width_src=wsrc,
                beams=[dict(c=round(a + d / 2, 3)) for a, d in flashes], flags=flags)


def num_or_none(s):
    m = re.match(r"(?:Approx\.\s*)?(\d+(?:\.\d+)?)\s*m\b", s or "")
    return float(m.group(1)) if m else None


def alol_key(s):
    m = re.search(r"(\d{3,4}(?:\.\d+)?)", s or "")
    return f"{float(m.group(1)):.2f}" if m else None


def table_cells(path):
    s = open(path, errors="ignore").read()
    s = re.sub(r"<script.*?</script>|<style.*?</style>", "", s, flags=re.S)
    s = re.sub(r"<(td|th)[^>]*>", "␟", s)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(re.sub(r"\s+", " ", s))
    return [c.strip() for c in s.split("␟")]


def dm(s):
    """'20 ̊54.6' / '8° 7.4’' / '9° 15.48’' -> decimal degrees."""
    m = re.search(r"(\d{1,3})\D+(\d{1,2}(?:\.\d+)?)", s)
    return int(m.group(1)) + float(m.group(2)) / 60 if m else None


# ------------------------------------------------------------------ light rhythm
def phases_for(r):
    """Light/eclipse sequence (seconds) for one period, from the ledger's own timings
    when present, otherwise synthesised from the characteristic using DGLL's flash length."""
    period, group, kind = r.get("period"), r.get("group") or 1, r.get("kind") or "Fl"
    ph = r.get("phases") or []
    if ph and len(ph) % 2 == 0 and sum(ph) >= 1:
        # the itemised timings are more careful than the headline: Chennai's ledger says
        # "Group Flash (2) Every 2 Sec" but lists 0.57+1.93+0.57+6.93 = 10 s
        if not period or abs(sum(ph) - period) >= 0.6:
            r["period"] = round(sum(ph), 2)
        return ph
    if not period:
        return [1.0, 0.0] if kind == "F" else None
    if kind == "F":
        return [period, 0.0]
    if kind == "Iso":
        return [period / 2, period / 2]
    if kind == "Oc":
        return [period - 1.0 * group, 1.0] if group == 1 else ([period * 0.6] + [0.8, 0.8] * (group - 1) + [0.8])[:2 * group]
    if kind == "Q":
        return [0.3, 0.7]
    fl = r.get("flash_s") or min(1.0, period * 0.05 + 0.2)
    if group <= 1:
        return [fl, round(period - fl, 2)]
    short = min(2.0, max(1.0, period * 0.1))
    seq = []
    for i in range(group):
        seq += [fl, short]
    seq[-1] = round(period - (fl * group + short * (group - 1)), 2)
    if seq[-1] <= 0:
        return None
    return seq


# ------------------------------------------------------------------ reach geometry
class Sea:
    def __init__(self):
        land = shape(json.load(open(os.path.join(BUILD, "land_mask.geojson")))["features"][0]["geometry"])
        self.land = land
        self.parts = list(getattr(land, "geoms", [land]))
        self.tree = shapely.STRtree(self.parts)

    def local_land(self, lat, lon, radius_m):
        dlat = radius_m / 111_000
        dlon = dlat / max(0.2, math.cos(math.radians(lat)))
        win = box(lon - dlon, lat - dlat, lon + dlon, lat + dlat)
        idx = self.tree.query(win)
        if len(idx) == 0:
            return None, win
        return unary_union([self.parts[i].intersection(win) for i in idx]), win

    def light_reach(self, lat, lon, radius_m, rays=240, step_m=300.0):
        """Visible sea from the tower: cast rays; a ray starts once it has cleared the
        coast (towers sit on land) and stops at the next landfall (headlands, islands
        and the far shore of a bay shadow the beam). Result is sea only."""
        land, win = self.local_land(lat, lon, radius_m * 1.05)
        if land is None or land.is_empty:
            circle = Polygon([dest(lat, lon, b, radius_m)[::-1] for b in np.linspace(0, 360, rays, endpoint=False)])
            return circle, self.open_circle(rays)
        n = int(radius_m // step_m) + 1
        dists = np.arange(1, n + 1) * step_m
        dists[-1] = min(dists[-1], radius_m)
        pts, open_m = [], []
        for b in np.linspace(0, 360, rays, endpoint=False):
            la, lo = _fan(lat, lon, b, dists)
            onland = shapely.contains_xy(land, lo, la)
            sea = np.where(~onland)[0]
            if len(sea) == 0 or dists[sea[0]] > 4_000:     # never reaches open water in this direction
                pts.append((lon, lat))
                open_m.append(0.0)
                continue
            first = sea[0]
            after = np.where(onland[first:])[0]
            last = (first + after[0] - 1) if len(after) else len(dists) - 1
            pts.append((lo[last], la[last]))
            open_m.append(float(dists[last] - dists[first]))
        fan = Polygon([(lon, lat)] + pts + [(lon, lat)]).buffer(0)
        return fan.difference(land).buffer(0), sea_mask(open_m, radius_m)

    def open_circle(self, rays=240):
        return sea_mask([1.0] * rays, 1.0)

    def radio_reach(self, lat, lon, radius_m):
        """MF ground-wave coverage over sea: the circle minus land, keeping only the
        water connected to the transmitter's own coast."""
        circle = Polygon([dest(lat, lon, b, radius_m)[::-1] for b in np.linspace(0, 360, 360, endpoint=False)])
        land, _ = self.local_land(lat, lon, radius_m * 1.05)
        sea = circle.difference(land).buffer(0) if land is not None else circle
        near = Point(lon, lat).buffer(0.06)
        parts = [g for g in getattr(sea, "geoms", [sea]) if g.intersects(near)]
        return unary_union(parts) if parts else sea


def sea_mask(open_m, radius_m, bins=72):
    """72 characters, one per 5° of bearing clockwise from north: '1' where the light's
    sight line has at least a fifth of its range of open water. The 3D light shafts use it
    so a beam leaving the lantern never sweeps over land."""
    per = len(open_m) // bins
    out = []
    for i in range(bins):
        seg = open_m[i * per:(i + 1) * per] or [0]
        out.append("1" if max(seg) >= 0.2 * radius_m else "0")
    return "".join(out)


def _fan(lat, lon, bearing, dists):
    p1, l1, b = math.radians(lat), math.radians(lon), math.radians(bearing)
    d = dists / R_EARTH
    sp2 = math.sin(p1) * np.cos(d) + math.cos(p1) * np.sin(d) * math.cos(b)
    p2 = np.arcsin(sp2)
    l2 = l1 + np.arctan2(math.sin(b) * np.sin(d) * math.cos(p1), np.cos(d) - math.sin(p1) * sp2)
    return np.degrees(p2), np.degrees(l2)


def rings(geom, tol=0.004, nd=5, min_hole=4e-4, min_part=2e-5):
    """Polygon/MultiPolygon -> [[outer, hole...], ...] that triangulate cleanly.

    Simplifying then rounding can leave self-touching rings and hair-thin holes;
    earcut turns those into long spikes across the map. So: simplify, repair,
    snap to the output grid, repair again, and drop slivers and tiny island holes
    (a hole under ~5 km² is invisible at any zoom this map uses for reach)."""
    geom = shapely.make_valid(geom.simplify(tol, preserve_topology=True))
    geom = shapely.set_precision(geom, 10 ** -nd)
    geom = shapely.make_valid(geom).buffer(0)
    out = []
    for g in getattr(geom, "geoms", [geom]):
        if g.is_empty or g.geom_type != "Polygon" or g.area < min_part:
            continue
        holes = [h for h in g.interiors if Polygon(h).area >= min_hole]
        g = Polygon(g.exterior, holes).buffer(0)
        for p in getattr(g, "geoms", [g]):
            if p.geom_type != "Polygon" or p.area < min_part:
                continue
            rs = [shapely.geometry.polygon.orient(p, 1).exterior] + list(shapely.geometry.polygon.orient(p, 1).interiors)
            out.append([[[round(x, nd), round(y, nd)] for x, y in r.coords[:-1]] for r in rs])
    return out


def mesh(geom, tol=0.004, nd=5):
    """Cleaned polygon -> indexed triangle mesh {v: [lon, lat, ...], i: [...]}.

    Triangulated here with shapely's constrained Delaunay, so every triangle is
    guaranteed inside the sea polygon. The browser used to run earcut on these
    coast-hugging rings with island holes, and a single bridging failure drew a
    spike of broadcast across the land."""
    index, V, I = {}, [], []
    for pr in rings(geom, tol=tol, nd=nd):
        poly = Polygon(pr[0], pr[1:])
        for tri in shapely.constrained_delaunay_triangles(poly).geoms:
            for x, y in list(tri.exterior.coords)[:3]:
                k = (round(x, nd), round(y, nd))
                if k not in index:
                    index[k] = len(V) // 2
                    V.extend(k)
                I.append(index[k])
    return {"v": V, "i": I} if I else None


# ------------------------------------------------------------------ main
def main():
    ledgers = json.load(open(os.path.join(BUILD, "ledgers.json")))
    rowlett = json.load(open(os.path.join(BUILD, "rowlett.json")))
    osm = json.load(open(os.path.join(RAW, "osm", "osm_bbox.json")))["elements"]
    wd = json.load(open(os.path.join(RAW, "wikidata", "lighthouses.json")))["results"]["bindings"]

    # OSM seamark lights by Admiralty number
    osm_by_alol = {}
    for e in osm:
        t = e.get("tags", {})
        k = alol_key(t.get("seamark:light:reference"))
        c = e.get("center", e)
        if k and "lat" in c:
            osm_by_alol[k] = (c["lat"], c["lon"], e["type"] + "/" + str(e["id"]))

    # Rowlett by Admiralty number
    row_by_alol = {}
    for r in rowlett:
        k = alol_key(r.get("adm"))
        if k and r["status"] == "Active":
            row_by_alol.setdefault(k, r)

    # Wikidata by position (nearest within 3 km)
    wdi = []
    for b in wd:
        m = re.search(r"Point\(([-\d.]+) ([-\d.]+)\)", b.get("coord", {}).get("value", ""))
        if m:
            wdi.append(dict(q=b["lh"]["value"].rsplit("/", 1)[1], lon=float(m.group(1)), lat=float(m.group(2)),
                            image=b.get("image", {}).get("value"), inception=b.get("inception", {}).get("value", "")[:4],
                            label=b.get("lhLabel", {}).get("value")))

    # independent named positions for the digit-slip check
    named_refs = []
    for path in ("osm_bbox.json", "osm_lights_all.json"):
        p = os.path.join(RAW, "osm", path)
        if not os.path.exists(p):
            continue
        for e in json.load(open(p))["elements"]:
            t = e.get("tags", {})
            c = e.get("center", e)
            nm = t.get("name:en") or t.get("name") or t.get("seamark:name")
            if nm and "lat" in c and re.search(r"light|lighthouse|dweep|island|point|reef|rock", nm + " " + t.get("man_made", "") + " " + t.get("seamark:type", ""), re.I):
                named_refs.append(dict(k=key(nm), lat=c["lat"], lon=c["lon"], src=f"OpenStreetMap {e['type']}/{e['id']}"))
    for w in wdi:
        named_refs.append(dict(k=key(w["label"]), lat=w["lat"], lon=w["lon"], src=f"Wikidata {w['q']}"))
    for r in rowlett:
        if r.get("coords") and r["status"] == "Active":
            la, lo = map(float, r["coords"][0])
            named_refs.append(dict(k=key(r["name"]), lat=la, lon=lo, src="Lighthouse Directory map link"))

    stations, notes = [], []
    ai_all = load_ai()
    from collections import Counter
    # Admiralty numbers copied between ledgers (Kalpeni carries East Island's F 1201) must not move a light
    alol_count = Counter(alol_key(a.get("alol")) for a in ai_all.values() if alol_key(a.get("alol")))
    diff_rows = []
    notes.append(f"ledger transcriptions: {len(ai_all)} of {len(ledgers)}")
    for r in ledgers:
        slug = r["slug"]
        if slug in ai_all:
            for field, old, new in apply_ai(r, ai_all[slug]):
                diff_rows.append((slug, field, old, new))
            if r.get("station_type") in ("decommissioned", "vts station", "radar/repeater station") and not r.get("period"):
                notes.append(f"skip {slug}: ledger station type {r['station_type']}")
                continue
            ai_txt = " ".join((ai_all[slug].get("issues") or []) + [str((ai_all[slug].get("tower") or {}).get("type"))])
            if re.search(r"light[^.]{0,60}non[\s-]*functional", ai_txt, re.I):
                notes.append(f"skip {slug}: ledger says the light is non-functional (not an active light)")
                continue
        if r.get("panels"):
            ap, why = active_panels(slug, r["panels"])
            if why and ap < r["panels"]:
                r["panels_total"], r["panels"], r["panels_note"] = r["panels"], ap, why
                notes.append(f"{slug}: {ap} active of {r['panels_total']} panels ('{why}')")
        title = html.unescape(r.get("dgll_title") or slug).replace(" Lighthouse", " Lighthouse").strip()
        sid = slug
        if slug in LEDGER_IS:
            sid, title, why = LEDGER_IS[slug]
            r["ledger_issues"] = (r.get("ledger_issues") or []) + [why]
            notes.append(f"{slug} -> {sid}: {why}")
        if re.search(r"loran|bishnupur|rcs-|vts-mcc|chudeshwar|repeater-station|break-water", slug):
            notes.append(f"skip non-light station {slug}")
            continue
        has_light = bool(r.get("period") or r.get("range_lum_nm")
                         or re.search(r"[A-Za-z]{2}", r.get("char_raw") or ""))
        kind = "lighthouse" if has_light else ("dgps" if "dgps" in slug else "vts" if "vts" in slug else "other")
        if kind == "other":
            notes.append(f"skip {slug}: no light characteristic")
            continue
        if "light-vessel" in slug:
            kind = "lightvessel"

        lat, lon, pos_src = r.get("lat"), r.get("lon"), "DGLL ledger"
        ak = alol_key(r.get("alol"))
        o = osm_by_alol.get(ak) if ak and alol_count.get(ak, 0) <= 1 else None
        if o and lat and lon:
            d = haversine_m(lat, lon, o[0], o[1])
            if d > 3000:
                notes.append(f"{slug}: ledger position {d/1000:.1f} km from OSM {o[2]} (same Admiralty {ak}) -> using OSM")
                lat, lon, pos_src = o[0], o[1], f"OpenStreetMap {o[2]}"
        elif o:
            lat, lon, pos_src = o[0], o[1], f"OpenStreetMap {o[2]}"
        # name check: ledger coordinates are hand-typed and a few carry digit slips
        # (e.g. Vizhinjam 93°E for 77°E). Trust a same-named OSM/Wikidata lighthouse
        # when the ledger point is far from it.
        nk = key(title)
        named = [c for c in named_refs if c["k"] and len(nk) >= 4 and (c["k"] == nk or c["k"].startswith(nk) or nk.startswith(c["k"]))]
        if slug in POSITION_FIX:
            lat, lon, why = POSITION_FIX[slug]
            pos_src = why
            notes.append(f"{slug}: {why}")
        elif named:
            if lat and lon:
                best = min(named, key=lambda c: haversine_m(lat, lon, c["lat"], c["lon"]))
                d = haversine_m(lat, lon, best["lat"], best["lon"])
                # > 8 km: paired lights (Minicoy North/South) sit ~5 km apart and must not merge
                if d > 8000 and pos_src == "DGLL ledger":
                    near_any = min(named_refs, key=lambda c: haversine_m(lat, lon, c["lat"], c["lon"]))
                    if haversine_m(lat, lon, near_any["lat"], near_any["lon"]) > 1500:
                        notes.append(f"{slug}: ledger position {d/1000:.1f} km from same-named {best['src']} -> using it")
                        lat, lon, pos_src = best["lat"], best["lon"], best["src"]
            else:
                best = named[0]
                lat, lon, pos_src = best["lat"], best["lon"], best["src"]
        alt_lat, alt_lon = alt_decimal_minutes(r.get("lat_text")), alt_decimal_minutes(r.get("lon_text"))
        if lat and lon and named and pos_src == "DGLL ledger" and (alt_lat or alt_lon):
            a_lat, a_lon = alt_lat or lat, alt_lon or lon
            best = min(named, key=lambda c: haversine_m(a_lat, a_lon, c["lat"], c["lon"]))
            d_alt = haversine_m(a_lat, a_lon, best["lat"], best["lon"])
            d_now = haversine_m(lat, lon, best["lat"], best["lon"])
            if d_alt < 600 and d_now - d_alt > 300:
                notes.append(f"{slug}: seconds read as decimal minutes ({r.get('lat_text')} / {r.get('lon_text')}) "
                             f"-> {d_alt:.0f} m from {best['src']} instead of {d_now:.0f} m")
                lat, lon = a_lat, a_lon
                pos_src = f"DGLL ledger, seconds column read as decimal minutes (matches {best['src']})"
        if not (lat and lon):
            notes.append(f"DROP {slug}: no position in ledger, no OSM match (ALOL {r.get('alol')})")
            continue

        ro = row_by_alol.get(ak) if ak else None
        if not ro:
            ro = next((x for x in rowlett if x["status"] == "Active" and key(x["name"]) == key(title)), None)
        if has_light and not r.get("period") and ro and ro.get("light"):
            # ledger gave no usable characteristic: use the Lighthouse Directory's wording
            from parse_ledgers import parse_character
            k2, g2, c2, p2, ph2 = parse_character(ro["light"])
            if p2:
                r.update(kind=k2, group=g2, colour=c2, period=p2, phases=ph2,
                         char_raw=r.get("char_raw") or ro["light"])
                notes.append(f"{slug}: characteristic from Lighthouse Directory '{ro['light']}'")
        w = min(wdi, key=lambda x: haversine_m(lat, lon, x["lat"], x["lon"]), default=None)
        if w and haversine_m(lat, lon, w["lat"], w["lon"]) > 3000:
            w = None

        year = None
        if ro and ro.get("year") and ro["year"][:1].isdigit():
            year = int(ro["year"])
        est = None
        if ro:
            m = re.search(r"station established (\d{4})", ro["text"])
            est = int(m.group(1)) if m else year
        if not est and w and w["inception"].isdigit():
            est = int(w["inception"])
        if not est and r.get("established"):
            est = r["established"]

        elev = r.get("elev_m")
        geo_nm = r.get("range_geo_nm") or (round(2.075 * (math.sqrt(elev) + math.sqrt(EYE_M)), 1) if elev else None)
        lum_nm = r.get("range_lum_nm")
        reach_nm = min(x for x in (lum_nm, geo_nm) if x) if (lum_nm or geo_nm) else None

        visit = None
        if ro and ro.get("visit"):
            visit = "open" if re.search(r"tower open", ro["visit"], re.I) else ("grounds" if re.search(r"site open", ro["visit"], re.I) else "closed")

        s = dict(
            id=sid, name=re.sub(r"\s+", " ", title), region=REGION_LABEL.get(r.get("region"), r.get("region")),
            kind=kind, lat=round(lat, 5), lon=round(lon, 5), pos_src=pos_src,
            alol=r.get("alol"), elev_m=elev, char=r.get("char_raw"), ckind=r.get("kind"), group=r.get("group"),
            # "ledger": the itemised light/eclipse timings are printed; "derived": built from the
            # characteristic and flash duration because the ledger itemises none
            phases_src="ledger" if (r.get("phases") and len(r["phases"]) % 2 == 0 and sum(r["phases"]) >= 1) else "derived",
            phases=phases_for(r) if has_light else None, colour=r.get("colour"), period=r.get("period"),
            lum_nm=lum_nm, geo_nm=geo_nm, reach_nm=reach_nm,
            tower_type=r.get("tower_type") if r.get("tower_type") not in ("Size", "Height", "equipment") else None,
            tower_h_m=r.get("tower_h_m"), tower_colour=r.get("tower_colour"),
            # motor-shaft figures (1500, 2800) are not optic speeds
            rpm=r.get("rpm") if r.get("rpm") and 0.2 <= r["rpm"] <= 12 else None, panels=r.get("panels"),
            optic=r.get("optic"), optic_evidence=r.get("optic_evidence"),
            div_h_cands=r.get("div_h_cands"), sectored=r.get("sectored"), flash_s=r.get("flash_s"),
            sectors_text=r.get("sectors_text"), optic_detail=r.get("optic_detail"),
            panels_total=r.get("panels_total"), panels_note=r.get("panels_note"),
            ledger_issues=r.get("ledger_issues") or [], transcribed=slug in ai_all, intensity_cd=r.get("intensity_cd"), optic_order=r.get("optic_order"),
            led=r.get("led"), solar=r.get("solar"), ais=r.get("ais"), dgps=r.get("dgps"),
            racon=None, navtex=None, vts="vts" in slug,
            tower_year=year, established=est, visit=visit,
            rowlett=(ro["text"][:700] if ro else None), arlhs=(ro or {}).get("arlhs"),
            # some DGLL pages carry no station photo, only site banners (india.gov.in, data.gov …)
            photo=(r.get("dgll_photo") if not re.search(r"india_gov|data\.gov|digital-india|dgindia|logo|emblem|banner",
                                                          r.get("dgll_photo") or "", re.I) else None) or (w or {}).get("image"),
            wikidata=(w or {}).get("q"), ledger_url=r.get("ledger_url"), page_url=r.get("page_url"),
        )
        # tower type/colour only ever come from the ledger: the Directory's free text doesn't
        # split cleanly into fields ("tower with lantern and gallery, painted with …")
        if r.get("racon_ledger"):
            s["racon"] = r["racon_ledger"]
        stations.append(s)

    with open(os.path.join(BUILD, "parse_diff.csv"), "w") as f:
        f.write("slug,field,regex_parse,ledger_transcription\n")
        for slug, field, old, new in diff_rows:
            f.write(f"{slug},{field},\"{str(old).replace(chr(34), chr(39))}\",\"{str(new).replace(chr(34), chr(39))}\"\n")
    notes.append(f"regex vs ledger transcription differences: {len(diff_rows)} (build/parse_diff.csv)")

    # ---- tourism-list lighthouses with no DGLL ledger page
    from parse_ledgers import parse_character
    for x in EXTRA:
        if any(s["id"] == x["id"] for s in stations):
            notes.append(f"EXTRA {x['id']}: already on the map from a DGLL ledger")
            continue
        ro = next((r for r in rowlett if r["status"] == "Active" and r["src"] in ("inkl", "ingjw", "inmh")
                   and r["name"].startswith(x["rowlett"]) and not r["name"].startswith("Maharashtra")), None)
        if not ro or x["lat"] is None:
            notes.append(f"EXTRA skipped {x['id']}: {'no Directory entry' if not ro else 'no position'}")
            continue
        k2, g2, c2, p2, ph2 = parse_character(ro["light"] or "")
        rr = dict(kind=k2, group=g2, colour=c2, period=p2, phases=ph2, flash_s=None)
        focal = float(ro["focal_m"]) if ro.get("focal_m") else None
        geo = round(2.075 * (math.sqrt(focal) + math.sqrt(EYE_M)), 1) if focal else None
        m = re.search(r"station established (\d{4})", ro["text"])
        stations.append(dict(
            id=x["id"], name=x["name"], region=x["region"], kind="lighthouse", lat=x["lat"], lon=x["lon"],
            pos_src=x["pos_src"], alol=x["alol"], elev_m=focal, char=ro["light"], ckind=k2, group=g2, phases_src="derived",
            phases=phases_for(rr), colour=c2, period=rr["period"], lum_nm=None, geo_nm=geo, reach_nm=geo,
            tower_type=ro.get("tower"), tower_h_m=num_or_none(ro.get("tower")), tower_colour=ro.get("colors"),
            rpm=None, panels=None, optic=None, optic_evidence=None, intensity_cd=None, optic_order=None,
            led=None, solar=None, ais=None, dgps=None, racon=None, navtex=None, vts=False,
            tower_year=int(ro["year"]) if (ro.get("year") or "")[:1].isdigit() else None,
            established=int(m.group(1)) if m else (int(ro["year"]) if (ro.get("year") or "")[:1].isdigit() else None),
            visit=None, rowlett=ro["text"][:700], arlhs=ro.get("arlhs"), photo=None, wikidata=None,
            ledger_url=None, page_url=None, no_ledger=True,
        ))
        notes.append(f"EXTRA {x['id']}: from Lighthouse Directory + Lok Sabha Q3233 tourism list")

    # ---- Lok Sabha Q3233 tourism + museum flags
    tour_ids = {slug: (state, name) for state, d in TOURISM.items() for name, slug in d.items()}
    ids = {s["id"] for s in stations}
    for slug in tour_ids:
        if slug not in ids:
            notes.append(f"TOURISM name not on map: {tour_ids[slug]} -> {slug}")
    for s in stations:
        s["tourism"] = s["id"] in tour_ids
        s["museum"] = s["id"] in MUSEUMS

    # ---- full Master Ledger records: one JSON per station, lazily loaded by the record viewer
    full_all = {}
    if os.path.isdir(FULL_DIR):
        for fn in os.listdir(FULL_DIR):
            if fn.endswith(".json"):
                try:
                    d = json.load(open(os.path.join(FULL_DIR, fn)))
                    full_all[d.get("slug") or fn[:-5]] = d
                except (ValueError, OSError) as e:
                    notes.append(f"bad ledger_full file {fn}: {e}")
    slug_of = {v[0]: k for k, v in LEDGER_IS.items()}             # station id -> ledger slug when misfiled
    rec_dir = os.path.join(WEB, "ledgers")
    os.makedirs(rec_dir, exist_ok=True)
    years_by_key = {}
    for s in stations:
        slug = slug_of.get(s["id"], s["id"])
        full = full_all.get(slug)
        s["record"] = bool(full)
        s["equip_years"] = equipment_years(full) if full else {}
        for k, y in s["equip_years"].items():
            years_by_key.setdefault(k, []).append(y)
        if full:
            json.dump(dict(full, station_id=s["id"], name=s["name"], ledger_url=s.get("ledger_url"), page_url=s.get("page_url"),
                           ledger_issues=s.get("ledger_issues") or [], sim_flags=(s.get("sim") or {}).get("flags") or []),
                      open(os.path.join(rec_dir, s["id"] + ".json"), "w"), ensure_ascii=False, separators=(",", ":"))
    notes.append(f"full ledger records published: {sum(s['record'] for s in stations)}")

    STATION_FULL = full_all          # used after NAVTEX/RACON matching, below

    # ---- per-light simulation from the Master Ledger + audit table
    import csv
    for s in stations:
        s["sim"] = light_sim(s)
        s.pop("div_h_cands", None)
    with open(os.path.join(BUILD, "light_audit.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "name", "characteristic", "period_s", "phases", "flash_s", "optic", "optic_evidence", "rpm",
                    "panels", "sim_mode", "sec_per_turn", "turn_source", "beam_width_deg", "width_source", "sectored", "flags"])
        for s in stations:
            sim = s["sim"] or {}
            w.writerow([s["id"], s["name"], s.get("char"), s.get("period"), s.get("phases"), s.get("flash_s"), s.get("optic"),
                        s.get("optic_evidence"), s.get("rpm"), s.get("panels"), sim.get("mode"), sim.get("rev_s"),
                        sim.get("rev_src") or sim.get("reason"), sim.get("width_deg"), sim.get("width_src"),
                        s.get("sectored"), " | ".join(sim.get("flags", []))])
    import shutil
    shutil.copy(os.path.join(BUILD, "light_audit.csv"), os.path.join(WEB, "light_audit.csv"))

    by_key = {}
    for s in stations:
        by_key.setdefault(key(s["name"]), s)
        by_key.setdefault(key(s["id"].replace("-", " ")), s)

    def match(name, lat=None, lon=None):
        k = key(name)
        if k in by_key:
            return by_key[k]
        cands = [s for kk, s in by_key.items() if kk and (kk.startswith(k) or k.startswith(kk)) and min(len(k), len(kk)) >= 4]
        if cands:
            return cands[0]
        if lat:
            near = min(stations, key=lambda s: haversine_m(lat, lon, s["lat"], s["lon"]))
            if haversine_m(lat, lon, near["lat"], near["lon"]) < 6000:
                return near
        return None

    # ---- NAVTEX (DGLL table: name | "Lat .. Long .." | id518 | id490 | slots518 | slots490)
    cells = table_cells(os.path.join(RAW, "dgll", "dgll_navtex.html"))
    navtex = []
    i = max(j for j, c in enumerate(cells[:40]) if c == "490 KHZ") + 1
    while i + 5 < len(cells):
        name, loc, a, b, s1, s2 = cells[i:i + 6]
        if not re.search(r"Lat", loc, re.I):
            break
        la, lo = re.split(r"Long", loc, flags=re.I)
        lat, lon = dm(la), dm(lo)
        st = match(name, lat, lon)
        rec = dict(name=name.strip().title(), lat=round(lat, 5), lon=round(lon, 5), id_518=a, id_490=b,
                   slots_518=[x.strip() for x in s1.split(",")], slots_490=[x.strip() for x in re.sub(r"Pause.*", "", s2).split(",")],
                   station=st["id"] if st else None)
        if st:
            st["navtex"] = {"id_518": a, "id_490": b}
            rec["lat"], rec["lon"] = st["lat"], st["lon"]
        navtex.append(rec)
        i += 6
    notes.append(f"navtex stations: {[(n['name'], n['station']) for n in navtex]}")

    # ---- RACON (DGLL table: sl | name | code | [directorate])
    cells = table_cells(os.path.join(RAW, "dgll", "dgll_racon.html"))
    racons = []
    for j, c in enumerate(cells):
        if re.fullmatch(r"\d{1,2}", c) and j + 2 < len(cells):
            name, code = cells[j + 1], cells[j + 2]
            pos = None
            if re.search(r"\d+\s*°", code):              # offshore platforms carry a position column
                pos, code = code, cells[j + 3]
            if not re.fullmatch(r"[A-Z]", code):
                continue
            plat = plon = None
            if pos:
                mm = re.findall(r"(\d{1,2})\s*°\s*(\d{1,2}(?:\.\d+)?)", pos)
                if len(mm) >= 2:
                    plat = int(mm[0][0]) + float(mm[0][1]) / 60
                    plon = int(mm[1][0]) + float(mm[1][1]) / 60
            st = None if pos else match(name)
            if st:
                st["racon"] = code
            racons.append(dict(name=name, code=code, station=st["id"] if st else None,
                               lat=plat if plat else (st or {}).get("lat"), lon=plon if plon else (st or {}).get("lon")))
    notes.append(f"racon unmatched: {[r['name'] for r in racons if not r['station'] and not r['lat']]}")

    # ---- VTS Gulf of Kutch radar sites (DGLL VTS page)
    for s in stations:
        if re.search(r"koteshwar|jakhau|chhachhi|mandvi|navinal|kandla|balachadi|chudeshwar|okha", s["id"]):
            s["vts"] = True

    # ---- when each equipment appears on the timeline: the station's own ledger year, else the
    # earliest year any ledger records for that network (the card says which)
    by_id = {s["id"]: s for s in stations}
    navtex_years = [by_id.get(n["station"], {}).get("equip_years", {}).get("navtex") for n in navtex]
    balasore = equipment_years(STATION_FULL.get("balasore-navtex-station")).get("navtex")
    known = [y for y in navtex_years + [balasore] if y]
    racon_years = [s["equip_years"].get("racon") for s in stations if s.get("equip_years", {}).get("racon")]
    dgps_years = [s["equip_years"].get("dgps") for s in stations if s.get("equip_years", {}).get("dgps")]
    network_first = {"navtex": min(known) if known else None, "racon": min(racon_years) if racon_years else None,
                     "ais": 2012, "dgps": min(dgps_years) if dgps_years else None}
    for s in stations:
        since = {}
        for k in ("navtex", "racon", "ais", "dgps"):
            if not s.get(k):
                continue
            y = s.get("equip_years", {}).get(k)
            if y:
                since[k] = {"year": y, "src": "ledger"}
            elif network_first.get(k):
                since[k] = {"year": network_first[k], "src": "network"}
        s["equip_since"] = since
    for n, y in zip(navtex, navtex_years):
        if not y and n["name"].lower().startswith("balasore"):
            y = balasore
        n["since"] = y or network_first["navtex"]
        n["since_src"] = "ledger" if y else "network"
    notes.append(f"equipment network first years: {network_first}")

    # ---- reach geometry
    sea = Sea()
    reach = {"lights": {}, "navtex": {}}
    for s in stations:
        if s["kind"] in ("lighthouse", "lightvessel") and s["reach_nm"]:
            g, s["sea_mask"] = sea.light_reach(s["lat"], s["lon"], s["reach_nm"] * NM)
            m = mesh(g, tol=0.003)
            if m:
                reach["lights"][s["id"]] = m
    for n in navtex:
        g = sea.radio_reach(n["lat"], n["lon"], NAVTEX_NM * NM)
        m = mesh(g, tol=0.01, nd=4)
        if m:
            reach["navtex"][n["id_518"]] = m

    stations.sort(key=lambda s: (-s["lat"] if s["lon"] < 88 else 100 - s["lat"]))
    # local photo copies (scripts/fetch_photos.py) and the tender archive (scripts/link_tenders.py)
    photos_path, tenders_path = os.path.join(BUILD, "photos.json"), os.path.join(BUILD, "tenders_linked.json")
    photos = json.load(open(photos_path)) if os.path.exists(photos_path) else {}
    tender_links = json.load(open(tenders_path))["by_station"] if os.path.exists(tenders_path) else {}
    for s in stations:
        if s["id"] in photos:
            s["photo_local"] = f"photos/{s['id']}.jpg"
            s["photo"] = s.get("photo") or photos[s["id"]]["src"]
        if tender_links.get(s["id"]):
            s["tenders"] = tender_links[s["id"]]
    meta = dict(
        built=open(os.path.join(RAW, "FETCHED_AT")).read().strip(),
        counts=dict(stations=len(stations), lighthouses=sum(s["kind"] == "lighthouse" for s in stations),
                    navtex=len(navtex), racon=len(racons), ais=sum(bool(s["ais"]) for s in stations),
                    dgps=sum(bool(s["dgps"]) for s in stations), solar=sum(bool(s["solar"]) for s in stations)),
        navtex_nm=NAVTEX_NM, eye_m=EYE_M,
    )
    os.makedirs(WEB, exist_ok=True)
    meta["counts"].update(tourism=sum(s["tourism"] for s in stations), museums=sum(s["museum"] for s in stations),
                          revolving=sum(s.get("optic") == "revolving" for s in stations),
                          flasher=sum(s.get("optic") == "flasher" for s in stations))
    parliament = dict(
        budget=dict(rows=BUDGET, unit="₹ crore", note="Funds for improvement and upgradation of lighthouse infrastructure",
                    source="Lok Sabha Unstarred Question 949, answered 24.07.2026", url=LS_949),
        technologies=dict(names=["DGNSS", "RACON", "NAVTEX", "NAIS", "VTS (Gulf of Kutch)"],
                          source="Lok Sabha Unstarred Question 949, answered 24.07.2026", url=LS_949),
        tourism=dict(count=75, museums=sorted(MUSEUMS), source="Lok Sabha Unstarred Question 3233, answered 07.08.2026",
                     url=LS_3233, law="Section 23, Marine Aids to Navigation Act, 2021"),
        planned=dict(sites=PLANNED, waterway="National Waterway-2 (Brahmaputra)", mou="DGLL–IWAI MoU, 08.04.2025",
                     status="Work orders issued", source="Lok Sabha Unstarred Question 3233, answered 07.08.2026", url=LS_3233),
    )
    json.dump(dict(meta=meta, stations=stations, navtex=navtex, racons=racons, parliament=parliament),
              open(os.path.join(WEB, "lighthouses.json"), "w"), separators=(",", ":"), ensure_ascii=False)
    json.dump(reach, open(os.path.join(WEB, "reach.json"), "w"), separators=(",", ":"))
    open(os.path.join(BUILD, "build_notes.txt"), "w").write("\n".join(notes) + "\n")
    print(json.dumps(meta, indent=1))
    print("\n".join(n for n in notes if n.startswith(("DROP", "navtex", "racon")) or "km from OSM" in n))
    for f in ("lighthouses.json", "reach.json"):
        print(f, f"{os.path.getsize(os.path.join(WEB, f)) / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
