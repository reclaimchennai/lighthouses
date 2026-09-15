#!/usr/bin/env python3
"""
Parse DGLL "Master Ledger" PDFs (pdftotext -layout output) into structured records.

The ledgers are the Directorate General of Lighthouses & Lightships' own per-station
sheets, linked from https://www.dgll.nic.in/DGLL-light-house-location/<region>.
Layouts differ by region office (tables, "key : value" lists, Hindi/English
columns), so every field is found by label regex, tolerant of OCR-ish noise
such as a degree sign rendered as "0" or "o".

Input : raw/dgll/ledger/*.txt, raw/dgll/detail/*.html, raw/dgll/regions.json
Output: build/ledgers.json
"""
import glob
import html
import json
import os
import re

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(HERE, "raw", "dgll")
OUT = os.path.join(HERE, "build", "ledgers.json")


def norm(t: str) -> str:
    t = t.replace("\u3007", "°").replace("\u00ba", "°").replace("˚", "°").replace("̊", "°")
    t = t.replace("’", "'").replace("‘", "'").replace("´", "'").replace("′", "'")
    t = t.replace("”", '"').replace("˝", '"').replace("″", '"')
    return t


# ---------------------------------------------------------------- position
RANGE = {"lat": (5, 25), "lon": (67, 95)}


def parse_coord(s: str, axis: str):
    """Parse one hand-typed ledger coordinate into decimal degrees.

    Seen in the wild: 13〫 02' 22" / 15° 29.32' / 120 04.90' (degree sign
    became a trailing 0) / 10011.9' / 87051 54" / 15*51.2' / 19` 50' 7" /
    22.9096° / 09 17 01.944 / 10º.00'.65" / 19° 27. 40' / 13 .4' /
    79° 04'71" (seconds >= 60 are really decimal minutes).
    """
    lo, hi = RANGE[axis]
    ok = lambda v: lo <= v <= hi
    s = re.sub(r"[^0-9.]+", " ", s).strip()
    toks = [x for x in s.split() if x not in (".",)]
    if not toks:
        return None
    first = toks[0]
    if "." in first and len(toks) == 1 and ok(float(first.strip("."))):
        return float(first.strip("."))
    if "." in first and ok(float(first.strip("."))) and not re.match(r"^\d+\.\d{1,2}$", toks[1] if len(toks) > 1 else ""):
        return float(first.strip("."))
    deg, rest = None, toks[1:]
    d = first.strip(".")
    if d.isdigit() and ok(int(d)) and len(d) <= 3 and not (len(d) == 3 and d[0] != "0"):
        deg = int(d)
    elif d.isdigit() and d.endswith("0") and ok(int(d[:-1] or 0)) and len(d) <= 3:
        deg = int(d[:-1])
    else:
        body = first
        for k in (1, 2):
            if body[:k].isdigit() and ok(int(body[:k])):
                rem = body[k:]
                if rem.startswith("0") and len(rem.split(".")[0]) > 2:
                    rem = rem[1:]
                if rem and re.match(r"^\d{1,2}(\.\d+)?$", rem):
                    deg, rest = int(body[:k]), [rem] + toks[1:]
                    break
    if deg is None or not rest:
        return None
    # minutes (glue "27." + "40", "13" + ".4", ".00" + ".65")
    m = rest[0].lstrip(".")
    i = 1
    if m.endswith(".") and i < len(rest):
        m, i = m + rest[i], i + 1
    elif i < len(rest) and rest[i].startswith(".") and rest[i].count(".") == 1:
        m, i = m + rest[i], i + 1
    sec = rest[i].lstrip(".") if i < len(rest) else None
    try:
        mi = float(m.strip("."))
    except ValueError:
        return None
    if sec:
        try:
            sv = float(sec)
        except ValueError:
            sv = 0
        if sv >= 60 and "." not in m:
            mi, sv = float(f"{int(mi)}.{sec.replace('.', '')}"), 0
        if sv < 60:
            mi += sv / 60
    if mi >= 60:
        return None
    v = deg + mi / 60
    return v if ok(v) else None


def find_position(t: str):
    t = norm(t)
    m = re.search(r"(?:Position|स्थान|\bLat)", t)
    if not m:
        return None, None
    end = re.search(r"Elevation|ऊंचाई|Characteristic|Tower\s*:", t[m.start():])
    blk = t[m.start(): m.start() + (end.start() if end else 260)]
    blk = re.sub(r"Position|स्थान|/", " ", blk)
    blk = re.sub(r"^\s*\d\.?\s", " ", blk, flags=re.M)             # stray item numbers
    blk = re.sub(r"Lat(?:itude)?[\s.:,\-]*[NS]?\b", " LAT ", blk, flags=re.I)
    parts = re.split(r"\bLon(?:g(?:itude)?)?\b[\s.:\-]*[EW]?\b", blk, maxsplit=1, flags=re.I)
    if len(parts) == 2:
        lat_s, lon_s = parts
    else:
        parts = re.split(r"(?<![A-Za-z])N(?![A-Za-z])", blk, maxsplit=1)
        if len(parts) != 2:
            return None, None
        lat_s, lon_s = parts
    lat_s = re.split(r"(?<![A-Za-z])[NS](?![A-Za-z])", lat_s.replace("LAT", " "))[0]
    lon_s = re.split(r"(?<![A-Za-z])[EW](?![A-Za-z])", lon_s)[0]
    return parse_coord(lat_s, "lat"), parse_coord(lon_s, "lon")


# ---------------------------------------------------------------- character
WORDNUM = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6}


def parse_character(raw: str):
    """Return (kind, group, colour, period_s, phases[]) from a characteristic string.

    phases alternate light/eclipse durations starting with light, e.g.
    Fl(2) W 10s (0.57+1.93+0.57+6.93) -> [0.57, 1.93, 0.57, 6.93]
    """
    s = norm(raw or "")
    low = s.lower()
    kind = "Fl"
    if re.search(r"\biso\b|isophase", low):
        kind = "Iso"
    elif re.search(r"\boc(?:c)?\b|occult", low):
        kind = "Oc"
    elif re.search(r"\bq\b|quick", low):
        kind = "Q"
    elif re.search(r"\bf\b(?!l)|fixed|continuous", low):
        kind = "F"
    group = 1
    m = (re.search(r"\(\s*(\d)\s*\)", s) or re.search(r"group\s*(\d)\b", s, re.I)
         or re.search(r"(?:group\s*flash|flash|fl)\s*\.?\s*(\d)\b(?!\s*(?:sec|s\b|\.\d))", s, re.I))
    if m:
        group = int(m.group(1))
    else:
        m = re.search(r"\b(one|two|three|four|five|six)\b", low)
        if m:
            group = WORDNUM[m.group(1)]
    colour = "W"
    if re.search(r"\bred\b|\bR\b(?!\s*P)", s) and not re.search(r"white|\bW\b", s):
        colour = "R"
    elif re.search(r"\bgreen\b|\bG\b", s) and not re.search(r"white|\bW\b", s):
        colour = "G"
    period = None
    m = (re.search(r"every\s*(\d+(?:\.\d+)?)\s*(?:sec(?:ond)?s?|s)\b", s, re.I)
         or re.search(r"(\d+(?:\.\d+)?)\s*(?:sec(?:ond)?s?|s)\b(?![^()]*\))", s, re.I))
    if m and float(m.group(1)) >= 1:
        period = float(m.group(1))
    phases = []
    m = re.search(r"\(([0-9.\s+]+(?:\+[0-9.\s]+)+)(?:=[^)]*)?\)", s)
    if m:
        try:
            phases = [float(x) for x in m.group(1).split("+") if x.strip()]
        except ValueError:
            phases = []
    if not phases:  # "Fl 0.33 Sec. Ec 9.67 Sec."
        fl = re.findall(r"fl\.?\s*\.?(\d*\.?\d+)", s, re.I)
        ec = re.findall(r"ec\.?\s*\.?(\d*\.?\d+)", s, re.I)
        if fl and ec:
            phases = [float(fl[0]), float(ec[0])]
    if phases and not period:
        period = round(sum(phases), 2)
    return kind, group, colour, period, phases


NIL = r"(?:nil|n/?a|not\s*provided|not\s*applicable|-{1,4}|—|none)"


# ---------------------------------------------------------- light function
def optic_block(t: str) -> str:
    """The optical-equipment section only. Engine, alternator, solar and control-panel
    tables elsewhere also print 'RPM' and 'panels'."""
    m = re.search(r"(Optic(?:al)?\b.*?)(?=Effective\s*beam|प्रि|Source\s*of\s*energy|RACON|Mains\b|Power\s*Source|"
                  r"Engine|Alternator|Generator|Solar|Battery|Batteries)", t, re.S | re.I)
    return re.sub(r"[ \t]+", " ", m.group(1)) if m else ""


def _num(v: str):
    v = v.replace(" ", "")
    if "/" in v:
        a, b = v.split("/", 1)
        return float(a) / float(b) if float(b) else None
    return float(v)


def optic_rpm(blk: str, t: str):
    """'R.P.M. 3', 'R.P.M. 4/3 RPM', 'RPM 1.5', 'Rotation Speed : 0.667 RPM', '0.67'.
    Speeds outside 0.2-12 rpm are motor shafts (1500, 2800), not the lens."""
    pats = [
        (t, r"Rotation\s*Speed\s*[:\-]?\s*(\d+(?:\.\d+)?(?:\s*/\s*\d+)?)"),
        (blk, r"R\.?\s*P\.?\s*M\.?\s*[:\-]?\s*(\d+(?:\.\d+)?(?:\s*/\s*\d+)?)"),
        (blk, r"(\d+(?:\.\d+)?(?:\s*/\s*\d+)?)\s*r\.?\s*p\.?\s*m", ),
    ]
    for src, p in pats:
        for m in re.finditer(p, src, re.I):
            try:
                v = _num(m.group(1))
            except ValueError:
                continue
            if v and 0.2 <= v <= 12:
                return round(v, 3)
    return None


def optic_panels(blk: str):
    """'No. of lens 4', 'No. of panels 6', '6 Panels', '3 nos. at 120° each', 'panels equally spaced at 60'."""
    pats = [
        r"No\.?\s*of\s*(?:lens(?:es)?|panels?)(?:\s*/\s*No\.?\s*of\s*panels?)?\s*[:\-]?\s*(\d{1,2})\b(?!\s*(?:mm|°|º))",
        r"\b(\d{1,2})\s*(?:nos?\.?\s*)?panels?\b",
        r"\b(\d)\s*nos?\.?\s*at\s*\d+\s*[o°º]?\s*each",
    ]
    for p in pats:
        m = re.search(p, blk, re.I)
        if m and 1 <= int(m.group(1)) <= 12:
            return int(m.group(1))
    m = re.search(r"panels?\s*equally\s*spaced\s*at\s*(\d{2,3})", blk, re.I)
    if m and 360 % int(m.group(1)) == 0:
        return 360 // int(m.group(1))
    return None


def divergence_candidates(blk: str):
    """Every plausible reading of the horizontal divergence. pdftotext turns the degree
    sign into a 0 ('Horizontal 30' = 3°, '3600' = 360°, '5057'' = 5°57'), so ambiguous
    tokens yield several candidates; build_data picks the one consistent with the flash."""
    out = []

    def add(deg, minutes=None, apostrophe=False):
        try:
            d = float(deg)
        except ValueError:
            return
        mi = float(minutes) / 60 if minutes else 0.0
        out.append(d + mi)
        if re.fullmatch(r"\d*[1-9]0", deg) or re.fullmatch(r"\d+00", deg):       # trailing 0 = degree sign
            out.append(float(deg[:-1]) + mi)
        if apostrophe and not minutes and re.fullmatch(r"\d{4}", deg) and deg[-3] == "0":
            out.append(float(deg[:-3]) + float(deg[-2:]) / 60)                     # 5057' = 5°57'

    deg = r"(\d+(?:\.\d+)?)\s*[°º*o]?\s*\.?\s*(?:(\d{1,2}(?:\.\d+)?)\s*['’])?(['’])?"
    for m in re.finditer(deg + r"\s*\(\s*Horiz", blk, re.I):
        add(m.group(1), m.group(2), bool(m.group(3)))
    for m in re.finditer(r"Horizontal\s*(?:Divergence)?\s*\)?\s*[:\-–]*\s*" + deg, blk, re.I):
        add(m.group(1), m.group(2), bool(m.group(3)))
    for m in re.finditer(r"(\d+(?:\.\d+)?)\s*[°º*]\s*Horizontal", blk, re.I):
        add(m.group(1))
    return sorted({round(c, 3) for c in out if 0.2 <= c <= 360}) or None


def classify_optic(t: str):
    """Does this light physically rotate?

    'revolving': a lens/beam assembly on a rotation device (stepper motor, mercury-float
                 pedestal, an RPM figure, "revolving"). Sweeps 360°.
    'flasher'  : LED flasher / marine lantern / fixed drum optic. Blinks in place.
    None       : the ledger does not say.
    Only the optic section is read: the RACON/NAIS/lamp tables elsewhere mention LEDs and
    print "Rotation Device" / "R.P.M." headings even for stations without either."""
    m = re.search(r"(Optic(?:al)?\b.*?)(?=Effective\s*beam|प्रि|Source\s*of\s*energy|RACON|Mains\b|Power\s*Source|Lantern\b)",
                  t, re.S | re.I)
    blk = re.sub(r"[ \t]+", " ", m.group(1)) if m else ""

    def val(label):
        mm = re.search(label + r"[\s.:\-]*([^\n]{0,60})", blk, re.I)
        return mm.group(1).strip() if mm else None

    rot_dev, rpm, ped = val(r"Rotation\s*Device"), val(r"R\.?\s*P\.?\s*M\.?"), val(r"Pedestal")
    rot = []
    if rot_dev and not re.match(NIL, rot_dev, re.I) and re.search(r"motor|stepper|gear|clock|drive|rotat", rot_dev, re.I):
        rot.append("rotation device: " + rot_dev[:30])
    if rpm and re.match(r"\d", rpm):
        rot.append("RPM " + rpm[:10])
    if re.search(r"revolv|rotating|rotary|\bMBR\b", blk, re.I):
        rot.append("revolving optic")
    if ped and re.search(r"mercury|roller|ball\s*bearing", ped, re.I):
        rot.append("pedestal: " + ped[:20])
    fl = []
    if re.search(r"LED\s*flasher|marine\s*(?:flasher|signal)|LED\s*lantern|flasher|flashing\s*unit|lantern\s*LED|self[- ]contained|"
                 r"Sealite|\bSL\s*-?\s*\d{2,3}|MBL-?\d|Carmanah|Automatic\s*Power|drum\s*optic|\bfixed\b", blk, re.I):
        fl.append("LED flasher / fixed optic")
    nil_dev = bool(rot_dev and re.match(NIL, rot_dev, re.I))
    if rot and not nil_dev:
        return "revolving", "; ".join(rot)
    if fl or nil_dev:
        return "flasher", fl[0] if fl else "rotation device NIL"
    return None, None


def num(s):
    m = re.search(r"(\d+(?:\.\d+)?)", s or "")
    return float(m.group(1)) if m else None


def after(label_re, t, width=90):
    m = re.search(label_re + r"[\s:\-]*([^\n]{1,%d})" % width, t, re.I)
    return m.group(1).strip() if m else None


def field_block(label_re, t, lines=3):
    m = re.search(label_re, t, re.I)
    if not m:
        return ""
    return "\n".join(t[m.end():].split("\n")[:lines])


def parse_ledger(slug: str, t: str) -> dict:
    t = norm(t)
    flat = re.sub(r"[ \t]+", " ", t)
    lat, lon = find_position(t)
    rec = {"slug": slug, "lat": lat, "lon": lon}

    m = re.search(r"(?:A\.?\s*L\.?\s*O\.?\s*L\.?|Sr\.?\s*No\.?\s*\(?A\.?L\.?O\.?L)[^\n]*?\b([A-Z]?\s?\d{3,4}(?:\.\d+)?)", t, re.I)
    if not m:
        m = re.search(r"\bF\s?(\d{3,4}(?:\.\d+)?)\b", t)
        rec["alol"] = ("F " + m.group(1)) if m else None
    else:
        v = m.group(1).replace(" ", "")
        rec["alol"] = ("F " + v.lstrip("F")) if v else None

    m = re.search(r"Elevation(?: of tower)?[^\n]*?(\d+(?:\.\d+)?)\s*(?:m|M|mtr|meter)", t)
    rec["elev_m"] = float(m.group(1)) if m else None
    m = re.search(r"Elevation[^\n]*?\+\s*(\d+(?:\.\d+)?)", t)  # "1m above sea level + 22m"
    if m and rec["elev_m"] is not None and rec["elev_m"] < 5:
        rec["elev_m"] += float(m.group(1))

    # label is often wrapped ("Characteristi\n c", "Characteris\n tic") or "Character ofLight"
    ch = field_block(r"Charac[a-zA-Z]*(?:\s*of\s*Light)?", t, 2)
    ch = re.sub(r"\n\s*(?:c|tic|ic|stic)\s*(?=\n|$)", "\n", ch)
    ch = re.sub(r"\s{3,}", " ", ch)
    ch = re.split(r"\s\d\.\s|[\u0900-\u097F]|Range in|Luminous", ch)[0]
    rec["char_raw"] = re.sub(r"^[\s:\-]+", "", ch).strip()[:120] or None
    kind, group, colour, period, phases = parse_character(rec["char_raw"])
    rec.update(kind=kind, group=group, colour=colour, period=period, phases=phases)

    blk = field_block(r"Range\s*(?:in)?\s*(?:nautical)?\s*(?:miles)?", t, 4) + "\n" + field_block(r"नॉ[^\n]*", t, 3)
    m = re.search(r"Luminous[^0-9\n]*?(\d+(?:\.\d+)?)\s*(?:NM|N\.M|Nm|M\b|nautical)?", blk + t, re.I)
    rec["range_lum_nm"] = float(m.group(1)) if m else None
    m = re.search(r"@\s*(\d+(?:\.\d+)?)\s*NM", flat)  # A.T.F. 0.74 @ 22 NM -> nominal range at T=0.74
    if m:
        rec["range_lum_nm"] = float(m.group(1))
    m = re.search(r"Geographical[^0-9\n]*?(\d+(?:\.\d+)?)", t, re.I)
    rec["range_geo_nm"] = float(m.group(1)) if m else None
    if rec["range_lum_nm"] is None:
        m = re.search(r"Range in (?:nautical )?miles[^\n]*?(\d+(?:\.\d+)?)\s*(?:NM|N\s*Miles|M\b)", flat, re.I)
        if not m:
            m = re.search(r"नॉ[^\n]*?(\d+(?:\.\d+)?)\s*(?:NM|N\s*Miles|Nm)", flat)
        rec["range_lum_nm"] = float(m.group(1)) if m else None

    tower = field_block(r"(?:L\.?\s*H\.?\s*Tower|Lighthouse Tower|Tower)", t, 8)
    m = re.search(r"Type\s*[:\-]?\s*([^\n]+)", tower)
    ttype = re.sub(r"\s{2,}.*$", "", m.group(1)).strip() if m else ""
    # continuation line of a wrapped type ("Tower")
    rec["tower_type"] = ttype or None
    m = re.search(r"Height\s*[:\-]?\s*(\d+(?:\.\d+)?)", tower)
    rec["tower_h_m"] = float(m.group(1)) if m else None
    m = re.search(r"Colou?r\s*Scheme\s*[:\-]?\s*([^\n]+)", tower)
    rec["tower_colour"] = re.sub(r"\s{2,}.*$", "", m.group(1)).strip() if m else None

    blk = optic_block(t)
    rec["rpm"] = optic_rpm(blk, t)
    rec["panels"] = optic_panels(blk)
    rec["div_h_cands"] = divergence_candidates(blk)
    m = re.search(r"([0-9][0-9,]{2,})\s*(?:cds?|candela)", flat, re.I)
    rec["intensity_cd"] = int(m.group(1).replace(",", "")) if m else None
    m = re.search(r"(\d{3,4})\s*mm\s*\(?\s*(\d)\s*(?:st|nd|rd|th)?\s*order", flat, re.I) or re.search(r"(\d)\s*(?:st|nd|rd|th)\s*order", flat, re.I)
    rec["optic_order"] = None
    if m:
        rec["optic_order"] = int(m.group(m.lastindex))
    m = re.search(r"Duration\s*of\s*Flash[^0-9\n]*(?:\n[^0-9\n]*)?(\d+(?:\.\d+)?)\s*(?:sec|s\b)", t, re.I)
    rec["flash_s"] = float(m.group(1)) if m and float(m.group(1)) < 5 else None
    m = re.search(r"\bfl\.?\s*(\d+(?:\.\d+)?)\s*(?:sec|s\b|\))", rec["char_raw"] or "", re.I)
    if m and not rec["flash_s"] and float(m.group(1)) < 5:
        rec["flash_s"] = float(m.group(1))
    rec["led"] = bool(re.search(r"\bLED\b", t))
    rec["solar"] = bool(re.search(r"solar", t, re.I))

    # RACON / NAVTEX / VTS come from DGLL's own station lists (build_data.py);
    # the ledger tables print those headings even when the row is NIL.
    m = re.search(r"\bN?\.?A\.?I\.?S\b(.{0,220})", t, re.S)
    ais_blk = re.sub(r"\s+", " ", m.group(1)) if m else ""
    rec["ais"] = bool(m) and not re.match(r"^\s*[:\-]?\s*(?:Base Station\s*)?(NIL|NA|N/A|Not|-)", ais_blk, re.I) \
        and bool(re.search(r"SAAB|Kongsberg|L-?3|Transas|R\s?40|MMSI\s*[:\-]?\s*\d{6,}|Sl\.?\s*No\.?\s*\d", ais_blk, re.I))
    rec["dgps"] = "dgps" in slug or bool(re.search(r"D\.?\s*G\.?\s*P\.?\s*S\s+(?:station|reference|beacon)", t, re.I))
    sol = re.search(r"Solar(.{0,120})", t, re.S | re.I)
    rec["solar"] = bool(sol) and not re.match(r"^\s*[^\n]{0,40}\b(NIL|N/A|Not provided)\b", sol.group(1), re.I) \
        and bool(re.search(r"\d+\s*(?:k?Wp?|watt|W\b|Nos|panel)", sol.group(1), re.I))
    rec["optic"], rec["optic_evidence"] = classify_optic(t)
    # white/red sectored lights: the ledgers name the colours but not the sector bearings
    rec["sectored"] = bool(re.search(r"\bW\s*R\b|white\s*(?:and|&|or)\s*red\s*(?:depending|sector|alternate)|Visibility\s*sector\s*W",
                                     (rec["char_raw"] or "") + " " + t, re.I))
    m = re.search(r"(?:Estd\.?|Established|commissioned)[^\d\n]{0,20}(1[6-9]\d\d|20[0-2]\d)", flat, re.I)
    rec["established"] = int(m.group(1)) if m else None
    return rec


def main():
    regions = json.load(open(os.path.join(RAW, "regions.json")))  # slug -> region
    out = []
    for path in sorted(glob.glob(os.path.join(RAW, "ledger", "*.txt"))):
        slug = os.path.basename(path)[:-4]
        rec = parse_ledger(slug, open(path, errors="ignore").read())
        rec["region"] = regions.get(slug)
        dp = os.path.join(RAW, "detail", slug + ".html")
        if os.path.exists(dp):
            s = open(dp, errors="ignore").read()
            m = re.search(r"<title>([^|<]+)", s)
            rec["dgll_title"] = html.unescape(m.group(1)).strip() if m else slug
            m = re.search(r'href="(/sites/default/files/[^"]+\.pdf)"', s)
            rec["ledger_url"] = "https://www.dgll.nic.in" + m.group(1) if m else None
            imgs = [i for i in re.findall(r'src="(/sites/default/files/(?!styles/)[^"]+\.(?:jpe?g|webp))"', s, re.I)
                    if not re.search(r"dgindia|data\.gov|digital-india|india_gov|Pdf_Icon|logo|youtube|icon|banner", i, re.I)]
            rec["dgll_photo"] = ("https://www.dgll.nic.in" + imgs[0]) if imgs else None
        rec["page_url"] = f"https://www.dgll.nic.in/DGLL-light-house-location/about-{rec['region']}/{slug}" if rec["region"] else None
        out.append(rec)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(out, open(OUT, "w"), indent=1, ensure_ascii=False)

    n = len(out)
    have = lambda k: sum(1 for r in out if r.get(k) not in (None, [], ""))
    print(f"{n} ledgers")
    for k in ["lat", "lon", "alol", "elev_m", "char_raw", "period", "phases", "range_lum_nm", "range_geo_nm",
              "tower_type", "tower_h_m", "tower_colour", "rpm", "intensity_cd", "dgll_photo"]:
        print(f"  {k:14s} {have(k):4d}")
    print("  ais", sum(r["ais"] for r in out), "dgps", sum(r["dgps"] for r in out),
          "solar", sum(r["solar"] for r in out), "flash_s", have("flash_s"))


if __name__ == "__main__":
    main()
