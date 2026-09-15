# lighthouses — Architecture

Live at **https://maps.reclaimchennai.city/lighthouses/** (static, part of the maps hub).
Written 2026-09-13.

## What this is

An animated, interactive map of every **active lighthouse maintained by India's Directorate
General of Lighthouses & Lightships (DGLL)**, inspired by mapped.earth's lighthouse maps and
an older static map by Raj Bhagat Palanichamy.

- Each light flashes its **real characteristic**, taken from DGLL's itemised light/eclipse
  timings where the ledger has them (e.g. Chennai `0.57+1.93+0.57+6.93`).
- Revolving optics are drawn as **sweeping beams**. The shader delays the rhythm by bearing,
  so every point at sea sees the published characteristic.
- **Visual reach** is sea-only. Its radius is the shorter of luminous range and geographical
  range (horizon for a 5 m eye). Sight lines stop at the first landfall, so headlands, bays
  and islands cast shadows.
- The **7 NAVTEX stations** (DGLL list) broadcast semicircular wavefronts over connected sea
  out to DGLL's stated 250 NM. They brighten during their actual UTC transmission slots, which
  are 10-minute windows.
- **RACON** beacons can be toggled on. Each one's Morse identifier travels outward as rings.
- **3D towers** in three.js, procedurally built from each ledger's tower type, height and
  colour scheme. Proportions were checked against reference photos: Chennai's triangular prism
  with its service shaft, Kanyakumari, Tangasseri's spiral, Mahabalipuram's stone,
  Santapille/Muttom banding.
- Linked views:
  - colour by light colour, technology or age
  - a history slider that plays the coast lighting up from 1796
  - a "rhythm wall" of every light's flashes
  - a detail card (DGLL photo, ranges, optic, kit, Master Ledger PDF link)
  - a night-voyage camera tour

## Layout

```
lighthouses/
├── scripts/
│   ├── fetch_sources.sh   # pull every source into raw/ (DGLL pages+ledger PDFs, Rowlett, OSM, Wikidata)
│   ├── build_basemap.py   # Natural Earth + DataMeet -> web/data/basemap.json, build/land_mask.geojson
│   ├── parse_ledgers.py   # DGLL Master Ledger text -> build/ledgers.json
│   ├── parse_rowlett.py   # Lighthouse Directory -> build/rowlett.json
│   ├── build_data.py      # merge + position QA + sea-only reach -> web/data/{lighthouses,reach}.json
│   └── refresh.sh         # parse + build + rsync web/ into ~/projects/maps-site/lighthouses
├── raw/                   # fetched sources (FETCHED_AT has the timestamp)
├── build/                 # intermediates, build_notes.txt (every correction/skip is logged here)
└── web/                   # the deployed site: index.html, css/, js/{app,layer3d,models}.js, data/
```

`web/` is the source of truth for the front end. `~/projects/maps-site/lighthouses/` is a
**deploy copy**, not a symlink: the caddy container only mounts `maps-site`, so a symlink
pointing outside it would not resolve.

## Refresh with the latest data

```
scripts/fetch_sources.sh && scripts/refresh.sh
```

Python for the geometry steps is the tn-flights venv (`geopandas`, `shapely`). There is no
build step for the front end: MapLibre GL 5.24 (UMD) and three.js r186 (ES modules via an
import map) load from jsdelivr.

## Data decisions worth knowing

- **"Active" = has a DGLL Master Ledger with a working light characteristic.** 211 DGLL
  station pages give 197 lighthouses plus the Perigee light vessel. DGLL's headline figure is
  204.
  - Skipped: VTS radar/repeater sites, decommissioned Loran-C/DNC stations, and the two DGPS-only
    stations (Rameswaram, Campbell Bay).
  - Rowlett's "Inactive" flags are *not* used to exclude stations: they mostly describe old
    towers replaced by the current active light of the same name.
- **Ledger positions are hand-typed and a few are wrong.** `build_data.py` checks each one:
  1. Same Admiralty number in OSM seamarks, trusted if more than 3 km apart. This caught
     Vizhinjam (93°E for 77°E) and Sir Hugh Rose.
  2. A same-named OSM/Wikidata/Directory position, if more than 8 km apart. This caught
     Mahabalipuram and Dahanu. The threshold is 8 km because paired lights such as Minicoy
     North/South sit about 5 km apart.
  3. `POSITION_FIX` for errors shared by every DGLL record: Kalpeni (58'→38'), Aves (93°→92°).

  Every correction lands in `build/build_notes.txt`.
- The ledger parser tolerates the degree sign rendered as a trailing `0` (`120 04.90'` = 12°04.90'),
  seconds ≥ 60 that are really decimal minutes, wrapped labels ("Characteristi / c"), and
  headline periods that contradict the itemised timings. The itemised timings win.
- NAVTEX slots on DGLL's page are UTC HHMM. RACON, NAVTEX and VTS come from DGLL's lists rather
  than the ledger tables, which print those headings even when the row is NIL.

## Second pass (2026-09-13): optics, Lok Sabha data, light vessel, mobile

- **Spin vs blink is data.** `parse_ledgers.classify_optic()` reads only the ledger's optic
  section:
  - `revolving`: rotation device, a plausible RPM, a "revolving" optic, or a mercury-float pedestal.
  - `flasher`: LED flasher, marine lantern, Sealite/MSM units, fixed drum optic, or a NIL rotation device.
  - `None`: the ledger doesn't say.

  Revolving optics sweep 360° at `60 / rpm` seconds per turn, when that is a whole number of
  flash periods (Chennai: 3 rpm → 20 s → 2 groups per turn → 4 shafts, matching its 4 panels).
  Otherwise one turn per period. Flashers and `None` blink in place. Motor-shaft RPMs
  (1500, 2800) are discarded.
- **Beams leave the lantern.** Each revolving light gets 3D cone shafts from the lamp (models
  are exaggerated, so a sea-level beam looked like it came from the base). The shafts are
  short (2.6 × tower). The sea sweep starts where they land (`uInner`), and each shaft fades
  on bearings whose sight line has no open water. The per-light `sea_mask` (72 × 5°) comes from
  the same rays as the reach polygon.
- **Lok Sabha answers**, transcribed in `build_data.py` and cited in the footer and cards:
  - Q3233 (7 Aug 2026):
    - 75 tourism lighthouses (`TOURISM`, hand-mapped to slugs) and 7 museums (`MUSEUMS`).
    - 4 lighthouses planned on NW-2 (`PLANNED`). Their markers are the named river ports,
      because exact tower sites aren't published.
  - Q949 (24 Jul 2026): the named technologies and the 2023-26 allocation/utilisation (`BUDGET`).

  Three tourism lighthouses have no DGLL ledger page: Kannur, Kelshi/Anjarle and Rawal Pir.
  They are added from the Lighthouse Directory (`EXTRA`); their reach is the geographic range
  only, and their optic is unknown.
- **Light vessel.** DGLL has one in service: Perigee, Gulf of Khambhat, ledger F 0449. It's
  modelled in `models.buildLightVessel()` from DGLL's photo, and the `swell` group heaves,
  rolls, pitches and swings on its mooring. OSM has no other light vessels in Indian waters.
- **Colour modes Technology/Visit** use only reference-palette slots 1-2 (`#3987e5`, `#d95926`)
  plus a neutral. Every 4-hue combination failed the all-pairs CVD check for map marks, so AIS
  and DGNSS go in the cards and the legend text instead of a colour.
- **Mobile first.** Base CSS is the phone layout: bottom sheet (collapsed on load), bottom
  card, 44 px targets, controls top-right. `@media (min-width:821px)` restores the sidebar.
  `pixelRatio` is capped at 2, and the rhythm wall stops drawing while the sheet is hidden.

## Master Ledger transcription (source of truth for the light function)

pdftotext mangles the ledgers: degree signs become trailing zeros, superscripts vanish,
engine/alternator "RPM" tables sit beside the optic's, and tables wrap. A card once showed
Armagon at "1,500 rpm" with an "LED" badge; its ledger says MBR-300, 6 panels, 0.667 rpm, 3°.

- `build/ledger_ai/<slug>.json`: one per ledger, written by Claude agents that read both the text
  layer and the rendered PDF pages (vision), following a fixed schema:
  - position, characteristic, itemised light/eclipse sequence, flash duration, colours, sectors
  - luminous and geographical range, tower
  - optic: make, panels, rotation device, optic rpm, `rotates` + evidence, horizontal/vertical divergence
  - intensity, RACON/AIS/DGPS, power
  - `issues`, where the ledger contradicts itself

  Nulls where the ledger is silent. To redo one, re-run an agent on that PDF with the same prompt
  (8 batches: `ls raw/dgll/ledger/*.pdf | sort | awk 'NR%8==k'`).
- `build_data.apply_ai()` overlays these onto the regex parse, which is now only a fallback, and
  writes every disagreement to `build/parse_diff.csv`.
- `build_data.light_sim()` turns each ledger into the animation:
  - **revolving:** seconds per turn = 60 / optic rpm, when that is a whole number of flash periods;
    else panels × period / flashes. Beam width = ledger horizontal divergence.
  - **flashing:** the ledger's own light/eclipse timings.
  - **fixed:** steady light.

  Internal inconsistencies (rpm vs rhythm, panels vs beams, divergence vs flash duration) are
  kept as `flags` and shown on the card as "Ledger check". `build/light_audit.csv` lists every
  station's inputs and derived simulation.

### Rules the transcriptions forced (all logged in build/build_notes.txt)

- **Misfiled ledger.** DGLL's Mahe page carries Kannur's ledger: its address, position and
  light are Kannur's. `LEDGER_IS` attaches it to `kannur-lighthouse`. Mahe itself comes from the
  Lighthouse Directory via `EXTRA`.
- **Copied Admiralty numbers.** Kalpeni repeats East Island's F 1201. An Admiralty number used by
  more than one ledger never moves a light to an OSM position.
- **Seconds typed as decimal minutes** (Kanyakumari 8° 04' 8" = 8° 04.8'). The alternative reading
  is used only when it lands within 600 m of the same-named light in OSM or Wikidata, and at
  least 300 m closer than the literal reading. That applied to 10 lights, each ending up within
  15-480 m.
- **Blanked lens panels.** Ledger totals include blanked lenses ("6 (5 Nos Blanking with aluminum
  sheet)", "6 (4 Fresnel lens + 2 blanks)", "6 Nos (4 in service)"). `active_panels()` keeps the
  shining ones, which makes Kilakkarai, Kundapur, Satpati, Valsad Khadi, Anjengo and Arnala
  consistent with their rpm and rhythm. Blanked lantern *panes* are glazing and are ignored.
- **Not active.** Murud Janjira's ledger says the light has been non-functional for years, so
  it is left off. VTS, repeater and decommissioned Loran-C/DNC stations are skipped by ledger
  station type.
- **Implausible group counts** (Agatti "Fl (30)") with no itemised timings are not simulated as
  written; the card says so.
- Stations that still disagree with themselves (for example rpm vs rhythm at Sagar Island or
  Dolphin's Nose) are animated from the most specific consistent figures, with the conflict
  shown as a "Ledger check".

## Third pass (2026-09-14): records, recording, basemap, guide

- **Full Master Ledger records.** Agents transcribed every section of all 211 ledgers verbatim into
  `build/ledger_full/<slug>.json` (the same 10-batch pattern: `awk 'NR%10==k'`). They read all pages
  as images and keep blanks, NIL and NA as printed. The transcription covers every item down to
  air-conditioners, CCTV, gensets, fire extinguishers, buildings, staff, land and cost details.
  - `build_data.py` publishes one record per station to `web/data/ledgers/<station id>.json`
    (misfiled ledgers are remapped via `LEDGER_IS`).
  - `js/dossier.js` renders a record. It shows a summary (entries, blank/NIL count, items reported
    broken, removed or not working), the inconsistencies, unreadable spots, a section index and search.
- **Equipment years.** `equipment_years()` takes the earliest installation or commissioning year
  printed inside each NAVTEX, RACON, NAIS or DGPS section, with plausibility floors (NAIS
  ≥ 2010, the Saab contract). Where a station prints no date, the network's earliest ledger
  year is used and marked "network". NAVTEX waves and RACON rings are hidden before those years
  on the History slider.
- **Picture & video** (`js/record.js`, ported from pol.reclaimchennai.city).
  - The composite frame contains the map, lighthouse labels, the year watermark and a credit band,
    with the desktop panel cropped out.
  - Video uses WebCodecs H.264 with the vendored `vendor/mp4-muxer.js`, falling back to MediaRecorder
    WebM plus `webm.js` for the duration fix. It is captured live at 30 fps, up to 90 s.
  - The map runs with `preserveDrawingBuffer: true` so the canvas can be read back.
- **Basemap.** OpenFreeMap vector tiles (OpenMapTiles schema, no key), added lazily on the first
  `idle`: water, rivers, main roads, urban areas, sea/state/city/town/village names (Noto Sans
  glyphs). OSM boundary layers are deliberately not drawn; India's outline and states remain
  DataMeet's Survey of India composite.
- **Card.**
  - A standard light spec with source tags (Ledger / Derived / Directory).
  - A log-scale brightness strip against all DGLL intensities, with a candle and the ECE high-beam
    140,000 cd per lamp for reference.
  - A reach diagram (luminous vs geographical range, limiting factor, national median).
  - Icon capsules for equipment ("Public access", not "tourism").
- **Icons.** `scripts/build_icons.py` builds `web/icons.svg` from Tabler Icons (MIT). Stroke styling
  lives on `.i` in CSS: attributes on the sprite root don't reach `<use>` from another file.
- **Guide.** `web/guide.html` documents every map feature, card field and record, plus the methods,
  accountability uses and limits. `web/light_audit.csv` is downloadable.
- `[hidden]{display:none!important}` is required: a class that sets `display` beat the attribute,
  and the REC badge showed on load (pol hit the same bug).

## Pixel edition (2026-09-14)

The site follows pol.reclaimchennai.city's pixel-art style: Minecraft, Dangerous Dave and early
Prince of Persia.

- **Map pixelation.** `PIXEL_RATIO = 0.5` in `app.js`: MapLibre and three.js render into a
  half-resolution buffer, and CSS scales the canvas up with `image-rendering: pixelated`. Coast,
  beams, waves, labels and towers become 2×2 blocks. Place-name layers are sparser and one size
  larger to stay legible. The glow point size reads `map.getPixelRatio()`, and `record.js` turns
  image smoothing off.
- **Voxel models.** `models.js` builds every tower from cubes: one `InstancedMesh` per tower, a
  shell only, with per-block shade jitter. Footprints are round, square, octagon, triangle or
  skeletal; bands and spirals follow the ledger colours; Chennai gets its buff shaft. The lamp is
  still a separate mesh named `lamp`. The Perigee light vessel is voxels inside `swell`.
- **Pixel scenes.** `js/scenes.js` (after `aqi/dashboard/static/js/scenes.js`) draws 96×54 night
  scenes at 15 fps on the map's clock:
  - the tower in its banding and the lantern at its ledger rhythm
  - revolving beams sweeping at `sim.rev_s`
  - NAVTEX mast rings and RACON Morse blips
  - the light vessel bobbing

  One scene sits at the top of every card, and the panel hero shows Chennai.
- **UI.** Pixelify Sans (text), Silkscreen (labels), VT323 (numbers); bevelled stone blocks with
  hard shadows, block switches, square slider thumbs, stepped animations. Icons are pixelarticons
  (MIT) in `web/icons.svg`, built by `scripts/build_icons.py`, plus a hand-drawn lighthouse and
  record icon.
- The phone sheet hides the floating camera and record buttons while open (`body.sheet-open`).
- Screenshots: several swiftshader pages at once time out on `page.screenshot`. Run them one or
  two at a time (the shot script now uses a 120 s screenshot timeout).

## Tender archive, backups, pixel signals (2026-09-14)

- **Tenders.** `scripts/fetch_tenders.py` parses DGLL's current list and all 19 archive pages
  (Drupal view: `?page=0..18`, 20 rows each; 378 tenders), merges tenders listed on both, and
  backs up every notice and corrigendum to `raw/tenders/docs/<nid>/` with size and SHA-256
  (`build/tenders_index.json`).
- **Coverage (2026-09-15).**
  - All 378 tenders are transcribed: 400 PDFs, 3,588 pages, of which 858 scanned pages were read from images.
  - Tenders link to 132 stations (384 links).
  - 299 tenders state an estimated cost, ₹145 crore in total.
  - Scope level: 342 name sites, 26 are directorate-wide, 10 national.
  - Agents record document faults in each file's `notes`: EMD in figures ≠ words, deadlines after bid opening,
    terms copied from other tenders, corrigendum-only postings. DGLL's listing often shows the notice date as the
    "Date of Opening BID"; the page prefers the date printed in the notice.
  - Run transcription agents at 3–6 in parallel and forbid sub-agents: 8 parallel agents (one forked
    into 4) hit the usage limit twice. Write one file per tender immediately so an interrupted run resumes.
- **Reading.** `scripts/prep_tenders.py` follows the ~/projects/tender approach: text layer
  first (pdftotext), pages under 80 characters are treated as scans and rendered to PNG. The
  tender app then OCRs with Tesseract; here Claude agents read the text and the page images
  instead (and re-render garbled Hindi text layers), writing `build/tender_ai/<nid>.json` to
  `build/tender_schema.md`. The schema covers:
  - sites with `station_id` from `build/station_names.tsv`
  - scope/BOQ rows, money, dates, eligibility, specs and corrigenda
  - documents read, with unreadable spots
  - personal numbers removed
- **Linking.** `scripts/link_tenders.py` validates station ids, mirrors documents to
  `web/tenders/<nid>/` and writes:
  - `web/data/tenders.json` (the archive page)
  - `build/tenders_linked.json` (`by_station`, `by_directorate`)

  `build_data.py` attaches `s.tenders`, shown in the card's Tenders section and linked to
  `tenders.html#t-<nid>`.
- **Photos.** `scripts/fetch_photos.py` backs up the one station photo on each DGLL detail page
  (or the Wikidata image) to `raw/photos/<id>/` and serves an 800 px JPEG from
  `web/photos/<id>.jpg` (`s.photo_local`); the card links to the original.
- **Source tags.** Ledger is the default and cited in the footer, so only Derived and Directory
  values carry a tag. The characteristic is rebuilt from the parsed fields in one wording:
  `Fl(3) W 20s · White, 3 flashes every 20 s`, with the ledger text on hover.
- **Pixel signals.** Beam, NAVTEX and RACON fragments snap `vLocal` to `uCell`, i.e.
  2 drawing-buffer pixels in metres at the station's latitude. The `mpp0·2/pixelRatio·cos(lat)`
  value is set per frame.
  - Brightness is posterized to 4 steps with a 4×4 Bayer dither, so average brightness is kept.
  - Time steps at 12 fps, and the shaft bearings use the same stepped clock.
  - Far-zoom glows are 9×9 diamond sprites; the lantern halo is a 16×16 nearest-filtered texture.
  - Don't redeclare a uniform as a local of the same name in GLSL (`float uTime = f(uTime)`);
    use a new name.

## Realism, camera and accessibility pass (2026-09-15)

- **Git.** The project is now a git repo (`main`). Large binaries stay out (`.gitignore`): tender PDFs,
  photos, ledger PDFs, page renders, and the site's mirrors of them. They stay backed up on disk under `raw/`.
- **Light over land.** A lighthouse also lights the land behind it; the old sea-only sweep was wrong.
  - `Sea.land_reach` (the reach circle ∩ land) becomes `reach.land[id]`, drawn by the same beam
    shader with `uLand = 1`: fainter, faster falloff, no rim.
  - The 3D shafts turn a full circle.
  - Darkness comes only from the ledger:
    - `light_screen()` reads "Visibility sector" (bearings from seaward, flipped 180° to the
      direction shown) and panes "blanked … land side".
    - That gives `screen_mask`, and `screened_wedges()` cuts those arcs out of both meshes.
    - 8 stations: 6 landward screens (Kaup, Mahabalipuram, Ratnagiri, Santapalli, Surathkal,
      Thangasseri), 2 sectors (Sacramento, Samiyani Island).
  - Blanked *lens panels* with no direction are optic panels (active_panels), not screens.
- **Range check.** `iala_range()` computes the IALA E-200-2 luminous range of the ledger intensity
  (night, T = 0.74). The card states it and flags a >30% disagreement with the ledger's range
  (17 stations, listed in build_notes). The median light matches (ratio 1.05), which is why candela
  sit near headlamp values.
- **Source marks.** Tag chips are gone: † = derived (or a network equipment year), ‡ = Lighthouse
  Directory, each explained in a footnote under its section. Ledger values carry no mark.
- **Camera.**
  - `ViewControl` replaces MapLibre's NavigationControl: +, −, and a 2D / 3D button that names the
    view it switches to (easeTo pitch 0 / pitch 60 back to the last bearing).
  - Map options: `maxPitch: 85`, `rollEnabled: true`.
  - Selecting a light flies (3.2 s, or jumpTo under prefers-reduced-motion) to z 15.8, pitch 72,
    bearing = seaward bearing (mean of `sea_mask` bins) + 180. The camera sits offshore looking at
    the tower, padded clear of the card (right on desktop, bottom half-sheet on phones).
- **3D buildings.** `omt-buildings` fill-extrusion from OpenFreeMap's `building` layer
  (`render_height`), z ≥ 14 only. Swap the source for measured heights near lighthouses later.
- **RACON.** On by default; rings fade out between z 9.5 and 12, where they smeared into bands.
- **Rhythm wall.** It is sized by a ResizeObserver from a fixed CSS height. Measuring once on a phone
  (collapsed sheet, 0 px wide) made a 2×600 buffer that stretched into a 100,000 px strip.
- **Towers.** Built a few per idle slice after first paint. Building all ~200 on the first zoom-in
  froze the page and dropped recording frames. Recorder: 960 px wide on phones, encoder queue 30.
- **Accessibility.**
  - Skip link, labelled regions, a dialog role on the card with focus return on close, `role=switch`
    on toggles, a roving-tabindex radio group, a labelled search input, and map labels removed from
    the tab order (Find is the keyboard route).
  - A loading screen with status text and a stepped bar.
  - Text floor of 11 px; `--text-3` raised to ≥ 6:1.
  - axe-core audit: `scratchpad/axe.mjs` pattern (index, guide, tenders at 390 and 1440 px).
- **Points network (provision only).** `web/js/network.js` `emit()` dispatches `lh:action` DOM
  events (`station:view` today). There is no login, storage or network call. See below for the plan.

### Follow-up (2026-09-15, same day)
- **One numeral face.** `web/fonts/silkscreen-{400,700}.woff2` (OFL, self-hosted) is declared as
  "LH Digits" with `unicode-range` digits, ° and %. It leads `--font` and `--num`, so every digit
  anywhere (sentences, stats, charts, tender pages, canvas text in record.js) is Silkscreen.
  VT323 was removed, and number sizes were retuned for the wider face.
- **Loading bar.** An inline script in index.html creeps the bar toward the next milestone
  (`window.__lhLoad(pct, text)`). app.js streams the three data files and counts bytes against rough
  expected sizes, because Cloudflare compression drops Content-Length. The bar finishes after the
  first rendered frame. Throttled test: 13 → 26 → 38 → 54 → 69 → 100%.
- **Close-up sea.** `uTint` (1 at z ≤ 9, 0 at z ≥ 11.5) scales the reach tint, rim, flasher disc and
  halo radius. Up close only the revolving sweep and a small lantern glow remain, because the sea
  isn't lit from a ship. NAVTEX rings are gone by z 12. The light vessel keeps a 130 px minimum
  size (a ~30 m hull vanished at true scale).
- **Close-up basemap.** Parks and landcover, local streets and brighter roads from z 11–13. The
  buildings get a height ramp, a vertical gradient and `map.setLight` moonlight.
- **Night voyage.** It starts with NAVTEX and RACON off and switches them on at the Mangalore stop
  (`radio: true` in VOYAGE). Every lap starts dark, and the user's switches are restored on stop.
- **History tour.** Colour by Age plus Play runs at 2.2 years/s. `historyFollow` flies (z 12.2,
  pitch 66, facing from the sea) to the newest light lit since the last flight, at most one flight
  per 4.3 s. It sets `#history-caption` under the watermark, which also becomes the recording
  subtitle. Dragging the map ends the camera follow.
- **Panel.** The fly-to buttons and Night voyage now sit under the History slider; "Colour by
  access" was removed. Cards show the ledger's postal address (91 stations).

### Handoff: next steps (for a future session or Fable)
1. **Measured building heights near lighthouses.**
   - For each station, take tiles at z 15–16 covering a radius of `reach_nm × 1.1` (cap ~40 km).
   - Candidate data: Google Open Buildings 2.5D Temporal (India, CC BY 4.0, heights), exported from
     Earth Engine per lighthouse bbox to PMTiles.
   - Serve the result from `web/buildings/<id>.pmtiles` (the pmtiles protocol from
     cdn.jsdelivr.net), loaded when the camera is within that radius.
   - Replace `omt-buildings`' source only; keep its paint.
2. **Beams lighting buildings.**
   - Draw buildings in the three.js layer instead: the same meshes with a shader that adds the
     beam term from BEAM_FRAG (bearing and period from the station uniforms).
   - The lit face then flashes as the beam passes; faces behind a screened arc stay dark.
3. **Points and rewards.** Only when the user asks.
   - Reuse the trees stack: Google/social login and the civic-sentinel ledger
     (`playerKey`, `action`, `points`, `status`, `externalRef`), plus the pixel coin assets in
     ~/projects/trees/assets.
   - Subscribe to `lh:action` and map events to the `externalRef` shapes documented in network.js.
   - A GPS-verified visit to a public-access lighthouse (75 stations) is the natural first action.

## Gotchas

- **three.js inside MapLibre: do not mirror the scene with a negative scale.** MapLibre's
  projection matrix already carries the Mercator y reflection, and three auto-flips front-face
  winding for negative-determinant objects. Doing both culls every triangle: beams and waves
  vanish and towers render inside-out and black. The world uses Mercator's south-growing y
  directly. Shaders get true east/north metres through the `aLocal` attribute.
- The scene is **re-centred on the map centre every frame** for float32 precision at tower zoom.
- MapLibre **v6 ESM** loads its worker as a cross-origin module, which browsers block from a
  CDN. Use the v5 UMD build, or vendor v6.
- Use `style.load`, not `load` (maps-site ARCHITECTURE: `load` can fail to fire on this host).
- **Reach polygons are triangulated in the build, not the browser.** `mesh()` runs shapely's
  constrained Delaunay on the cleaned polygon and ships `{v, i}` indexed triangles. The front
  end used to run three's `ShapeGeometry`/earcut on coast-hugging NAVTEX rings with island
  holes. That drew long spikes of broadcast across the sea and the land at close zoom. The
  fault was confirmed by toggling layers in headless screenshots. Do not go back to
  triangulating in JS.
- Cloudflare caches `.js`/`.css` for about 4 h. Bump `?v=` in `index.html` after front-end changes.
  `app.js` imports `layer3d.js`/`models.js` without a query string, so bump those imports too
  when they change.
- Headless verification works with Playwright's Chromium using
  `--use-angle=swiftshader --enable-unsafe-swiftshader`, served over a local `http.server`.
