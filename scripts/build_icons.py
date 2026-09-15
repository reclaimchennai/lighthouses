#!/usr/bin/env python3
"""
Build web/icons.svg: one pixel-art SVG sprite from pixelarticons (MIT, Gerrit Halfmann,
https://pixelarticons.com), 24 px grid, filled with currentColor. A few icons the set lacks
(lighthouse, record) are drawn here on the same grid.

Usage: scripts/build_icons.py
In HTML/JS: <svg class="i"><use href="icons.svg?v=N#lighthouse"/></svg>
"""
import os
import re
import urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(HERE, "raw", "icons", "pixelarticons")
OUT = os.path.join(HERE, "web", "icons.svg")
CDN = "https://cdn.jsdelivr.net/npm/pixelarticons@2.4.1/svg/{}.svg"

# sprite id -> pixelarticons name
ICONS = {
    "navtex": "signal", "racon": "target", "ais": "ship", "dgnss": "gps", "vts": "monitor", "solar": "sun",
    "museum": "university", "access": "door-closed", "camera": "camera", "stop": "stop-solid", "play": "play",
    "pause": "pause", "history": "hourglass", "layers": "layout", "search": "search", "compass": "compass",
    "tag": "label", "cube": "box", "places": "map", "info": "info-box", "alert": "warning-diamond", "doc": "file-text",
    "external": "external-link", "anchor": "anchor", "rupee": "banknote", "close": "close", "down": "chevron-down",
    "back": "chevron-left", "ruler": "arrows-horizontal", "brightness": "sun-solid", "wave": "waves",
    "palette": "colors-swatch", "book": "book-open", "route": "directions", "pin": "map-pin", "eye": "eye",
    "clock": "clock", "bulb": "lightbulb", "list": "bulletlist", "bolt": "zap", "calendar": "calendar",
}
# drawn on the same 24 px grid
CUSTOM = {
    "lighthouse": "M10 1h4v2h-4zM9 3h6v1H9zM9 4h1v3H9zM14 4h1v3h-1zM9 7h6v1H9zM7 8h10v2H7zM8 10h2v11H8zM14 10h2v11h-2z"
                  "M10 12h4v2h-4zM10 17h4v2h-4zM6 21h12v2H6zM2 4h5v1H2zM17 4h5v1h-5zM3 2h3v1H3zM18 2h3v1h-3zM3 6h3v1H3zM18 6h3v1h-3z",
    "record": "M9 5h6v2H9zM7 7h10v2H7zM5 9h14v6H5zM7 15h10v2H7zM9 17h6v2H9z",
}


def fetch(name):
    os.makedirs(SRC, exist_ok=True)
    path = os.path.join(SRC, name + ".svg")
    if not os.path.exists(path):
        with urllib.request.urlopen(CDN.format(name), timeout=30) as r:
            open(path, "wb").write(r.read())
    return open(path).read()


def main():
    symbols, missing = [], []
    for sid, d in CUSTOM.items():
        symbols.append(f'<symbol id="{sid}" viewBox="0 0 24 24"><path d="{d}"/></symbol>')
    for sid, name in ICONS.items():
        try:
            svg = fetch(name)
        except Exception:
            missing.append(sid)
            continue
        body = re.sub(r"^.*?<svg[^>]*>|</svg>\s*$", "", svg, flags=re.S).strip()
        symbols.append(f'<symbol id="{sid}" viewBox="0 0 24 24">{body}</symbol>')
    sprite = ('<svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" shape-rendering="crispEdges">\n'
              '<!-- pixelarticons, MIT License, https://pixelarticons.com (lighthouse and record drawn for this map) -->\n'
              + "\n".join(symbols) + "\n</svg>\n")
    open(OUT, "w").write(sprite)
    print(f"{len(symbols)} icons -> {OUT}; missing: {missing or 'none'}")


if __name__ == "__main__":
    main()
