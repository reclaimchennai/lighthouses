"""Plain-language explanations of NHO navigational warnings, for people who are not mariners.

Rule-based on purpose. Every run of the ingest (systemd timer, every 2 h) explains new warnings the same
way, offline, and says nothing that is not in the original text; unusual phrasings fall back to a cleaned
version of the original. The original warning is always kept and shown beside the explanation, and it
is the authority.

    explain(record) -> {"title", "summary", "when": [...], "advice", "icon", "rule"}

Times are converted from UTC to Indian Standard Time (UTC+5:30).
"""
import datetime as dt
import html
import re

MON = {m: i for i, m in enumerate("JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split(), 1)}
MON_NAME = {i: m.title() for m, i in MON.items()}
ACRONYMS = {"IMO", "MMSI", "NAVTEX", "NAVAREA", "RACON", "DGNSS", "DGPS", "AIS", "LNG", "LPG", "MSC", "JSW", "INCOIS",
            "NIOT", "NIO", "NOAA", "ONGC", "RAMA", "ADCP", "SPM", "STS", "OTB", "AECT", "KLL", "APM", "DSF", "IAF",
            "CG", "BNHOC", "NCD", "MBI", "HQODAG", "MIDPL", "WRB", "DDKG", "GHTH", "COSL", "UTC", "IST", "INT", "VSC",
            "NBW", "BD-A", "LT", "II", "III", "IV", "VIII", "XI"}
SMALL = {"of", "and", "the", "to", "in", "at", "on", "by", "for", "from"}
PLACE_WORDS = {"I": "Island", "IS": "Island", "PT": "Point", "HR": "Harbour", "HBR": "Harbour", "R": "River"}
# a position in any of NHO's spellings: 18-17.6N 072-50.8E · 17°34'.34N, 073°04'.58E · 14° 48 ´·76N., 074° 05 ´·67E
COORD = re.compile(r"\(?\s*\d{1,3}\s*[-°]\s*\d{1,2}[\s.'´’`ˊ·ꞏ\d-]*[NS]\b\.?,?\s*\d{1,3}\s*[-°]\s*\d{1,2}[\s.'´’`ˊ·ꞏ\d-]*[EW]\b\.?\s*\)?")


# ------------------------------------------------------------------------------------- words
def name_case(s):
    parts = re.split(r"(\s+|/)", (s or "").strip())
    out = []
    for i, w in enumerate(parts):
        if not w.strip() or w == "/":
            out.append(w)
            continue
        core = w.strip("().,‘’'\"")
        if core in ACRONYMS or re.search(r"\d", core):
            out.append(w)
        elif i and w.lower() in SMALL:
            out.append(w.lower())
        else:
            out.append("-".join(p[:1].upper() + p[1:].lower() for p in w.split("-")))
    return "".join(out).strip()


def sentence(s):
    """Lower-case NHO's capitals into readable sentences, keeping acronyms and names with digits."""
    s = re.sub(r"\s+", " ", s).strip(" .")
    if not s:
        return ""
    words = []
    for w in s.split(" "):
        core = w.strip("().,:;‘’'\"")
        words.append(w if core in ACRONYMS or re.search(r"\d", core) else w.lower())
    out = " ".join(words)
    out = re.sub(r"(^|[.!?]\s+)([a-z])", lambda m: m.group(1) + m.group(2).upper(), out)
    return out + "."


def strip_positions(s):
    s = COORD.sub(" ", s)
    s = re.sub(r"\(\s*\)", "", s)
    s = re.sub(r"\b(IN|AT) (APPROXIMATE )?POSITIONS?\b", "", s)
    return re.sub(r"\s+", " ", s).strip(" ,.")


GENERIC_PLACE = re.compile(r"^(INDIA|INDIAN|WEST COAST|EAST COAST|INDIA WEST COAST|INDIA EAST COAST|NORTHERN (PART|PORTION)|SOUTHERN (PART|PORTION)|"
                           r"BUOYS?|WRECKS?|OIL RIGS|PLATFORM|ADCP MOORINGS|DATA BUOYS.*|JETTY CONSTRUCTION|CABLE LAYING OPERATION|"
                           r"DRILLING OPERATIONS?|PIPELINE .*|.*PROJECT.*|RAMA BUOYS|CONSTRUCTION.*|.*ACTIVITY|UNDERSEA .*|.*OPERATIONS?)$")


def clean_place(place):
    """T&P places read 'India West Coast – Port of Mormugao – Buoys': keep the specific part."""
    p = html.unescape(place or "").upper().replace("\\", "").strip()
    if re.search(r"[–—]| - |-[A-Z]", p):
        parts = [x.strip(" .") for x in re.split(r"\s*[–—]\s*|\s*-\s*(?=[A-Z])", p) if x.strip(" .")]
        parts = [re.sub(r"^(?:NORTHERN|SOUTHERN) (?:PART|PORTION)\s*\((.+)\)$", r"\1", x) for x in parts]
        keep = [x for x in parts if not GENERIC_PLACE.match(x)]
        p = keep[-1] if keep else ""
    return p


def tp_body(msg):
    """T&P notices repeat their number, heading and source before the text and list positions in tables."""
    msg = re.sub(r"^\d{2,3}\s*\([TP]\)\s*(?:\(?\s*\d{1,2}/\d{2}\s*\)?)?\s*", "", msg)
    m = re.search(r"SOURCE\s*:.*?(?:(?<!\d)|(?<=\d{4}))1\s*\.\s*(?=[A-Z(])", msg)      # 'NAVAREA XI.1.', 'BOARD.1.', '20261.'
    if m:
        msg = msg[m.end():]
    msg = re.sub(r"CHARTS AFFECTED.*$", "", msg)
    msg = re.sub(r"STATUS OF .*? (?:IS|ARE) AS FOLLOWS\s*:?\s*-?", " ", msg)
    msg = re.sub(r"\bSL\.?\s*NO\.?\s*(?:BUOY\s+(?:IDENTIFICATION|NO\./NAME)\s+)?(?:NOMENCLATURE\s+)?POSITION(?:\s+(?:STATUS|REMARKS|CHARACTERISTICS))?", " ", msg)
    msg = re.sub(r"\(\d+\.\d+\)|\((?:[A-H]|I{1,3}|IV|VI{0,3})\)(?=\s*[A-Z\d])", " . ", msg)      # table rows become clauses
    return re.sub(r"\s+", " ", msg).strip(" .-:")


def place_phrase(place, area=None):
    p = re.sub(r"\s+", " ", (place or "").upper()).strip(" .")
    if not re.search(r"[A-Z]", p) or len(p) > 60:          # '-' or a whole message filed as the place
        p = ""
    if not p:
        return f"in the {area}" if area else ""
    p = " ".join(PLACE_WORDS.get(w, w) for w in p.split())
    m = re.match(r"^OFF (.+?) TO (.+)$", p)
    if m:
        return f"off the coast between {name_case(m.group(1))} and {name_case(m.group(2))}"
    if p.startswith("OFF "):
        return "off " + name_case(p[4:])
    m = re.match(r"^APPROACH(?:ES)? TO (.+)$", p)
    if m:
        return f"in the approaches to {name_case(m.group(1))}"
    m = re.match(r"^(.+?) TO (.+)$", p)
    if m:
        return f"between {name_case(m.group(1))} and {name_case(m.group(2))}"
    if re.match(r"^(GULF|BAY)\b", p) or re.search(r"\b(OCEAN|SEA)$", p):
        return "in the " + name_case(p)
    if re.search(r"HARBOUR|PORT|CHANNEL|CREEK|RIVER|ANCHORAGE", p):
        return "in " + name_case(p)
    return "near " + name_case(p)


def nm_text(n):
    n = float(n)
    km = n * 1.852
    return f"{n:g} nautical mile{'s' if n != 1 else ''} ({km:.1f} km)" if km < 10 else f"{n:g} nautical miles ({km:.0f} km)"


# --------------------------------------------------------------------------------- time
def clock_ist(hhmm):
    h, m = int(hhmm[:2]), int(hhmm[2:])
    t = h * 60 + m + 330
    next_day = t >= 1440
    t %= 1440
    hh, mm = divmod(t, 60)
    return f"{hh % 12 or 12}:{mm:02d} {'am' if hh < 12 else 'pm'}", next_day


def year4(y):
    y = int(y)
    return y + 2000 if y < 100 else y


def days_text(seg):
    """'14 TO 17 SEP 26' · '04, 11, 18 AND 25 SEP 26' · '21 AUG TO 02 OCT 26' · '18 SEP 26' -> readable."""
    m = re.search(r"\b(\d{1,2}) ([A-Z]{3})\s*(\d{2,4}) TO (\d{1,2}) ([A-Z]{3})\s*(\d{2,4})\b", seg)
    if m and m.group(2) in MON and m.group(5) in MON:
        return (f"{int(m.group(1))} {MON_NAME[MON[m.group(2)]]} {year4(m.group(3))} to "
                f"{int(m.group(4))} {MON_NAME[MON[m.group(5)]]} {year4(m.group(6))}")
    m = re.search(r"\b(\d{1,2}) ([A-Z]{3}) TO (\d{1,2}) ([A-Z]{3}) (\d{2,4})\b", seg)
    if m and m.group(2) in MON and m.group(4) in MON:
        return f"{int(m.group(1))} {MON_NAME[MON[m.group(2)]]} to {int(m.group(3))} {MON_NAME[MON[m.group(4)]]} {year4(m.group(5))}"
    m = re.search(r"\b(\d{1,2}) TO (\d{1,2}) ([A-Z]{3}) (\d{2,4})\b", seg)
    if m and m.group(3) in MON:
        return f"{int(m.group(1))} to {int(m.group(2))} {MON_NAME[MON[m.group(3)]]} {year4(m.group(4))}"
    groups = re.findall(r"((?:\d{1,2}\s*,\s*)*\d{1,2}(?:\s+AND\s+\d{1,2})?)\s+([A-Z]{3})\b(?:\s+(\d{2,4})\b)?", seg)
    parts, year = [], None
    for days, mon, yr in groups:
        if mon not in MON:
            continue
        ds = [str(int(d)) for d in re.findall(r"\d{1,2}", days)]
        txt = ds[0] if len(ds) == 1 else ", ".join(ds[:-1]) + " and " + ds[-1]
        parts.append(f"{txt} {MON_NAME[MON[mon]]}")
        year = yr or year
    if parts:
        return "; ".join(parts) + (f" {year4(year)}" if year else "")
    return None


def when_lines(msg):
    body = re.sub(r"\b\d\s*\.?\s*CANCEL (THIS|NAVAREA|INW).*$", "", msg)
    lines = []
    # absolute windows: 061831 TO 121829 UTC ... SEP 26
    month_year = r"\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+(\d{2,4})\b"
    for m6 in re.finditer(r"\b(\d{6})\s*TO\s*(\d{6})\s*UTC", body):
        a, b = m6.group(1), m6.group(2)
        mm = re.search(month_year, body[m6.end():]) or re.search(month_year, body)
        if not mm:
            continue
        mon, yr = MON[mm.group(1)], year4(mm.group(2))
        try:
            t0 = dt.datetime(yr, mon, int(a[:2]), int(a[2:4]), int(a[4:])) + dt.timedelta(hours=5, minutes=30)
            t1 = dt.datetime(yr, mon, int(b[:2]), int(b[2:4]), int(b[4:])) + dt.timedelta(hours=5, minutes=30)
        except ValueError:
            continue
        f = lambda t: f"{t.day} {MON_NAME[t.month]}, {t.hour % 12 or 12}:{t.minute:02d} {'am' if t.hour < 12 else 'pm'}"
        lines.append(f"From {f(t0)} to {f(t1)} IST")
    if lines:
        return lines
    sched = re.search(r"(SCHEDULED|PREDICTED|FROM|TILL|UNTIL|ON)\b(.*?)(\bIN (DANGER|AREA|THE AREA|VICINITY|FOLLOWING)|\bAT FOLLOWING|\bALONG|\bIN \d|\(\.\)|$)", body)
    seg = sched.group(2) if sched else body
    chunks = [c for c in re.split(r"\([A-Z]\)", seg) if re.search(r"\d", c)] or [seg]
    for c in chunks:
        till = re.search(r"\b(?:TILL|UNTIL)\s+(\d{1,2})\s+([A-Z]{3})\s+(\d{2,4})", body)
        days = days_text(c)
        times = []
        for a, b in re.findall(r"\b(\d{4})\s*TO\s*(\d{4})\s*UTC", c):
            (ta, na), (tb, nb) = clock_ist(a), clock_ist(b)
            times.append(f"{ta} to {tb}{' (next day)' if nb and not na else ''}")
        extra = []
        if "DAILY" in c:
            extra.append("every day")
        m = re.search(r"EXCLUDING ([A-Z ,]+?)\)", c)
        if m:
            extra.append("except " + re.sub(r"\b(and)\b", "and", m.group(1).title()).replace(" And ", " and "))
        if days or times:
            line = days or ""
            if times:
                line += (", " if line else "") + " and ".join(times) + " IST"
            if extra:
                line += ", " + ", ".join(extra)
            lines.append(line[:1].upper() + line[1:])
        elif till and till.group(2) in MON:
            lines.append(f"Until {int(till.group(1))} {MON_NAME[MON[till.group(2)]]} {year4(till.group(3))}")
    return [l for l in lines if l][:6]


def advice_from(msg):
    m = re.search(r"(?:BERTH OF|CLEARANCE OF)\s*0?(\d+(?:\.\d+)?)\s*(NM|N\b|NAUTICAL MILES?|METERS|METRES|M\b)", msg) \
        or re.search(r"\b0?(\d+(?:\.\d+)?)\s*(NM|NAUTICAL MILES?)\s*BERTH", msg)
    if m:
        n, unit = m.group(1), m.group(2)
        dist = nm_text(n) if unit.startswith("N") else f"{float(n):g} m"
        return f"Keep at least {dist} away."
    if re.search(r"WIDE BERTH|KEEP WELL CLEAR", msg):
        return "Keep well clear."
    if re.search(r"EXERCISE CAUTION|NAVIGATE WITH CAUTION", msg):
        return "Take extra care in this area" + (", and check with the port authority for the latest." if "PORT AUTHORITY" in msg else ".")
    return None


# -------------------------------------------------------------------------------- vessels
VESSEL = [("IFB", "fishing boat"), ("FISHING TRAWLER", "fishing trawler"), ("FISHING BOAT", "fishing boat"), ("FV", "fishing vessel"),
          ("MV", "ship"), ("MSV", "sailing cargo vessel"), ("TUG", "tug"), ("C/S", "cable ship"), ("CS", "cable ship"),
          ("DSV", "diving support vessel"), ("AWB", "work barge"), ("AHT", "anchor-handling tug"), ("LAY VESSEL", "lay vessel"),
          ("BARGES", "barges"), ("BARGE", "barge"), ("VESSEL", "vessel")]


def vessel(subject):
    s = re.sub(r"\(IMO \d+\)|\bIMO \d+|,\s*[A-Z0-9]{4,},?\s*\d{7}", "", subject or "").strip(" .,(")
    s = re.sub(r"^(TWO|THREE|A|AN|THE)\s+", "", s)
    for p, label in VESSEL:
        if s == p:
            return f"a {label}", label
        if s.startswith(p + " "):
            return f"the {label} {name_case(s[len(p) + 1:])}", label
    return (f"the vessel {name_case(s)}", "vessel") if s else ("a vessel", "vessel")


def cap(s):
    return s[:1].upper() + s[1:] if s else s


# ---------------------------------------------------------------------------------- rules
def explain(rec):
    raw = (rec.get("message") or ("" if len(rec.get("place") or "") < 60 else rec["place"])).upper()
    msg = re.sub(r"\s+", " ", html.unescape(raw).replace("’", "'").replace("‘", "'")).strip()
    msg = re.sub(r"^[\s⁠-⁯]+", "", msg)
    if rec.get("kind") == "T&P":
        msg = tp_body(msg)
    msg = re.sub(r"^1\s*\.\s*", "", msg)
    place = place_phrase(clean_place(rec.get("place")), rec.get("area"))
    where = f" {place}" if place else ""
    when = when_lines(msg)
    advice = advice_from(msg)
    out = None

    def done(rule, icon, title, summary, default_advice=None):
        return {"rule": rule, "icon": icon, "title": title, "summary": summary, "when": when,
                "advice": advice or default_advice}

    replaced = re.search(r"CANCEL (NAVAREA VIII|INW|NAVTEX)?\s*(?:MSG\s*)?(\d{1,4}/\d{2})", msg)
    tail = f" This replaces earlier warning {replaced.group(2)}." if replaced else ""

    if "IN FORCE AS ON" in msg:
        m = re.search(r"IN FORCE AS ON (\d{1,2} [A-Z]{3} \d{2,4})", msg)
        out = done("in_force_list", "list", "List of warnings still in force",
                   f"NHO's regular list of the warnings still in force{' on ' + days_text(m.group(1)) if m else ''}. It repeats earlier warnings and adds nothing new.")
        out["when"] = []
    # work that happens to be marked by buoys is about the work, not the buoys
    elif "STS OPERATION" in msg:
        out = done("sts", "ship", "Ship-to-ship transfer", f"Ships are moving cargo from one ship to another at this anchorage{where}.{tail}", "Keep clear of the ships.")
    elif "DREDGING" in msg:
        out = done("dredging", "construction", f"Dredging{where}", f"Dredging (digging out the seabed to deepen a channel) is going on in the marked area{where}.{tail}",
                   "Keep clear of the dredgers.")
    elif re.search(r"CONSTRUCTION|JETTY|BRIDGE|BREAK ?WATER|PLATFORM WORK", msg) and not re.search(r"MISSING|UNLIT|SUNK", msg):
        what = next((t for k, t in (("BRIDGE", "a bridge"), ("JETTY", "a jetty"), ("BERTH", "a new berth"), ("PLATFORM", "an offshore platform"),
                                    ("BREAK", "a breakwater repair")) if k in msg), "construction")
        work = "Construction work" if what == "construction" else f"Construction of {what}"
        if "FISHING HARBOUR" in msg:
            work = "A new fishing harbour"
        out = done("construction", "construction", f"Construction at sea{where}",
                   f"{work} {'is being built' if work.startswith('A new') else 'is going on'} in the marked area{where}.{tail}",
                   "Take extra care and keep clear of the works.")
    elif re.match(r"^INSERT\b", strip_positions(msg)) and "WRECK" not in msg:
        out = done("chart_insert", "notice", f"Chart correction{where}",
                   f"Something new is being added to nautical charts at this position. The original notice gives the details.{tail}")
    elif re.search(r"\b(DGNSS|DGPS)\b", msg) and re.search(r"OFF AIR|INOPERATIVE|NOT (OPERATIONAL|FUNCTIONAL|WORKING)", msg):
        m = re.search(r"FROM ([A-Z .']+?) LT\b", msg) or re.search(r"^([A-Z .']+?)\s+(?:DGNSS|DGPS)", strip_positions(msg))
        nm = name_case(m.group(1)) if m and m.group(1).strip() not in ("DGNSS", "DGPS") else None
        maint = " for maintenance" if "MAINTENANCE" in msg else ""
        out = done("dgnss_off", "dgnss-off", f"Position correction station off air{': ' + nm if nm else ''}",
                   f"The DGNSS station{' at ' + nm if nm else where} is off the air{maint}. It broadcasts corrections that make ships' GPS positions more accurate, so positions in this area may be less precise.{tail}",
                   "Check your position by other means too.")
    elif "NEW RACON" in msg or re.search(r"RACON\b.{0,60}\b(INSTALLED|ESTABLISHED)", msg):
        code = re.search(r"CODE\s*'?([A-Z])'?", msg)
        nm = re.search(r"'?\s*([A-Z .']+?) LT\b", re.sub(r"NEW RACON CODE\s*'?[A-Z]'?", "", msg))
        out = done("racon_new", "racon", f"New radar beacon on trial{': ' + name_case(nm.group(1)) if nm else ''}",
                   f"A new radar beacon (RACON){' with the Morse letter ' + code.group(1) if code else ''} is being tried out{' at ' + name_case(nm.group(1)) + ' lighthouse' if nm else where}. A RACON makes the spot stand out on ships' radar screens.{tail}")
    elif re.search(r"\bRACON\b", msg) and re.search(r"INOPERATIVE|NOT (OPERATIONAL|FUNCTIONAL|WORKING)|OFF AIR", msg):
        plain = strip_positions(msg)
        names = []
        for a, b in re.findall(r"(?:RACON\s+'?[A-Z]?'?\s+AT\s+([A-Z .']+?)\s+LT)|(?:([A-Z][A-Z .']*?)\s+(?:LT\s+)?RACON)", plain):
            n = (a or b).strip(" ,")
            if n and n not in ("NEW", "THE"):
                names.append(name_case(re.sub(r"\bLT$", "", n).strip()))
        names = list(dict.fromkeys(names))
        who = " and ".join(names) if names else None
        band = " in the X and S radar bands" if "X AND S BAND" in msg else ""
        out = done("racon_off", "racon-off", f"Radar beacon not working{': ' + who if who else ''}",
                   f"The radar beacon (RACON){' at ' + who if who else where} is not working{band}. It normally marks this landmark on ships' radar screens with its Morse letter; until it is repaired it will not show.{tail}",
                   "Identify this landmark on radar by other means.")
    elif "CHARACTERISTICS OF LT" in msg:
        fl = re.search(r"FL\((\d)\)\s*0?(\d+(?:\.\d+)?)S", msg)
        rng = re.search(r"RANGE (\d+)\s*NM", msg)
        pattern = f"{fl.group(1)} flashes every {fl.group(2)} seconds" if fl else "a new pattern"
        out = done("light_changed", "light", "A light's flashing pattern has changed",
                   f"The trial light at this position now flashes {pattern}{', visible up to ' + nm_text(rng.group(1)) if rng else ''}.{tail}")
    elif re.search(r"\bLT\b|\bLIGHTS\b", msg) and re.search(r"UNLIT|INOPERATIVE|EXTINGUISHED|NOT (WORKING|FUNCTIONAL|OPERATIONAL)", msg) and "BUOY" not in msg:
        plain = strip_positions(msg)
        if "DOLPHIN LIGHTS" in plain:
            out = done("lights_off", "light-off", "Mooring lights not working",
                       f"The lights on the mooring structures (navigational dolphins){where} are not working, so they will not be visible at night.{tail}",
                       "Take extra care near here at night.")
        else:
            m = re.search(r"^([A-Z .']+?)\s+LT\b", plain)
            nm = name_case(m.group(1)) if m else None
            out = done("light_off", "light-off", f"Light not working{': ' + nm if nm else ''}",
                       f"The light{' at ' + nm if nm else where} is not lit. Ships will not see it at night until it is repaired.{tail}",
                       "Take extra care navigating near here at night.")
    elif re.search(r"WAVE RIDER|DATA BUOY|TSUNAMI|LIDAR|\bRAMA\b|ADCP|OBSERVATORY|TURBIDITY|METEOROLOGICAL", msg):
        kinds = [k for k, pat in (("wave recorders", r"WAVE RIDER|\bWRB\b"), ("data buoys", r"DATA BUOY"), ("tsunami warning buoys", r"TSUNAMI"),
                                  ("LIDAR weather buoys", r"LIDAR"), ("monsoon research buoys", r"\bRAMA\b"), ("underwater current meters", r"ADCP"),
                                  ("coastal observatory buoys", r"OBSERVATORY"), ("water-quality buoys", r"TURBIDITY")) if re.search(pat, msg)]
        org = re.search(r"\b(INCOIS|NIOT|NIO|NOAA)\b", msg)
        out = done("science_buoys", "buoy", f"Scientific instruments at sea{where}",
                   f"{cap(' and '.join(kinds) or 'Research buoys')} {'have' if kinds else 'have'} been placed at sea{' by ' + org.group(1) if org else ''} to measure the ocean and weather. Their positions are on the map.{tail}",
                   "Keep clear of them.")
    elif "BUOY" in msg:
        out = explain_buoys(msg, where, when, advice, tail)
    elif re.search(r"\bSUNK\b|SHIPWRECK|\bWRECK\b", msg):
        if "INSERT" in msg or re.match(r"^WRECK\b", strip_positions(msg)):
            out = done("wreck_charted", "wreck", f"Wreck added to charts{where}", "A wreck is being added to nautical charts at this position.", "Take extra care near this position.")
        else:
            m = re.search(r"^(.*?)\s+(?:UNMANNED AND\s+)?REPORTED", strip_positions(msg))
            subj = (m.group(1) if m else "").strip()
            if "SHIPWRECK" in subj or not subj:
                who, label = "a ship", "ship"
            else:
                who, label = vessel(subj)
            fire = " after a fire on board" if "FIRE" in msg else ""
            extra = []
            if "CREW RESCUED" in msg:
                extra.append("The crew were rescued.")
            if "CONTAINERS" in msg and "ADRIFT" in msg:
                extra.append("Containers from it are drifting in the area.")
            if "POLLUTION" in msg:
                extra.append("Salvage and pollution response work is going on.")
            if "SUBMERGED" in msg:
                extra.append("It is fully under water.")
            out = done("sunk", "wreck", f"Sunken {label}{where}",
                       f"{cap(who)} has sunk{fire} at about this position. The wreck can be a danger to other boats. {' '.join(extra)}{tail}".replace("  ", " ").strip(),
                       "Take extra care near this position.")
    elif "AGROUND" in msg:
        m = re.search(r"^(.*?)\s+(?:UNMANNED AND\s+)?REPORTED", strip_positions(msg))
        who, label = vessel(m.group(1) if m else "")
        nobody = ", with no one on board" if "UNMANNED" in msg else ""
        out = done("aground", "aground", f"{cap(label)} aground{where}",
                   f"{cap(who)} has run aground here{nobody}.{' The crew were rescued.' if 'CREW RESCUED' in msg else ''}{tail}",
                   "Take extra care near this position.")
    elif "LOSS OF ANCHOR" in msg:
        m = re.search(r"^(.*?)\s+REPORTED", msg)
        sh = re.search(r"(\d+) SHACKLES", msg)
        who, _ = vessel(m.group(1) if m else "")
        out = done("anchor_lost", "anchor", "Lost anchor on the seabed",
                   f"{cap(who)} lost its anchor{' and ' + str(int(sh.group(1))) + ' lengths of chain' if sh else ''} on the seabed here.{tail}",
                   "Take extra care if anchoring nearby.")
    elif "LESSER DEPTH" in msg:
        d = re.search(r"ABOUT\s+(\d+(?:\.\d+)?)\s*M\b", msg)
        out = done("shallow", "shallow", f"Shallower water than charted{where}",
                   f"The water{' in the channel' if 'CHANNEL' in msg else ''} is shallower than the charts show{': about ' + d.group(1) + ' m deep' if d else ''}.{tail}",
                   "Take extra care: allow for less depth under the keel.")
    elif "FLIGHT TRIAL" in msg:
        out = done("flight_trials", "rocket", f"Test flights{where}",
                   f"Experimental flight trials are scheduled over a danger area{where}. The area is shown on the map.{tail}",
                   "Stay out of the danger area at these times.")
    elif "SPACE DEBRIS" in msg:
        out = done("space_debris", "debris", "Falling space debris expected",
                   f"Space debris (pieces of a rocket or spacecraft) is expected to fall into the sea in the marked area.{tail}",
                   "Stay out of the area at these times.")
    elif "AIR DROP" in msg:
        out = done("air_drop", "airdrop", f"Air drop tests{where}",
                   f"Air drop tests (objects dropped from aircraft) are planned in the marked area{where}.{tail}",
                   "Stay out of the area at these times.")
    elif re.search(r"\bFIRING\b|AIR DEFENCE", msg):
        actors = [("CG AIRCRAFT", "Coast Guard aircraft"), ("IAF", "The Indian Air Force"), ("BANGLADESH NAVY", "The Bangladesh Navy"),
                  ("ARMY AIR DEFENCE", "Army air-defence units"), ("SURFACE AND SUBSURFACE", "Ships and submarines"),
                  ("SUBSURFACE", "Submarines"), ("AIRCRAFT", "Aircraft")]
        actor = next((a for k, a in actors if k in msg), None)
        practice = "practice" if "PRACTICE" in msg else "exercise"
        areas = len(re.findall(r"\([A-Z]\)\s*\d", msg))
        area_txt = f"{areas} danger areas" if "DANGER AREAS" in msg and areas > 1 else "a danger area"
        out = done("firing", "firing", f"Live firing {practice}{where}",
                   f"{actor + ' will fire' if actor else 'Live weapons will be fired'} in {area_txt}{where}, shown hatched on the map.{tail}",
                   "Stay out of the danger area at these times.")
    elif "RIG MOVE" in msg:
        m = re.search(r"RIG MOVE\s*(?:\(\.\))?\s*([A-Z0-9 -]+?)\s*(?:\(|\d{2}-|$)", msg)
        out = done("rig_move", "rig", "Oil rig being moved", f"The drilling rig {name_case(m.group(1)) if m else ''} is being moved to this position.{tail}".replace("rig  is", "rig is"),
                   "Keep clear of the rig and its tugs.")
    elif "OIL RIGS" in msg:
        out = done("rig_list", "rig", "Oil rigs at sea", f"A list of the oil rigs working {place or 'at sea'}, with their positions on the map.{tail}", "Keep clear of the rigs.")
    elif re.search(r"\bDRILLING\b", msg):
        m = re.search(r"^(.*?)\s+(?:WILL CARRY OUT|PROGRESSING|CARRYING OUT)", strip_positions(msg)) or re.search(r"CONDUCTED BY [A-Z -]*?RIG,\s*([A-Z0-9 -]+?)\s+(?:TILL|UNTIL|FROM)", msg)
        who = vessel(m.group(1))[0] if m and m.group(1).strip() and not m.group(1).startswith("DRILLING") else "a drilling rig"
        out = done("drilling", "rig", f"Offshore drilling{where}",
                   f"{cap(who)} is drilling into the seabed{where}.{tail}", "Keep clear of the drilling area.")
    elif re.search(r"\bCABLE\b", msg):
        action = "repairing" if "REPAIR" in msg else "recovering" if "RECOVERY" in msg else "maintaining" if "MAINTENANCE" in msg else "laying"
        m = re.search(r"^(.*?)\s+(?:WILL CARRY OUT|CARRYING OUT|PROGRESSING)", re.sub(r"^CHARTS IN [\d ]+(INT \d+)?\s*\(\.\)\s*", "", msg))
        byv = re.search(r"BY THE VESSEL\s+([A-Z0-9 -]+?)(?:\s+ALONG|\s+FROM|\.|$)", msg)
        who = vessel(m.group(1))[0] if m else (vessel("VESSEL " + byv.group(1))[0] if byv else "A ship")
        out = done("cable", "cable", f"Undersea cable work{where}",
                   f"{cap(who)} is {action} an undersea {'telecommunication ' if 'TELECOM' in msg else ''}cable{where}. Its route is on the map.{tail}",
                   "Keep well clear of the cable ship: it cannot move out of the way easily.")
    elif "PIPELINE" in msg:
        m = re.search(r"^(.*?)\s+(?:WILL CARRY OUT|PROGRESSING|CARRYING OUT)", strip_positions(msg))
        who = name_case(re.sub(r"\bAND\b", "and", m.group(1))) if m else "Work vessels"
        what = "surveying a pipeline route" if "SURVEY" in msg else "working on an undersea pipeline"
        plural = who == "Work vessels" or " and " in who.lower() or "," in who
        out = done("pipeline", "pipeline", f"Pipeline work{where}", f"{cap(who)} {'are' if plural else 'is'} {what}{where}.{tail}",
                   "Keep clear of the work vessels.")
    elif re.search(r"\bSURVEY\b", msg):
        m = re.search(r"^(.*?)\s+(?:WILL CARRY OUT|PROGRESSING|CARRYING OUT)", strip_positions(msg))
        who = vessel(m.group(1))[0] if m else "A survey ship"
        what = "mapping the seabed" if "SEABED" in msg else "surveying a route" if "ROUTE SURVEY" in msg else "carrying out a survey"
        out = done("survey", "survey", f"Survey ship at work{where}",
                   f"{cap(who)} is {what}{where}. It may tow equipment behind it and cannot turn quickly.{tail}",
                   "Keep clear of the survey ship.")
    elif "SALVAGE" in msg:
        m = re.search(r"SALVAGE OPERATION OF ([A-Z0-9 ]+?) WILL", msg)
        out = done("salvage", "wreck", f"Salvage work{where}",
                   f"Salvage work{' on ' + vessel(m.group(1))[0] if m else ''} is going on in the marked area{where}.{tail}", "Keep well clear.")
    elif "DREDGING" in msg:
        out = done("dredging", "construction", f"Dredging{where}", f"Dredging (digging out the seabed to deepen a channel) is going on in the marked area{where}.{tail}",
                   "Keep clear of the dredgers.")
    elif re.search(r"CONSTRUCTION|JETTY|BERTH\b|BRIDGE|PLATFORM|BREAK ?WATER", msg):
        what = next((t for k, t in (("BRIDGE", "a bridge"), ("JETTY", "a jetty"), ("BERTH", "a new berth"), ("PLATFORM", "an offshore platform"),
                                    ("BREAK", "a breakwater repair")) if k in msg), "construction")
        out = done("construction", "construction", f"Construction at sea{where}", f"Construction of {what} is going on in the marked area{where}.{tail}",
                   "Take extra care and keep clear of the works.")
    elif "STS OPERATION" in msg:
        out = done("sts", "ship", "Ship-to-ship transfer", f"Ships are moving cargo from one ship to another at this anchorage{where}.{tail}", "Keep clear of the ships.")
    elif re.search(r"ANCHOR HANDLING|TOWING SUPPLY|SUPPORT ACTIVITY", msg):
        m = re.search(r"^(.*?)\s+CARRYING OUT", strip_positions(msg))
        out = done("support", "ship", f"Offshore support vessel at work{where}",
                   f"{cap(vessel(m.group(1))[0]) if m else 'An offshore support vessel'} is handling anchors, towing and supplying offshore work here.{tail}", "Keep clear.")
    if out is None:
        cat = rec.get("category") or "misc"
        titles = {"firing": "Danger area", "operations": "Work at sea", "danger": "Hazard at sea", "aton": "Change to a navigation mark",
                  "notice": "Notice to mariners", "misc": "Navigational warning"}
        text = strip_positions(re.sub(r"^\d{3} \([TP]\) \(\d{2}/\d{2}\)\s*", "", msg))
        text = re.sub(r"SOURCE:.*?(?=\d\.|$)", " ", text)
        text = re.sub(r"CHARTS AFFECTED.*$", "", text)
        icons = {"firing": "firing", "operations": "ship", "danger": "misc", "aton": "buoy", "notice": "notice", "misc": "misc"}
        text = text if re.search(r"[A-Z]{3}", text) else strip_positions(html.unescape(raw))   # cleaning left nothing: use the original
        out = done("fallback", icons.get(cat, "misc"), f"{titles.get(cat, 'Navigational warning')}{where}", sentence(text[:420]) + tail)
    if rec.get("cancel_at"):
        try:
            t = dt.datetime.strptime(rec["cancel_at"], "%Y-%m-%dT%H:%M:%SZ") + dt.timedelta(hours=5, minutes=30)
            out["when"] = out["when"] + [f"Warning ends {t.day} {MON_NAME[t.month]} {t.year}, {t.hour % 12 or 12}:{t.minute:02d} {'am' if t.hour < 12 else 'pm'} IST"]
        except ValueError:
            pass
    out["summary"] = re.sub(r"\s+", " ", out["summary"]).replace(" .", ".").strip()
    return out


BUOY_STATUS = [
    (r"REPORTED MISSING|MISSING", "is missing from its charted position", "are missing from their charted positions", "buoy-missing", "missing"),
    (r"SUBMERGED", "is under water", "are under water", "buoy-missing", "under water"),
    (r"OFF AIR", "is off the air", "are off the air", "buoy-missing", "off air"),
    (r"REPORTED UNLIT|UNLIT", "is not lit at night", "are not lit at night", "buoy", "not lit"),
    (r"RETRIEVED FOR MAINTENANCE|RECOVERED FOR REPAIRS?|WITHDRAWN TEMPORARILY|TEMPORARILY REMOVED|REMOVED",
     "has been taken away for maintenance", "have been taken away for maintenance", "buoy-missing", "removed"),
    (r"SHIFTED TO NEW POSITION|DRIFTED TO NEW POSITION|SHIFTED|DRIFTED", "has moved to a new position", "have moved to new positions", "buoy", "moved"),
    (r"MOORED|DEPLOYED|LAID|INSERTED|ESTABLISHED", "has been placed", "have been placed", "buoy", "placed"),
]


BUOY_WORDS = {"BUOY", "BUOYS", "AND", "NO", "NO.", "NUMBER", "OF", "HAND", "MARKING", "CHANNEL", "FAIRWAY", "SURFACE", "CARDINAL", "NORTH",
              "SOUTH", "EAST", "WEST", "STBD", "PORT", "STARBOARD", "TRANSIT", "YELLOW", "TEMPORARY", "NAVIGATIONAL", "SINGLE",
              "POINT", "MOORING", "COLOR", "COLOUR", "COLOURED", "RED", "GREEN"}


def buoy_label(subj):
    """'CHANNEL MARKING BUOY PAGA' -> 'The channel-marking buoy Paga'; 'SURFACE BUOY' -> 'A surface buoy'."""
    s = re.sub(r"\bCHANEL\b", "CHANNEL", subj)
    s = re.sub(r"(\s*,)+\s*", " ", s)                                     # commas left where positions were cut out
    s = re.sub(r"\b(AND\s+)+AND\b", "AND", s).strip()
    plural = bool(re.search(r"BUOYS\b|\bAND\b", s))
    s = re.sub(r"\((\d+)\)|\b(HAVE|HAS) BEEN\b|\bWILL REMAIN\b", " ", s).strip()
    s = re.sub(r"\bNO\.(\d)", r"NO. \1", s)
    if len(s.split()) > 7 or re.search(r"SOURCE|\([TP]\)|UNDER PROGRESS", s):             # a garbled table row: stay generic
        return ("The buoys" if re.search(r"BUOYS\b", s) else "The buoy"), bool(re.search(r"BUOYS\b", s))
    words = [{"STBD": "starboard", "NO": "no.", "NO.": "no.", "NUMBER": "no."}.get(w, w.lower()) if w in BUOY_WORDS else name_case(w) for w in s.split()]
    label = " ".join(words).replace("channel marking", "channel-marking") or "buoy"
    if label in ("buoy", "buoys"):
        return ("A buoy" if label == "buoy" else "Buoys"), label == "buoys"
    if label.startswith("buoy") or plural:
        return cap(label), plural
    if any(w[:1].isupper() or re.search(r"\d", w) for w in label.split()):
        return "The " + label, plural
    return "A " + label, plural


def explain_buoys(msg, where, when, advice, tail):
    sentences, icon, states, plurals = [], "buoy", [], []
    for c in re.split(r"\(\.\)|\s\.\s|(?<=[A-Z)])\.\s+", msg):
        c = strip_positions(c)
        if "BUOY" not in c:
            if "VIRTUAL" in c:
                sentences.append("A virtual buoy is broadcast on AIS (ships' radio tracking) in its place until it is back.")
            continue
        # 'KACHCHH BUOY MISSING AND TILBURN BUOY UNLIT' is two statements; 'BUOYS … AND FAIRWAY BUOY MISSING' is one
        pending = ""
        for seg in re.split(r"\s+AND\s+(?=(?:[A-Z.]+\s+)*BUOYS?\b)", c):
            seg = (pending + " AND " + seg).strip() if pending else seg
            found = None
            for pat, one, many, ic, state in BUOY_STATUS:
                m = re.search(rf"\b({pat})\b", seg)
                if m:
                    found = (m, one, many, ic, state)
                    break
            if not found:
                pending = seg
                continue
            pending = ""
            m, one, many, ic, state = found
            subj = seg[:m.start()]
            if "VIRTUAL" in subj:
                sentences.append("A virtual buoy is broadcast on AIS (ships' radio tracking) in its place.")
                continue
            subj = re.sub(r"\b(REPORTED|IN POSITION|AT POSITION|AT|IN|STATUS OF|FOLLOWING|ARE|IS|TEMPORARILY)\b", " ", subj)
            subj = re.sub(r"\s+", " ", subj).strip(" ,:-")
            label, plural = buoy_label(subj)
            sentences.append(f"{label} {many if plural else one}.")
            if ic == "buoy-missing":
                icon = ic
            states.append(state)
            plurals.append(plural)
    if len(states) >= 3:                                  # a status table: count by status instead of row-by-row sentences
        verbs = {"missing": ("is missing", "are missing"), "under water": ("is under water", "are under water"),
                 "off air": ("is off the air", "are off the air"), "not lit": ("is not lit", "are not lit"),
                 "removed": ("has been removed for maintenance", "have been removed for maintenance"),
                 "moved": ("has moved", "have moved"), "placed": ("has been placed", "have been placed")}
        counts = {}
        for s in states:
            counts[s] = counts.get(s, 0) + 1
        parts = [f"{n} {verbs[s][0 if n == 1 else 1]}" for s, n in sorted(counts.items(), key=lambda kv: -kv[1])]
        virtual = [s for s in sentences if s.startswith("A virtual")]
        sentences = [f"{len(states)} buoys have changed: " + "; ".join(parts) + ". Each one is listed in the original notice."] + virtual[:1]
    if not sentences:
        sentences.append(sentence(strip_positions(msg)[:300]))
    many = len(states) > 1 or any(plurals)
    head = {"missing": "Buoy missing", "under water": "Buoy under water", "not lit": "Buoy not lit", "removed": "Buoy removed for maintenance",
            "moved": "Buoy moved", "placed": "New buoy placed", "off air": "Buoy off the air"}
    head_many = {"missing": "Buoys missing", "under water": "Buoys under water", "not lit": "Buoys not lit", "removed": "Buoys removed for maintenance",
                 "moved": "Buoys moved", "placed": "New buoys placed", "off air": "Buoys off the air"}
    title = (head_many if many else head).get(states[0], "Buoy change") if states else "Buoy change"
    if len(set(states)) > 1:
        title = "Buoys changed"
    default = "Do not rely on this buoy; take extra care in the channel." if any(s in ("missing", "under water", "removed", "not lit", "moved") for s in states) else "Keep clear of the buoys."
    return {"rule": "buoys", "icon": icon, "title": f"{title}{where}", "summary": " ".join(dict.fromkeys(sentences)) + tail,
            "when": when, "advice": advice or default}
