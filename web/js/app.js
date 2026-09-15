// Lighthouses of India — map, UI and linked views. Mobile first: the panel is a bottom
// sheet under 821px and a sidebar above it.
import * as THREE from 'three';
// ?v= on every module: Cloudflare caches .js for ~4 h, and a fresh app.js must never meet a stale layer3d.js
import { LighthouseLayer, COLOURS, lightLevel, morsePhases } from './layer3d.js?v=11';
import { createCapture } from './record.js?v=8';
import { openRecord } from './dossier.js?v=1';
import { mountScene } from './scenes.js?v=2';
import { towerSpec } from './models.js?v=3';
import { emit } from './network.js?v=1';
import { openViewer } from './viewer.js?v=2';
import { openSplat } from './splat.js?v=1';

const maplibregl = window.maplibregl;
const $ = s => document.querySelector(s);
// one icon set (Tabler, web/icons.svg, built by scripts/build_icons.py)
const icon = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="icons.svg?v=2#${name}"/></svg>`;
const esc = s =>String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 0) => v == null ? '–' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: d });
const desktop = matchMedia('(min-width:821px)').matches;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;   // camera jumps instead of flying
const SHEET_PEEK = 88;                     // collapsed bottom-sheet height on phones
const PIXEL_RATIO = 0.5;                   // map buffer pixels per CSS pixel: every map pixel is a 2×2 block

const VIEWS = {
  india:       { center: [80.8, desktop ? 14.2 : 12.2], zoom: desktop ? 4.35 : 3.35, pitch: desktop ? 38 : 20, bearing: 0 },
  west:        { center: [72.4, 17.5], zoom: 5.6, pitch: 55, bearing: 18 },
  east:        { center: [83.2, 15.6], zoom: 5.5, pitch: 55, bearing: -22 },
  lakshadweep: { center: [72.9, 10.6], zoom: 6.8, pitch: 55, bearing: 0 },
  andaman:     { center: [92.9, 10.4], zoom: 5.7, pitch: 55, bearing: 12 },
  chennai:     { center: [80.28, 13.03], zoom: 9.4, pitch: 62, bearing: -30 },
};
const VOYAGE = [
  { center: [69.1, 22.6], zoom: 7.2, bearing: 40 }, { center: [72.8, 18.9], zoom: 8.2, bearing: 10 },
  { center: [73.8, 15.5], zoom: 8.0, bearing: -10 },
  // off Mangalore the radio aids switch on: NAVTEX broadcasts and RACON Morse appear mid-voyage
  { center: [74.75, 12.9], zoom: 8.2, bearing: -15, radio: true },
  { center: [76.2, 9.9], zoom: 8.0, bearing: -25 },
  { center: [77.5, 8.1], zoom: 8.6, bearing: -60 }, { center: [80.3, 13.0], zoom: 9.2, bearing: -30 },
  { center: [83.3, 17.7], zoom: 8.3, bearing: -35 }, { center: [86.7, 20.3], zoom: 8.0, bearing: -45 },
  { center: [92.7, 11.6], zoom: 7.6, bearing: 10 }, { center: [73.0, 8.3], zoom: 8.4, bearing: 0 },
];

// Identity colours for the Technology / Visit modes: reference-palette dark slots 1-2,
// validated on this surface (all pairs, CVD ΔE 26.8). Everything else stays neutral.
const SLOT = { a: '#3987e5', b: '#d95926', rest: '#5d6873' };
const C3 = Object.fromEntries(Object.entries(SLOT).map(([k, v]) => [k, new THREE.Color(v)]));

/* ------------------------------------------------------------------ data */
// The three data files stream into the loading bar (30 → 80%). Cloudflare compresses them, so there is
// often no Content-Length: bytes are counted against a rough expected size instead.
window.__lhLoad?.(30, 'Loading lighthouse data…');
const dl = { got: 0, want: 0 };
async function fetchJSON(url, expected) {
  const r = await fetch(url);
  const size = +r.headers.get('content-length') || expected;
  dl.want += size;
  if (!r.body) return r.json();
  const reader = r.body.getReader(), parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); dl.got += value.length;
    window.__lhLoad?.(30 + 50 * Math.min(1, dl.got / dl.want));
  }
  return JSON.parse(await new Blob(parts).text());
}
const [data, reach, base] = await Promise.all([
  fetchJSON('data/lighthouses.json', 680e3),
  fetchJSON('data/reach.json', 320e3),
  fetchJSON('data/basemap.json', 1.2e6),
]);
const loadStep = (text, pct) => window.__lhLoad ? window.__lhLoad(pct, text) : ($('#loading-text').textContent = text);
loadStep('Drawing the coast…', 86);
const S = data.stations;
// 3D scans (Gaussian splats, scripts/splat/): loaded in the background, a card shows its button once known
let SCANS = {};
fetch('data/splats.json').then(r => (r.ok ? r.json() : {})).then(d => { SCANS = d.stations || {}; }).catch(() => {});
const P = data.parliament;
const lights = S.filter(s => s.kind === 'lighthouse' || s.kind === 'lightvessel');
const byId = new Map(S.map(s => [s.id, s]));
const yearOf = s => s.established || s.tower_year;

/* ------------------------------------------------------------------- map */
const map = new maplibregl.Map({
  container: 'map',
  // glyphs are only fetched once the lazy place-name layers are added
  style: { version: 8, glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf', sources: {},
           layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#05080c' } }] },
  // free 3D exploration: tilt almost to the horizon, rotate, and roll (Ctrl + drag)
  ...VIEWS.india, minZoom: 2.8, maxZoom: 16.5, maxPitch: 85, rollEnabled: true,
  maxBounds: [[52, -8], [108, 34]], renderWorldCopies: false, attributionControl: false,
  // Pixel art: the whole map (coast, beams, waves, voxel towers) renders at half resolution and
  // is scaled up without smoothing (.maplibregl-canvas { image-rendering: pixelated }).
  pixelRatio: PIXEL_RATIO,
  // preserveDrawingBuffer: pictures and videos read the WebGL canvas back (record.js)
  canvasContextAttributes: { antialias: true, preserveDrawingBuffer: true },
});
map.addControl(new maplibregl.AttributionControl({
  compact: true,
  customAttribution: 'DGLL · Lok Sabha · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Natural Earth · DataMeet',
}), desktop ? 'bottom-right' : 'top-left');
// Zoom in, zoom out and one 2D / 3D button. The button names the view it switches to; going flat
// eases pitch and bearing back to zero, going 3D runs the same ease in reverse.
class ViewControl {
  onAdd(m) {
    this.m = m;
    const el = this.el = document.createElement('div');
    el.className = 'maplibregl-ctrl maplibregl-ctrl-group view-ctrl';
    el.innerHTML = `<button type="button" class="z-in" aria-label="Zoom in" title="Zoom in">+</button>
      <button type="button" class="z-out" aria-label="Zoom out" title="Zoom out">−</button>
      <button type="button" class="v-dim"></button>`;
    el.querySelector('.z-in').onclick = () => m.zoomIn({ duration: reduceMotion ? 0 : 400 });
    el.querySelector('.z-out').onclick = () => m.zoomOut({ duration: reduceMotion ? 0 : 400 });
    this.dim = el.querySelector('.v-dim');
    this.dim.onclick = () => {
      const flat = m.getPitch() < 5;
      if (!flat) this.lastBearing = m.getBearing();
      m.easeTo(flat ? { pitch: 60, bearing: this.lastBearing ?? -20, roll: 0, duration: reduceMotion ? 0 : 1000 }
                    : { pitch: 0, bearing: 0, roll: 0, duration: reduceMotion ? 0 : 1000 });
    };
    this.sync = () => {
      const flat = m.getPitch() < 5, next = flat ? '3D' : '2D';
      if (this.dim.textContent !== next) {
        this.dim.textContent = next;
        this.dim.setAttribute('aria-label', `Switch to ${next} view`);
        this.dim.title = `Switch to ${next} view`;
      }
    };
    m.on('pitchend', this.sync); m.on('moveend', this.sync); this.sync();
    return el;
  }
  onRemove() { this.el.remove(); }
}
map.addControl(new ViewControl(), desktop ? 'bottom-right' : 'top-right');
const BASE_PADDING = desktop ? { left: 340, top: 0, right: 0, bottom: 0 } : { left: 0, top: 0, right: 0, bottom: SHEET_PEEK };
map.setPadding(BASE_PADDING);

const layer = new LighthouseLayer(maplibregl, data, reach);
window.__lh = { map, layer };          // console / headless-verification hook

// "style.load", not "load": on this host tiles-settled "load" can fail to fire (maps-site ARCHITECTURE.md)
map.once('style.load', () => {
  map.addSource('land', { type: 'geojson', data: base.land });
  map.addSource('india', { type: 'geojson', data: base.india });
  map.addSource('states', { type: 'geojson', data: base.states });
  map.addSource('lakes', { type: 'geojson', data: base.lakes });
  map.addSource('planned', { type: 'geojson', data: {
    type: 'FeatureCollection',
    features: P.planned.sites.map(s => ({ type: 'Feature', properties: { name: s.name }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } })),
  } });
  map.addLayer({ id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': '#0c1117' } });
  map.addLayer({ id: 'india', type: 'fill', source: 'india', paint: { 'fill-color': '#10171f' } });
  map.addLayer({ id: 'lakes', type: 'fill', source: 'lakes', paint: { 'fill-color': '#070b10' } });
  map.addLayer({ id: 'states', type: 'line', source: 'states',
    paint: { 'line-color': '#9fb4c8', 'line-opacity': 0.13, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.4, 9, 1.1] } });
  map.addLayer({ id: 'coast-glow', type: 'line', source: 'land',
    paint: { 'line-color': '#3a5a78', 'line-opacity': 0.35, 'line-blur': 3, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 2, 10, 6] } });
  map.addLayer({ id: 'coast', type: 'line', source: 'land',
    paint: { 'line-color': '#6d8aa6', 'line-opacity': 0.55, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 10, 1.2] } });
  map.addLayer({ id: 'planned', type: 'circle', source: 'planned', paint: {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3.5, 10, 8],
    'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#d9a066', 'circle-stroke-width': 1.6,
  } });
  loadStep('Lighting the lamps…', 94);
  map.addLayer(layer);
  styleReady = true;
  addWarningLayers();
  // light for the 3D buildings: a low, cool moon from the south-west
  map.setLight({ anchor: 'map', position: [1.4, 210, 35], color: '#c9d6ea', intensity: 0.5 });
  // done after the first frame with the lights drawn (shaders compiled), so the bar reaches 100% on screen
  map.once('render', () => requestAnimationFrame(() => {
    loadStep('Ready', 100);
    setTimeout(() => { $('#loading').classList.add('done'); $('#loading').setAttribute('aria-hidden', 'true'); }, 220);
  }));
  // the lights paint first; places, roads and rivers stream in after the first settled frame
  map.once('idle', () => {
    if ($('#l-base').checked) loadBasemap();
    // prebuild the voxel towers in small idle slices so the first zoom-in doesn't stall
    const idle = window.requestIdleCallback || (cb => setTimeout(() => cb({ timeRemaining: () => 8 }), 60));
    const step = deadline => {
      if (layer.towersBuilt || !layer.entries) return;
      layer.buildTowers(deadline.timeRemaining() > 12 ? 4 : 2);
      if (!layer.towersBuilt) idle(step);
    };
    idle(step);
  });
  // compact attribution opens expanded; on a phone that covers the top of the map
  if (!desktop) setTimeout(() => document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'), 50);
});

/* ---------------------------------------------------------- pixel scenes */
// Card and header scenes run on the map's clock, so a scene's flashes match the beam on the map.
const SCENE_OPTS = {
  towerSpec,
  clock: () => layer.clock.value,
  level: (st, t) => (st.phases && !layer.unlit.has(st.id) ? lightLevel(st.phases, t) : 0),
};
{
  const hero = byId.get('chennai-lighthouse') || lights[0];
  if (hero) mountScene($('#hero-scene'), hero, SCENE_OPTS);
}

/* --------------------------------------------------------- lazy basemap */
// OpenFreeMap vector tiles (OpenMapTiles schema, OSM data; no key). Only orientation layers are used:
// water bodies, main roads, rivers, place and sea names. Country/state lines stay DataMeet's
// Survey-of-India outline from basemap.json, so OSM boundary layers are deliberately not drawn.
const BASE_LAYERS = [];
function loadBasemap() {
  if (map.getSource('omt')) return setBasemap(true);
  $('#base-status').textContent = 'loading…';
  map.addSource('omt', {
    type: 'vector', url: 'https://tiles.openfreemap.org/planet',
    attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a>',
  });
  const name = ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name']];
  const below = 'coast-glow';
  const add = (def, before) => { map.addLayer({ source: 'omt', ...def }, before); BASE_LAYERS.push(def.id); };
  add({ id: 'omt-urban', type: 'fill', 'source-layer': 'landuse', minzoom: 8,
    filter: ['match', ['get', 'class'], ['residential', 'suburb', 'neighbourhood', 'commercial', 'industrial', 'retail'], true, false],
    paint: { 'fill-color': '#18212b', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.25, 12, 0.7] } }, below);
  add({ id: 'omt-water', type: 'fill', 'source-layer': 'water', minzoom: 5,
    filter: ['!=', ['get', 'class'], 'ocean'], paint: { 'fill-color': '#08111a' } }, below);
  add({ id: 'omt-river', type: 'line', 'source-layer': 'waterway', minzoom: 7,
    filter: ['match', ['get', 'class'], ['river', 'canal'], true, false],
    paint: { 'line-color': '#1b3347', 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.5, 12, 1.6] } }, below);
  // close up (the fly-in camera sits at z 15.8) the town around a lighthouse has to read: parks, local
  // streets and brighter roads fade in from z 12
  add({ id: 'omt-green', type: 'fill', 'source-layer': 'park', minzoom: 11,
    paint: { 'fill-color': '#13241c', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0, 13, 0.85] } }, below);
  add({ id: 'omt-cover', type: 'fill', 'source-layer': 'landcover', minzoom: 11,
    filter: ['match', ['get', 'class'], ['wood', 'grass', 'farmland', 'wetland', 'sand'], true, false],
    paint: { 'fill-color': ['match', ['get', 'class'], 'sand', '#2a2a22', 'wetland', '#12201f', '#132019'],
             'fill-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0, 13, 0.7] } }, below);
  add({ id: 'omt-road-local', type: 'line', 'source-layer': 'transportation', minzoom: 13,
    filter: ['match', ['get', 'class'], ['minor', 'service', 'track'], true, false],
    paint: { 'line-color': '#2c3744', 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.5, 16, 2.4] } }, below);
  add({ id: 'omt-road-minor', type: 'line', 'source-layer': 'transportation', minzoom: 10,
    filter: ['match', ['get', 'class'], ['secondary', 'tertiary'], true, false],
    paint: { 'line-color': ['interpolate', ['linear'], ['zoom'], 10, '#222c36', 14, '#3b4a5a'],
             'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.4, 14, 1.8, 16, 3.4] } }, below);
  add({ id: 'omt-road-major', type: 'line', 'source-layer': 'transportation', minzoom: 6,
    filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], true, false],
    paint: { 'line-color': ['interpolate', ['linear'], ['zoom'], 6, '#2d3a47', 13, '#4d5f72'],
             'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.3, 10, 1, 14, 2.6, 16, 4.6] } }, below);
  const labelPaint = { 'text-color': '#b9c6d2', 'text-halo-color': '#05080c', 'text-halo-width': 1.4 };
  add({ id: 'omt-sea', type: 'symbol', 'source-layer': 'water_name', minzoom: 3.5,
    layout: { 'text-field': name, 'text-font': ['Noto Sans Italic'], 'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11, 9, 14],
              'text-letter-spacing': 0.2, 'symbol-placement': 'point', 'text-max-width': 8 },
    paint: { 'text-color': '#4f7392', 'text-halo-color': '#05080c', 'text-halo-width': 1 } });
  add({ id: 'omt-state', type: 'symbol', 'source-layer': 'place', minzoom: 4.5, maxzoom: 8,
    filter: ['==', ['get', 'class'], 'state'],
    layout: { 'text-field': name, 'text-font': ['Noto Sans Regular'], 'text-size': 10.5, 'text-transform': 'uppercase', 'text-letter-spacing': 0.15 },
    paint: { 'text-color': '#6f8396', 'text-halo-color': '#05080c', 'text-halo-width': 1 } });
  add({ id: 'omt-city', type: 'symbol', 'source-layer': 'place', minzoom: 4,
    filter: ['==', ['get', 'class'], 'city'],
    layout: { 'text-field': name, 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10.5, 10, 14],
              'symbol-sort-key': ['coalesce', ['get', 'rank'], 99] },
    paint: labelPaint });
  // the map renders at half resolution (pixel art), so place names are sparser and a size larger
  add({ id: 'omt-town', type: 'symbol', 'source-layer': 'place', minzoom: 8,
    filter: ['==', ['get', 'class'], 'town'],
    layout: { 'text-field': name, 'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 8, 12, 12, 15], 'text-padding': 6 },
    paint: { ...labelPaint, 'text-color': '#94a3b1' } });
  add({ id: 'omt-village', type: 'symbol', 'source-layer': 'place', minzoom: 11,
    filter: ['match', ['get', 'class'], ['village', 'suburb'], true, false],
    layout: { 'text-field': name, 'text-font': ['Noto Sans Regular'], 'text-size': 11 },
    paint: { ...labelPaint, 'text-color': '#7d8b98' } });
  // 3D buildings from OpenStreetMap heights (render_height: height tag, else levels × 3 m, else a default),
  // only fetched once the camera is close (z ≥ 14 tiles). A future dataset with measured heights near the
  // lighthouses (e.g. satellite-derived 2.5D buildings) can replace this source without touching the rest.
  add({ id: 'omt-buildings', type: 'fill-extrusion', 'source-layer': 'building', minzoom: 14,
    paint: {
      // lighter as they rise, lit by the map's moon light (setLight), so blocks stand out from the dark land
      'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 6], 3, '#3a4758', 20, '#52627a', 60, '#6d7f99'],
      'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6],
      'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
      'fill-extrusion-vertical-gradient': true,
      'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 14.5, 1],
    } }, below);
  map.once('idle', () => { $('#base-status').textContent = ''; });
}
function setBasemap(on) {
  for (const id of BASE_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
}
$('#l-base').addEventListener('change', e => { if (e.target.checked) loadBasemap(); else setBasemap(false); });

/* ----------------------------------------------------------------- stats */
{
  const years = lights.map(yearOf).filter(Boolean);
  const c = data.meta.counts;
  $('#stats').innerHTML = [
    ['beam', lights.length, 'active lights'],
    ['navtex', data.navtex.length, 'NAVTEX stations'],
    ['racon', data.racons.length, 'RACON beacons'],
    ['', c.tourism, 'public access'],
    ['', c.museums, 'museums'],
    ['', Math.min(...years), 'oldest station'],
  ].map(([k, v, l]) => `<div class="stat ${k}"><b>${v}</b><span>${l}</span></div>`).join('');
  $('#built').textContent = `Data fetched ${data.meta.built.slice(0, 10)}.`;
  $('#names').innerHTML = S.map(s => `<option value="${esc(s.name)}">`).join('');
  const rev = lights.filter(s => s.sim?.mode === 'revolving').length;
  $('#optic-note').textContent = `${rev} revolve · ${c.flasher} flash in place · ${lights.length - rev - c.flasher} not stated`;
}

/* ------------------------------------------------------------ colour by */
const YEAR_MIN = 1790, YEAR_MAX = 2026;
const ageRamp = y => {
  if (!y) return new THREE.Color('#8e99a4');
  const f = Math.max(0, Math.min(1, (y - 1840) / (2020 - 1840)));
  return new THREE.Color().setHSL(0.02 + f * 0.5, 0.9, 0.62 - f * 0.08);
};
const count = f => lights.filter(f).length;
const swatch = (c, label, n) => `<span><i style="background:${c}"></i>${label} ${n}</span>`;
const COLOUR_MODES = {
  light: { fn: s => COLOURS[s.colour] || COLOURS.W,
    legend: () => swatch('#ffd27a', 'White', count(s => s.colour === 'W')) + swatch('#ff5a4f', 'Red', count(s => s.colour === 'R'))
      + swatch('#3fe08a', 'Green', count(s => s.colour === 'G')) },
  tech: { fn: s => s.navtex ? C3.a : s.racon ? C3.b : C3.rest,
    legend: () => swatch(SLOT.a, 'NAVTEX', count(s => s.navtex)) + swatch(SLOT.b, 'RACON', count(s => !s.navtex && s.racon))
      + swatch(SLOT.rest, 'Light only', count(s => !s.navtex && !s.racon))
      + `<span class="full">Also ${data.meta.counts.ais} AIS · ${data.meta.counts.dgps} DGNSS stations</span>` },
  age: { fn: s => ageRamp(yearOf(s)),
    legend: () => `<div class="ramp" style="background:linear-gradient(90deg,${[1840, 1885, 1930, 1975, 2020].map(y => '#' + ageRamp(y).getHexString()).join(',')})"></div>
                   <div class="ends"><span>1840 and older</span><span>2020</span></div>` },
  visit: { fn: s => s.museum ? C3.a : s.tourism ? C3.b : C3.rest,
    legend: () => swatch(SLOT.a, 'Museum', count(s => s.museum)) + swatch(SLOT.b, 'Public access', count(s => s.tourism && !s.museum))
      + swatch(SLOT.rest, 'No public access', count(s => !s.tourism)) },
};
let colourMode = 'light';
function setColourMode(m) {
  colourMode = m;
  document.querySelectorAll('#colour-by button').forEach(b => { const on = b.dataset.v === m; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); b.tabIndex = on ? 0 : -1; });
  layer.setColour(COLOUR_MODES[m].fn);
  $('#legend').innerHTML = COLOUR_MODES[m].legend();
}
document.querySelectorAll('#colour-by button').forEach(b => b.onclick = () => setColourMode(b.dataset.v));
// radio group keyboard pattern: arrow keys move the choice, Tab leaves the group
$('#colour-by').addEventListener('keydown', e => {
  const btns = [...document.querySelectorAll('#colour-by button')];
  const i = btns.findIndex(b => b.classList.contains('on'));
  const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (!d) return;
  e.preventDefault();
  const next = btns[(i + d + btns.length) % btns.length];
  setColourMode(next.dataset.v); next.focus();
});
setColourMode('light');

/* --------------------------------------------------------------- toggles */
const bindToggle = (id, key) => $(id).addEventListener('change', e => layer.setVisible({ [key]: e.target.checked }));
bindToggle('#l-beams', 'beams'); bindToggle('#l-navtex', 'navtex'); bindToggle('#l-racon', 'racon'); bindToggle('#l-towers', 'towers');
$('#l-labels').addEventListener('change', placeLabels);
function setSheet(open) {
  const p = $('#panel');
  p.classList.toggle('collapsed', !open);
  document.body.classList.toggle('sheet-open', open && !desktop);   // phone: the open sheet hides the floating camera/record
  $('#panel-toggle').setAttribute('aria-expanded', open);
  $('#panel-toggle').title = open ? 'Hide panel' : 'Show panel';
}
$('#panel-toggle').onclick = () => setSheet($('#panel').classList.contains('collapsed'));
$('#panel header').addEventListener('click', e => { if (!desktop && e.target.closest('header') && !e.target.closest('button')) setSheet($('#panel').classList.contains('collapsed')); });
if (!desktop) setSheet(false);

/* ---------------------------------------------------------------- history */
function setYear(y) {
  layer.setYear(y);
  $('#year').value = y;
  $('#wm-year').textContent = y;
  applyWarningVisibility();
  $('#year-label').textContent = y >= YEAR_MAX ? 'today' : y;
  const n = lights.filter(s => layer.bornBy(s, y)).length;
  const dated = lights.filter(s => yearOf(s) && yearOf(s) <= y).sort((a, b) => yearOf(a) - yearOf(b));
  $('#year-note').textContent = y >= YEAR_MAX
    ? `All ${lights.length} lights. ${lights.filter(s => !yearOf(s)).length} have no recorded date and stay lit.`
    : `${n} lights by ${y}.${dated.length ? ' Newest by then: ' + nice(dated[dated.length - 1].name).replace(/ Lighthouse.*/i, '') + '.' : ''}`;
}
$('#year').addEventListener('input', e => { stopPlay(); setYear(+e.target.value); });
let playing = null, historyCam = null;
const HISTORY = lights.filter(yearOf).sort((a, b) => yearOf(a) - yearOf(b));
function endHistoryCam() {
  if (!historyCam) return;
  historyCam = null;
  $('#history-caption').hidden = true;
  layer.setSelected(null);
}
function stopPlay() {
  if (playing) { cancelAnimationFrame(playing); playing = null; $('#play').innerHTML = icon('play'); $('#play').setAttribute('aria-label', 'Play the history of India\'s lights'); }
  endHistoryCam();
}
// Coloured by age, Play becomes a history voyage: years run slower and the camera flies to each light as
// it is lit, close up and facing it from the sea, with the year and name under the watermark.
function historyFollow(y0, y1, now) {
  const born = HISTORY.filter(s => yearOf(s) > y0 && yearOf(s) <= y1);
  if (born.length) historyCam.pending = born[born.length - 1];
  const s = historyCam.pending;
  if (!s || now < historyCam.busyUntil) return;
  historyCam.pending = null;
  historyCam.busyUntil = now + 4300;
  const cam = { center: [s.lon, s.lat], zoom: 12.2, pitch: 66, roll: 0, bearing: (seaBearing(s) + 180) % 360, padding: BASE_PADDING };
  if (reduceMotion) map.jumpTo(cam); else map.flyTo({ ...cam, duration: 3400, curve: 1.3, essential: true });
  layer.setSelected(s.id);
  const c = $('#history-caption');
  c.textContent = `Lit ${yearOf(s)} · ${nice(s.name).replace(/\s+(Lighthouse|Light House).*$/i, '')}`;
  c.hidden = false;
  // under the year watermark wherever it sits (beside the panel on desktop, top left on phones)
  const wm = $('#watermark').getBoundingClientRect();
  c.style.left = Math.round(wm.left) + 'px';
  c.style.top = Math.round(wm.bottom + 8) + 'px';
}
$('#play').onclick = () => {
  if (playing) return stopPlay();
  const tour = colourMode === 'age';
  const rate = tour ? 2.2 : 11;                          // years per second
  const start = performance.now(), from = +$('#year').value >= YEAR_MAX ? YEAR_MIN : +$('#year').value;
  $('#play').innerHTML = icon('pause');
  $('#play').setAttribute('aria-label', 'Pause');
  if (tour) { closeCard(); stopVoyage(); if (!desktop) setSheet(false); historyCam = { busyUntil: 0, pending: null }; }
  let prev = from - 1;
  const step = now => {
    const y = Math.min(YEAR_MAX, Math.round(from + (now - start) / 1000 * rate));
    setYear(y);
    if (historyCam && y > prev) { historyFollow(prev, y, now); prev = y; }
    if (y < YEAR_MAX) playing = requestAnimationFrame(step);
    else { cancelAnimationFrame(playing); playing = null; $('#play').innerHTML = icon('play'); setTimeout(endHistoryCam, 4000); }
  };
  playing = requestAnimationFrame(step);
};
map.on('dragstart', endHistoryCam);                      // grabbing the map hands the camera back
setYear(YEAR_MAX);

/* ------------------------------------------------------------------ NAVTEX */
// DGLL lists the transmission slots as UTC HHMM; each NAVTEX slot is 10 minutes.
function navtexStatus(date = new Date()) {
  const mins = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const live = new Set(), liveNames = [];
  let next = null;
  for (const n of data.navtex) {
    for (const [slots, freq] of [[n.slots_518, 518], [n.slots_490, 490]]) {
      for (const sl of slots) {
        const m = +sl.slice(0, 2) * 60 + +sl.slice(2, 4);
        if (mins >= m && mins < m + 10) { live.add(n.id_518); liveNames.push(`${n.name} (${freq} kHz, ${freq === 518 ? n.id_518 : n.id_490})`); }
        let d = m - mins; if (d < 0) d += 1440;
        if (freq === 518 && (!next || d < next.d)) next = { d, n };
      }
    }
  }
  return { live, liveNames, next };
}
function updateNavtex() {
  const st = navtexStatus();
  layer.setNavtexLive(st.live);
  $('#navtex-live').textContent = st.liveNames.length ? `● on air: ${st.liveNames[0].split(' (')[0]}`
    : st.next ? `next ${st.next.n.name} in ${Math.ceil(st.next.d)} min` : '';
  $('#navtex-live').title = st.liveNames.join('\n');
}
updateNavtex(); setInterval(updateNavtex, 15000);

/* ----------------------------------------------------------------- tooltip */
const tip = document.createElement('div');
tip.className = 'tip'; tip.hidden = true; tip.setAttribute('role', 'tooltip');
document.body.appendChild(tip);
function showTip(html, x, y) {
  tip.innerHTML = html; tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.max(8, Math.min(x + 14, innerWidth - w - 8)) + 'px';
  tip.style.top = Math.max(8, Math.min(y + 14, innerHeight - h - 8)) + 'px';
}
const hideTip = () => { tip.hidden = true; };

/* ------------------------------------------------------------------ funding */
{
  const b = P.budget, max = Math.max(...b.rows.map(r => r.allocation));
  const el = $('#budget');
  el.innerHTML = b.rows.map((r, i) => `
    <div class="row" tabindex="0" data-i="${i}" aria-label="${r.year}: ₹${r.utilisation} crore used of ₹${r.allocation} crore allocated">
      <span class="yr">${r.year}</span>
      <div class="track" style="width:${(r.allocation / max) * 100}%"><div class="fill" style="width:${(r.utilisation / r.allocation) * 100}%"></div></div>
      <div class="val">₹${fmt(r.utilisation, 2)} cr used <span>of ₹${fmt(r.allocation)} cr · ${fmt((r.utilisation / r.allocation) * 100, 1)}%</span></div>
    </div>`).join('') +
    `<div class="row axisrow" aria-hidden="true"><span></span><div class="axis"><span>₹0</span><span>₹${fmt(max)} cr</span></div></div>`;
  const tipFor = r => `<b>${r.year}</b><span class="k">Allocated</span> ₹${fmt(r.allocation, 2)} cr<br><span class="k">Used</span> ₹${fmt(r.utilisation, 2)} cr<br><span class="k">Unspent</span> ₹${fmt(r.allocation - r.utilisation, 2)} cr`;
  el.querySelectorAll('.row[data-i]').forEach(row => {
    const r = b.rows[+row.dataset.i];
    row.addEventListener('pointermove', e => showTip(tipFor(r), e.clientX, e.clientY));
    row.addEventListener('pointerleave', hideTip);
    row.addEventListener('focus', () => { const rc = row.getBoundingClientRect(); showTip(tipFor(r), rc.left + 40, rc.bottom - 8); });
    row.addEventListener('blur', hideTip);
  });
  $('#budget-src').innerHTML = `<a href="${esc(b.url)}" target="_blank" rel="noopener">Lok Sabha Q949</a>, 24 Jul 2026`;
}

/* ------------------------------------------------------------ visit + planned */
{
  const t = P.tourism;
  const museums = t.museums.map(id => byId.get(id)).filter(Boolean).map(s => nice(s.name).replace(/ (Point )?Lighthouse.*$/i, ''));
  $('#visit-note').innerHTML = `<b>${t.count}</b> lighthouses open to the public; <b>${museums.length}</b> with museums: ${esc(museums.join(', '))}. <a href="${esc(t.url)}" target="_blank" rel="noopener">Lok Sabha Q3233</a>`;

  const p = P.planned;
  $('#planned-note').innerHTML = `Work orders issued for ${p.sites.length} lights on NW-2. Rings mark the river ports; exact sites unpublished. <a href="${esc(p.url)}" target="_blank" rel="noopener">Lok Sabha Q3233</a>`;
  $('#planned-list').innerHTML = p.sites.map((s, i) => `<button class="btn" data-planned="${i}">${esc(s.name)}</button>`).join('');
  document.querySelectorAll('[data-planned]').forEach(btn => btn.onclick = () => {
    const s = p.sites[+btn.dataset.planned];
    if (!desktop) setSheet(false);
    map.flyTo({ center: [s.lon, s.lat], zoom: 8.5, pitch: 45, bearing: 0, duration: 2400, essential: true });
  });
}

/* ------------------------------------------------------------------ labels */
const labelsEl = $('#labels');
const labelEls = new Map();
const MAJOR = new Set(S.filter(s => s.navtex || s.museum || s.kind === 'lightvessel' || (s.intensity_cd || 0) > 900000 || /kanyakumari|minicoy-south|aguada|prongs/.test(s.id)).map(s => s.id));
const PLANNED_LABELS = P.planned.sites.map((s, i) => ({ id: 'planned-' + i, name: `${s.name} (planned)`, lat: s.lat, lon: s.lon, planned: true }));
function nice(s) { return s ? s.replace(/\b([A-Z])([A-Z]+)\b/g, (m, a, b) => a + b.toLowerCase()) : s; }
function placeLabels() {
  const on = $('#l-labels').checked;
  const z = map.getZoom();
  const W = labelsEl.clientWidth, H = labelsEl.clientHeight;
  const occupied = [];
  const minMajor = desktop ? 4.6 : 5.2, minAll = desktop ? 6.6 : 7.2;
  const cands = on ? [
    ...S.filter(s => z >= minAll || (MAJOR.has(s.id) && z >= minMajor)),
    ...(z >= 5 ? PLANNED_LABELS : []),
  ] : [];
  cands.sort((a, b) => (MAJOR.has(b.id) - MAJOR.has(a.id)) || ((b.reach_nm || 0) - (a.reach_nm || 0)));
  const keep = new Set();
  const lift = z >= 6.2 && $('#l-towers').checked ? 58 : 0;
  for (const s of cands) {
    const p = map.project([s.lon, s.lat]);
    if (p.x < 0 || p.y < 0 || p.x > W || p.y > H) continue;
    const name = s.planned ? s.name : nice(s.name).replace(/\s+(Lighthouse|Light House|Station).*$/i, '');
    const y = p.y - (s.planned ? 0 : lift);
    const w = name.length * 6.2 + 8, box = [p.x - w / 2, y - 34, p.x + w / 2, y - 16];
    if (occupied.some(o => !(box[2] < o[0] || box[0] > o[2] || box[3] < o[1] || box[1] > o[3]))) continue;
    occupied.push(box);
    keep.add(s.id);
    let el = labelEls.get(s.id);
    if (!el) {
      el = document.createElement(s.planned ? 'div' : 'button');
      el.className = 'lab' + (MAJOR.has(s.id) ? ' major' : '') + (s.navtex ? ' nav' : '') + (s.planned ? ' planned' : '');
      el.textContent = name;
      // map labels are pointer shortcuts (their layer is aria-hidden); keyboard users use Find
      if (!s.planned) { el.type = 'button'; el.tabIndex = -1; el.onclick = () => select(s.id, true); }
      labelsEl.appendChild(el); labelEls.set(s.id, el);
    }
    el.style.left = p.x + 'px'; el.style.top = y + 'px';
  }
  for (const [id, el] of labelEls) if (!keep.has(id)) { el.remove(); labelEls.delete(id); }
}
map.on('move', placeLabels); map.on('resize', placeLabels); map.once('idle', placeLabels);
setTimeout(placeLabels, 800);

/* ----------------------------------------------------------------- picking */
const HIT = desktop ? 22 : 30;              // fingers need a bigger target than a cursor
function nearest(pt) {
  let best = null, bd = HIT;
  for (const s of S) {
    const p = map.project([s.lon, s.lat]);
    const d = Math.hypot(p.x - pt.x, p.y - pt.y);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}
map.on('click', e => {
  const s = nearest(e.point);
  if (s) return select(s.id, true);
  const w = warningAt(e.point);
  if (w) openWarning(w); else closeCard();
});
map.on('mousemove', e => { map.getCanvas().style.cursor = nearest(e.point) || warningAt(e.point) ? 'pointer' : ''; });
$('#search').addEventListener('change', e => {
  const q = e.target.value.trim().toLowerCase();
  const s = S.find(x => x.name.toLowerCase() === q) || S.find(x => x.name.toLowerCase().includes(q));
  if (s) { if (!desktop) setSheet(false); select(s.id, true); }
});

/* -------------------------------------------------------------------- card */
let cardAnim = null;
// Seaward bearing: the mean direction of the open-sea sight lines (sea_mask, one bin per 5°).
function seaBearing(s) {
  const m = s.sea_mask;
  let x = 0, y = 0;
  for (let i = 0; m && i < m.length; i++) if (m[i] === '1') { const a = (i + 0.5) * 5 * Math.PI / 180; x += Math.sin(a); y += Math.cos(a); }
  return x || y ? (Math.atan2(x, y) * 180 / Math.PI + 360) % 360 : 180;
}
// Close-up camera: out at sea, low, looking back at the tower (map bearing = the way the camera faces),
// with the tower framed in the part of the map the card doesn't cover.
function cameraFor(s) {
  const card = $('#card');
  const padding = desktop
    ? { left: 340, right: (card.offsetWidth || 384) + 28, top: 40, bottom: 40 }
    : { left: 0, right: 0, top: 70, bottom: Math.round(card.offsetHeight || innerHeight * 0.58) };
  return { center: [s.lon, s.lat], zoom: s.kind === 'lightvessel' ? 15.4 : 15.8, pitch: 72, roll: 0,
           bearing: (seaBearing(s) + 180) % 360, padding };
}
let lastFocus = null;
function select(id, fly) {
  const s = byId.get(id);
  if (!s) return;
  stopVoyage();
  layer.setSelected(id);
  if (!desktop) setSheet(false);
  if ($('#card').hidden) lastFocus = document.activeElement;       // focus returns here when the card closes
  renderCard(s);
  if (fly) {
    const cam = cameraFor(s);
    if (reduceMotion) map.jumpTo(cam);
    else map.flyTo({ ...cam, duration: 3200, curve: 1.42, essential: true });
  }
  emit('station:view', { id });
}
function closeCard() {
  if ($('#card').hidden) return;
  layer.setSelected(null);
  $('#card').hidden = true;
  cancelAnimationFrame(cardAnim);
  map.easeTo({ padding: BASE_PADDING, duration: reduceMotion ? 0 : 600 });
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
  lastFocus = null;
}
function opticText(s) {
  if (s.kind === 'lightvessel') return 'Light vessel: a ship moored at sea as a floating lighthouse, where no tower can stand. DGLL\'s only one in service. Its LED lantern sits on a trestle above the deck, flashes in place and rides the swell.';
  const sim = s.sim;
  const sector = s.sectored ? ' The ledger gives white and red sectors but not their bearings, so the light is drawn white.' : '';
  if (s.no_ledger) return 'DGLL has no ledger online for this light, so its optic type is unknown and it is drawn flashing in place. Its light and tower details come from the Lighthouse Directory.';
  if (!sim) return '';
  if (sim.mode === 'revolving') {
    const beams = sim.beams.length * sim.groups_per_turn;
    return `Revolving optic, simulated from its Master Ledger: ${beams} beam${beams > 1 ? 's' : ''} ${fmt(sim.width_deg, 1)}° wide (${sim.width_src}), one full turn every ${fmt(sim.rev_s, 1)} s (${sim.rev_src}).${sector}`;
  }
  if (sim.mode === 'fixed') return 'Fixed light: steady, no flashes.' + sector;
  if (s.optic === 'flasher') return `LED flasher or fixed optic (${s.optic_evidence || 'per ledger'}): it flashes in place with the ledger timings and does not rotate.${sector}`;
  return 'The ledger does not say whether the optic rotates, so it is drawn flashing in place with the ledger timings.' + sector;
}
/* Standard light specification: the same rows in the same order for every station, each
   value tagged with where it comes from. */
const SRC = { ledger: ['Ledger', 'DGLL Master Ledger'], derived: ['Derived', 'Computed from other ledger values'],
              directory: ['Directory', 'Lighthouse Directory (Rowlett)'] };
// ledger values are the default and cited in the footer, so only other sources get a tag
const MARK = { derived: '†', directory: '‡' };
const chip = k => MARK[k] ? `<sup class="fn" title="${SRC[k][1]}" aria-label="(${SRC[k][0].toLowerCase()})">${MARK[k]}</sup>` : '';
const footnotes = keys => {
  const used = [...new Set(keys)].filter(k => MARK[k]);
  return used.length ? `<p class="fnote">${used.map(k => `${MARK[k]} ${SRC[k][1]}`).join(' · ')}</p>` : '';
};
const COLOUR_NAME = { W: 'White', R: 'Red', G: 'Green', Y: 'Yellow' };
const KIND_NAME = { Fl: ['flash', 'flashes'], LFl: ['long flash', 'long flashes'], Q: ['quick flash', 'quick flashes'],
                    Oc: ['occulting', 'occultations'], Iso: ['isophase', 'isophase'], F: ['fixed', 'fixed'] };
// one wording for every light, built from the parsed fields: "Fl(2) W 15s · White, 2 flashes every 15 s"
function charText(s) {
  if (!s.ckind) return esc(s.char || '–');
  const n = s.group || 1, [one, many] = KIND_NAME[s.ckind] || [s.ckind, s.ckind];
  const abbr = `${s.ckind}${n > 1 ? `(${n})` : ''} ${s.colour || ''} ${fmt(s.period, 2)}s`;
  const colour = COLOUR_NAME[s.colour] || s.colour || '';
  const words = s.ckind === 'F' ? `${colour}, steady`
    : `${colour}, ${n > 1 ? `${n} ${many}` : one} every ${fmt(s.period, 2)} s`;
  return `<span title="Ledger text: ${esc(s.char || '')}"><b>${abbr}</b> · ${words}</span>`;
}
function lightSpec(s) {
  if (!s.phases) return `<section class="spec"><h3 class="spec-h">${icon('bulb')}Light</h3><p class="note">No light characteristic: radio / DGNSS station.</p></section>`;
  const base = s.no_ledger ? 'directory' : 'ledger';
  const sim = s.sim || {};
  const seq = s.phases.map((v, i) => `${fmt(v, 2)} s ${i % 2 ? 'dark' : 'lit'}`).join(' · ');
  const rows = [
    ['Characteristic', charText(s), base],
    ['Period', `${fmt(s.period, 2)} s`, base],
    ['Sequence', seq, s.phases_src === 'ledger' ? base : 'derived'],
  ];
  if (sim.mode === 'revolving') {
    rows.push(['Optic', 'Revolving lens, sweeps 360°', 'ledger']);
    rows.push(['Rotation', `1 turn every ${fmt(sim.rev_s, 1)} s${sim.rpm ? ` (${fmt(sim.rpm, 3)} rpm)` : ''}`, /^ledger/.test(sim.rev_src || '') ? 'ledger' : 'derived']);
    rows.push(['Beams', `${sim.beams.length * sim.groups_per_turn} beam${sim.beams.length * sim.groups_per_turn > 1 ? 's' : ''}, each ${fmt(sim.width_deg, 1)}° wide`,
               sim.width_src === 'ledger horizontal divergence' ? 'ledger' : 'derived']);
    if (s.panels) rows.push(['Lens panels', s.panels_total ? `${s.panels} lit of ${s.panels_total}` : `${s.panels}`, 'ledger']);
  } else if (sim.mode === 'fixed') {
    rows.push(['Optic', 'Fixed, steady light', base]);
  } else if (s.optic === 'flasher') {
    rows.push(['Optic', 'Flashes in place, does not rotate', 'ledger']);
  } else {
    rows.push(['Optic', 'Not stated; drawn flashing in place', 'derived']);
  }
  if (s.sectored) rows.push(['Sectors', esc(s.sectors_text || 'White and red sectors; bearings not in the ledger, drawn white'), 'ledger']);
  return `<section class="spec"><h3 class="spec-h">${icon('bulb')}Light</h3><dl class="facts">${rows.map(([k, v, src]) => `<dt>${k}</dt><dd>${v}${chip(src)}</dd>`).join('')}</dl>${footnotes(rows.map(r => r[2]))}</section>`;
}

// Brightness on a log scale against every DGLL light that states an intensity, a candle
// (≈1 cd) and one car high-beam lamp (ECE maximum 140,000 cd per lamp).
const HIGH_BEAM_CD = 140000;
const INTENSITIES = lights.map(x => x.intensity_cd).filter(v => v > 0).sort((a, b) => a - b);
function brightnessViz(s) {
  const I = s.intensity_cd;
  if (!I) return `<section class="spec"><h3 class="spec-h">${icon('brightness')}Brightness</h3><p class="note">The ledger states no beam intensity.</p></section>`;
  const W = 320, lo = 0, hi = 8;                       // 10^0 … 10^8 cd
  const x = v => 8 + (Math.log10(Math.max(1, v)) - lo) / (hi - lo) * (W - 16);
  const rank = INTENSITIES.filter(v => v < I).length / INTENSITIES.length;
  const ratio = I / HIGH_BEAM_CD;
  const compare = ratio >= 1.5 ? `as bright as ${fmt(ratio, 0)} car high-beam lamps`
    : ratio >= 0.67 ? 'about as bright as one car high-beam lamp'
    : `${fmt(1 / ratio, 0)}× dimmer than one car high-beam lamp`;
  const ticks = INTENSITIES.map(v => `<line x1="${x(v)}" x2="${x(v)}" y1="22" y2="34" class="t-all"/>`).join('');
  const axis = [1, 100, 1e4, 1e6, 1e8].map(v => `<text x="${x(v)}" y="50" class="t-ax" text-anchor="middle">${v >= 1e6 ? fmt(v / 1e6) + 'M' : v >= 1e3 ? fmt(v / 1e3) + 'k' : v}</text>`).join('');
  return `<section class="spec"><h3 class="spec-h">${icon('brightness')}Brightness ${chip(s.no_ledger ? 'directory' : 'ledger')}</h3>
    <p class="big">${fmt(I)} <small>candela</small></p>
    <p class="note">${compare}; brighter than ${fmt(rank * 100)}% of the ${INTENSITIES.length} DGLL lights that state an intensity.</p>
    ${s.iala_nm && s.lum_nm ? `<p class="note">At night in clear weather this carries <b>${fmt(s.iala_nm, 1)} NM</b> (IALA formula)${
      Math.abs(s.iala_nm - s.lum_nm) / s.lum_nm > 0.3
        ? `, but the ledger states ${fmt(s.lum_nm, 1)} NM: <span class="warn-text">${s.iala_nm < s.lum_nm ? 'the intensity is too low for that range' : 'the range undersells the intensity'}</span>.`
        : `, matching the ledger's ${fmt(s.lum_nm, 1)} NM.`}</p>` : ''}
    <svg viewBox="0 0 ${W} 56" class="viz" role="img" aria-label="${fmt(I)} candela on a log scale of all DGLL lights">
      <line x1="8" x2="${W - 8}" y1="28" y2="28" class="t-base"/>${ticks}
      <line x1="${x(1)}" x2="${x(1)}" y1="16" y2="40" class="t-ref"/><text x="${x(1) + 3}" y="14" class="t-lab">candle</text>
      <line x1="${x(HIGH_BEAM_CD)}" x2="${x(HIGH_BEAM_CD)}" y1="16" y2="40" class="t-ref"/><text x="${x(HIGH_BEAM_CD)}" y="14" class="t-lab" text-anchor="middle">car high beam</text>
      <circle cx="${x(I)}" cy="28" r="5.5" class="t-me"><title>${esc(nice(s.name))}: ${fmt(I)} cd</title></circle>${axis}
    </svg>
    <p class="note fine">Each tick is one lighthouse. Log scale: every step is 100× brighter. A lighthouse only has to reach a sailor's eye across a dark sea (0.2 millionths of a lux), not light a road, so its candela sit near a headlamp's.</p></section>`;
}

// How far out the light is seen: the shorter of its luminous range (brightness, at the IALA
// reference visibility) and its geographical range (the horizon from its height to a 5 m eye).
const REACHES = lights.map(x => x.reach_nm).filter(Boolean).sort((a, b) => a - b);
function reachViz(s) {
  if (!s.lum_nm && !s.geo_nm) return '';
  const max = Math.max(35, Math.ceil(Math.max(s.lum_nm || 0, s.geo_nm || 0) / 5) * 5);
  const W = 320, L = 92, x = nm => L + (nm / max) * (W - L - 10);
  const med = REACHES[Math.floor(REACHES.length / 2)];
  const limit = s.lum_nm && s.geo_nm ? (s.geo_nm < s.lum_nm ? 'the horizon (the curve of the Earth)' : 'its brightness') : null;
  const bar = (y, nm, label, cls, src) => nm ? `<text x="0" y="${y + 9}" class="t-lab2">${label}</text>
      <rect x="${L}" y="${y}" width="${Math.max(2, x(nm) - L)}" height="12" rx="0" class="${cls}"/><text x="${x(nm) + 4}" y="${y + 10}" class="t-val">${fmt(nm, 1)} NM</text>` : '';
  const ticks = [0, max / 2, max].map(v => `<text x="${x(v)}" y="70" class="t-ax" text-anchor="middle">${fmt(v)} NM</text>`).join('');
  return `<section class="spec"><h3 class="spec-h">${icon('ruler')}Reach ${chip(s.no_ledger ? 'directory' : 'ledger')}</h3>
    <p class="big">${fmt(s.reach_nm, 1)} <small>NM · ${fmt(s.reach_nm * 1.852, 0)} km out to sea</small></p>
    ${limit ? `<p class="note">Limited by ${limit}. India's median light reaches ${fmt(med, 1)} NM.</p>` : ''}
    <svg viewBox="0 0 ${W} 76" class="viz" role="img" aria-label="Luminous range ${fmt(s.lum_nm, 1)} NM, geographical range ${fmt(s.geo_nm, 1)} NM">
      ${bar(4, s.lum_nm, 'Brightness', 'r-lum')}${bar(26, s.geo_nm, `Horizon (${fmt(s.elev_m, 0)} m)`, 'r-geo')}
      <line x1="${x(s.reach_nm)}" x2="${x(s.reach_nm)}" y1="0" y2="46" class="r-eff"/>
      <line x1="${x(med)}" x2="${x(med)}" y1="44" y2="52" class="t-ref"/>
      <line x1="${L}" x2="${W - 10}" y1="52" y2="52" class="t-base"/>${ticks}
    </svg>
    <p class="note fine">Brightness range: how far this intensity carries in clear weather (luminous range). Horizon: how far a 5 m eye on a ship can see the lantern over the Earth's curve (geographical range). The light is seen out to the shorter of the two.</p></section>`;
}

// installation years per equipment: the station's own ledger, else the network's first ledger year
function equipSince(s) {
  const names = { navtex: 'NAVTEX', racon: 'RACON', ais: 'AIS', dgps: 'DGNSS' };
  const parts = Object.entries(s.equip_since || {}).filter(([, v]) => v && v.year)
    .map(([k, v]) => `${names[k]} ${v.year}${v.src === 'network' ? '<sup class="fn" aria-label="(network year)">†</sup>' : ''}`);
  const net = Object.values(s.equip_since || {}).some(v => v?.year && v.src === 'network');
  return parts.length ? `<dt>Equipment since</dt><dd>${parts.join(' · ')}${net ? '<small class="fnote">† No date in this ledger: the first year any ledger records that equipment.</small>' : ''}</dd>` : '';
}

function ledgerDetail(s) {
  const o = s.optic_detail || {};
  const rows = [
    ['Optic', [o.make, o.model, o.type, o.size].filter(Boolean).join(' · ')],
    ['Rotation', o.rotation_device], ['Speed', s.rpm ? `${fmt(s.rpm, 3)} rpm` : null],
    ['Panels', s.panels_total ? `${s.panels} active of ${s.panels_total} (ledger: “${s.panels_note}”)` : s.panels], ['Divergence', o.divergence_text], ['Illuminant', o.illuminant],
    ['Sectors', s.sectors_text],
  ].filter(([, v]) => v != null && v !== '');
  if (!rows.length) return '';
  return `<details class="story" open><summary>${icon('doc')}Optic details</summary><dl class="facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl></details>`;
}
// Two kinds of note, kept apart so a routine one never reads like an error:
// sim flags = the ledger's own figures disagree (rpm vs rhythm, panels vs beams, divergence vs flash);
// transcription notes = how an awkward field was read (formats, blanks, misfiled pages).
function ledgerChecks(s) {
  const flags = s.sim?.flags || [], notes = s.ledger_issues || [];
  return (flags.length ? `<div class="check">${icon('alert')}<span>${esc(flags.join('; '))}</span></div>` : '')
    + (notes.length ? `<details class="story"><summary>${icon('list')}Transcription notes (${notes.length})</summary><ul class="tnotes">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></details>` : '');
}
function renderCard(s) {
  const card = $('#card');
  const pill = (cls, ic, label, sub, title) => `<span class="badge ${cls}" title="${esc(title)}">${icon(ic)}${label}${sub ? ` <small>${sub}</small>` : ''}</span>`;
  const kit = [];
  if (s.navtex) kit.push(pill('navtex', 'navtex', 'NAVTEX', `${esc(s.navtex.id_518)} · ${esc(s.navtex.id_490)}`, 'NAVTEX transmitter: ID on 518 kHz · ID on 490 kHz'));
  if (s.racon) kit.push(pill('racon', 'racon', 'RACON', `${esc(s.racon)} ${morseText(s.racon)}`, 'Radar beacon: Morse identifier'));
  if (s.ais) kit.push(pill('ais', 'ais', 'AIS', 'base station', 'National AIS (NAIS) base station'));
  if (s.dgps) kit.push(pill('dgps', 'dgnss', 'DGNSS', '', 'Differential GNSS reference station'));
  if (s.vts) kit.push(pill('vts', 'vts', 'VTS', 'radar', 'Vessel Traffic Service radar, Gulf of Kutch'));
  if (s.museum) kit.push(pill('museum', 'museum', 'Museum', '', 'Lighthouse museum (Lok Sabha Q3233)'));
  if (s.tourism) kit.push(pill('open', 'access', 'Public access', '', 'Developed for public visits (Lok Sabha Q3233)'));
  else if (s.visit === 'open') kit.push(pill('open', 'access', 'Tower open', '', 'Lighthouse Directory: tower open to visitors'));
  if (s.solar) kit.push(pill('solar', 'solar', 'Solar', '', 'Solar power listed in the Master Ledger'));
  const maxR = Math.max(s.lum_nm || 0, s.geo_nm || 0, 1);
  const nx = data.navtex.find(n => n.station === s.id);
  const yr = s.established && s.tower_year && s.established !== s.tower_year
    ? `${s.established} (tower ${s.tower_year})` : (yearOf(s) || '–');
  const photo = s.photo ? (s.photo.includes('commons.wikimedia') ? s.photo.replace(/^http:/, 'https:') + '?width=720' : s.photo) : null;
  card.innerHTML = `
    <button class="close" aria-label="Close">${icon('close')}</button>
    <canvas class="scene card-scene" role="img" aria-label="Pixel scene of ${esc(nice(s.name))} flashing its rhythm"></canvas>
    <div class="body">
      <h2 id="card-title" tabindex="-1">${esc(nice(s.name))}</h2>
      <div class="region">${esc(s.region || '')} directorate · ${s.lat.toFixed(4)}° N, ${s.lon.toFixed(4)}° E</div>
      ${photo ? `<button type="button" class="photo-thumb" aria-label="Open the photo of ${esc(nice(s.name))}" style="background-image:url('${esc(s.photo_local ? `photos/thumb/${s.id}.jpg` : photo)}')"><span>${icon('camera')}${s.photo.includes('dgll') ? 'Photo · DGLL' : 'Photo · Wikimedia Commons'}</span></button>` : ''}
      ${SCANS[s.id] ? `<button type="button" class="btn wide scan-open">${icon('cube')}3D scan · ${SCANS[s.id].photos} photos</button>` : ''}
      ${s.phases ? `<div class="signature"><canvas width="300" height="26" aria-label="Flash signature"></canvas></div>` : ''}
      <div class="badges">${kit.join('')}</div>
      ${stationWarnings(s)}
      ${lightSpec(s)}
      ${brightnessViz(s)}
      ${reachViz(s)}
      ${ledgerChecks(s)}
      ${s.record ? `<button class="btn wide rec-open">${icon('doc')}Full ledger record</button>` : ''}
      <section class="spec"><h3 class="spec-h">${icon('lighthouse')}Station</h3>
      <dl class="facts">
        ${s.tower_type ? `<dt>Tower</dt><dd>${esc(nice(s.tower_type))}${s.tower_h_m && !/\d+(\.\d+)? m/.test(s.tower_type) ? `, ${fmt(s.tower_h_m, 1)} m` : ''}</dd>` : ''}
        ${s.tower_colour && !s.no_ledger ? `<dt>Colours</dt><dd>${esc(nice(s.tower_colour))}</dd>` : ''}
        <dt>Established</dt><dd>${esc(yr)}</dd>
        ${s.address ? `<dt>Address</dt><dd>${esc(s.address)}</dd>` : ''}
        ${equipSince(s)}
        ${s.alol ? `<dt>Admiralty</dt><dd>${esc(s.alol)}${s.arlhs ? ` · ARLHS ${esc(s.arlhs)}` : ''}</dd>` : ''}
        ${nx ? `<dt>NAVTEX slots</dt><dd>${nx.slots_518.map(x => x.slice(0, 2) + ':' + x.slice(2)).join(', ')} UTC</dd>` : ''}
      </dl></section>
      ${tendersSection(s)}
      ${ledgerDetail(s)}
      ${s.rowlett ? `<details class="story"><summary>${icon('book')}History (Lighthouse Directory)</summary><p>${esc(s.rowlett.replace(/[^.]*\bphoto\b[^.]*\.\s*/gi, ''))}</p></details>` : ''}
      <div class="links">
        ${s.page_url ? `<a href="${esc(s.page_url)}" target="_blank" rel="noopener">DGLL page</a>` : ''}
        ${s.ledger_url ? `<a href="${esc(s.ledger_url)}" target="_blank" rel="noopener">Master Ledger (PDF)</a>` : ''}
        ${s.tourism ? `<a href="${esc(P.tourism.url)}" target="_blank" rel="noopener">Lok Sabha Q3233</a>` : ''}
        ${s.wikidata ? `<a href="https://www.wikidata.org/wiki/${esc(s.wikidata)}" target="_blank" rel="noopener">Wikidata</a>` : ''}
        <a href="https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=16/${s.lat}/${s.lon}" target="_blank" rel="noopener">OSM</a>
      </div>
      <p class="note">Position: ${esc(s.pos_src)}.</p>
    </div>`;
  card.hidden = false;
  card.scrollTop = 0;
  card.querySelector('.close').onclick = closeCard;
  card.querySelector('.rec-open')?.addEventListener('click', () => openRecord(s, { icon, esc }));
  card.querySelectorAll('.warn-open').forEach(b => { b.onclick = () => openWarning(b.dataset.key); });
  card.querySelector('.photo-thumb')?.addEventListener('click', () => {
    const m = s.photo_meta || {};
    const dgll = s.photo.includes('dgll');
    openViewer({
      title: nice(s.name),
      subtitle: `${dgll ? 'DGLL' : 'Wikimedia Commons'}${m.w ? ` · original ${m.w} × ${m.h}` : ''}`,
      src: s.photo_local || photo, full: m.full, fullBytes: m.bytes, fullSize: m.w ? `${m.w} × ${m.h}` : '',
      alt: `Photo of ${nice(s.name)}`,
      credit: `Source: <a href="${esc(s.photo)}" target="_blank" rel="noopener">${dgll ? 'DGLL station page' : 'Wikimedia Commons'}</a>, shown from this site's backup.`,
    });
    emit('photo:view', { id: s.id });
  });
  card.querySelector('.scan-open')?.addEventListener('click', () => { openSplat(s, SCANS[s.id], nice(s.name)); emit('scan:view', { id: s.id }); });
  mountScene(card.querySelector('.card-scene'), s, SCENE_OPTS);
  cancelAnimationFrame(cardAnim);
  const cv = card.querySelector('.signature canvas');
  if (cv && s.phases) {
    const g = cv.getContext('2d'), per = s.phases.reduce((a, b) => a + b, 0), win = Math.max(per * 2, 8);
    const col = '#' + COLOUR_MODES.light.fn(s).getHexString();
    const draw = () => {
      const t = layer.clock.value;
      g.clearRect(0, 0, cv.width, cv.height);
      for (let x = 0; x < cv.width; x++) {
        const v = layer.unlit.has(s.id) ? 0 : lightLevel(s.phases, t - win + (x / cv.width) * win);   // unlit per a warning
        if (v > 0.02) { g.globalAlpha = v; g.fillStyle = col; g.fillRect(x, 3, 1, cv.height - 6); }
      }
      g.globalAlpha = 1; g.fillStyle = '#fff'; g.fillRect(cv.width - 2, 0, 2, cv.height);
      cardAnim = requestAnimationFrame(draw);
    };
    draw();
  }
}
// DGLL tenders that name this station, newest first, each linking into the tender archive
const inr = v => v >= 1e7 ? `₹${fmt(v / 1e7, 2)} crore` : v >= 1e5 ? `₹${fmt(v / 1e5, 2)} lakh` : `₹${fmt(v)}`;
function tendersSection(s) {
  const list = s.tenders || [];
  const dirLink = `<a class="btn wide" href="tenders.html?dir=${encodeURIComponent(s.region || '')}">${icon('list')}All ${esc(s.region || '')} tenders</a>`;
  if (!list.length) return `<section class="spec"><h3 class="spec-h">${icon('rupee')}Tenders</h3><p class="note">No DGLL tender names this station.</p>${dirLink}</section>`;
  const rows = list.map(t => `<li><a href="tenders.html#t-${t.nid}">
      <span class="t-date">${esc((t.end || '').slice(0, 7) || '–')}</span>
      <span class="t-title">${esc(t.title)}</span>
      ${t.work ? `<span class="t-work">${esc(t.work)}</span>` : ''}
      ${t.cost ? `<span class="t-cost">${inr(t.cost)}</span>` : ''}</a></li>`).join('');
  return `<section class="spec"><h3 class="spec-h">${icon('rupee')}Tenders <span class="hint">${list.length}</span></h3>
    <ul class="tender-list">${rows}</ul>${dirLink}</section>`;
}
function morseText(l) {
  return morsePhases(l).filter((_, i) => i % 2 === 0).map(d => d > 0.5 ? '—' : '•').join('');
}
addEventListener('keydown', e => { if (e.key === 'Escape') closeCard(); });

/* -------------------------------------------------------------- rhythm wall */
{
  const cv = $('#rhythm'), g = cv.getContext('2d');
  const rows = lights.filter(s => s.phases);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  // Size the drawing buffer from the canvas's CSS box whenever it changes. On phones the sheet starts
  // collapsed, so the first measure is 0 px wide; a 2 × 600 buffer then stretched into a 100,000 px tall
  // strip. The CSS gives the canvas a fixed height; this only follows it.
  const size = () => {
    const W = Math.round(cv.clientWidth * dpr), H = Math.round(cv.clientHeight * dpr);
    if (W > 0 && H > 0 && (cv.width !== W || cv.height !== H)) { cv.width = W; cv.height = H; }
  };
  new ResizeObserver(size).observe(cv);
  let last = 0, acc = 0;
  const tick = now => {
    const dt = (now - last) / 1000; last = now; acc += dt;
    const colW = Math.max(1, Math.round(dpr));
    // skip drawing while the sheet is collapsed: nobody can see it, the phone keeps the battery
    if (acc >= 1 / 22 && cv.offsetParent !== null && cv.width > 2) {
      acc = 0;
      g.globalCompositeOperation = 'copy';
      g.drawImage(cv, -colW, 0);
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = '#000'; g.fillRect(cv.width - colW, 0, colW, cv.height);
      const rh = cv.height / rows.length, t = layer.clock.value;
      rows.forEach((s, i) => {
        const v = layer.bornBy(s, layer.year) && !layer.unlit.has(s.id) ? lightLevel(s.phases, t) : 0;
        if (v < 0.03) return;
        const c = COLOUR_MODES[colourMode].fn(s);
        g.fillStyle = `rgba(${c.r * 255 | 0},${c.g * 255 | 0},${c.b * 255 | 0},${v})`;
        g.fillRect(cv.width - colW, i * rh, colW, Math.max(1, rh - (rh > 2 ? 0.5 : 0)));
      });
      if (layer.selected) {
        const i = rows.findIndex(s => s.id === layer.selected);
        if (i >= 0) { g.fillStyle = '#ffffff55'; g.fillRect(cv.width - colW, i * rh - 1, colW, 1); }
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const rowAt = e => { const r = cv.getBoundingClientRect(); return rows[Math.floor(((e.clientY - r.top) / r.height) * rows.length)]; };
  cv.addEventListener('click', e => { const s = rowAt(e); if (s) select(s.id, true); });
  cv.addEventListener('pointermove', e => {
    const s = rowAt(e);
    if (s) showTip(`<b>${esc(nice(s.name))}</b>${esc(s.char || '')}`, e.clientX, e.clientY); else hideTip();
  });
  cv.addEventListener('pointerleave', hideTip);
}

/* ----------------------------------------------------------------- flights */
document.querySelectorAll('[data-fly]').forEach(b => b.onclick = () => {
  stopVoyage();
  if (!desktop) setSheet(false);
  map.flyTo({ ...VIEWS[b.dataset.fly], duration: 2600, essential: true });
});
$('#lightship').onclick = () => {
  stopVoyage();
  const lv = S.find(s => s.kind === 'lightvessel');
  if (!lv) return;
  select(lv.id, false);
  map.flyTo({ center: [lv.lon, lv.lat], zoom: 13.2, pitch: 64, bearing: -40, duration: 2600, essential: true });
};
let voyage = null, voyageRestore = null;
// flip a layer switch from code and keep the checkbox in step
function setLayerOn(sel, key, on) { const el = $(sel); if (el.checked !== on) { el.checked = on; layer.setVisible({ [key]: on }); } }
function radioAids(on) { setLayerOn('#l-navtex', 'navtex', on); setLayerOn('#l-racon', 'racon', on); }
function stopVoyage() {
  if (!voyage) return;
  clearTimeout(voyage); voyage = null;
  $('#tour').innerHTML = `${icon('route')}Night voyage`;
  if (voyageRestore) { setLayerOn('#l-navtex', 'navtex', voyageRestore.navtex); setLayerOn('#l-racon', 'racon', voyageRestore.racon); voyageRestore = null; }
}
$('#tour').onclick = () => {
  if (voyage) return stopVoyage();
  closeCard();
  if (!desktop) setSheet(false);
  // the voyage starts with lights only; the radio aids come on off Mangalore
  voyageRestore = { navtex: $('#l-navtex').checked, racon: $('#l-racon').checked };
  radioAids(false);
  let i = 0;
  $('#tour').innerHTML = `${icon('stop')}Stop voyage`;
  const hop = () => {
    const { radio, ...cam } = VOYAGE[i % VOYAGE.length];
    if (i % VOYAGE.length === 0) radioAids(false);            // every lap starts dark
    i++;
    map.flyTo({ ...cam, pitch: 64, duration: 5200, curve: 1.2, essential: true });
    voyage = setTimeout(hop, 7600);
    if (radio) setTimeout(() => { if (voyage) radioAids(true); }, 4200);   // as the camera arrives
  };
  hop();
};
map.on('dragstart', stopVoyage);

/* ------------------------------------------------------ navigational warnings */
// NHO's warnings in force (scripts/fetch_warnings.py reads India WINS every 2 h): danger areas hatched,
// point warnings as dots, coloured by hazard. A warning reporting a light unlit or a RACON off switches that
// aid off on the map, and its station card says so. `var`: setYear() runs before this block is reached.
var WARN = { active: [], meta: {}, byKey: new Map(), features: [], opened: false };
var styleReady = false;
const WCAT = {
  firing: ['Firing / danger area', '#ff5a4f'], operations: ['Survey, rig or cable work', '#ffb03a'],
  danger: ['Wreck or danger', '#ff6ad5'], aton: ['Light, buoy or RACON', '#ffd84a'],
  notice: ['Notice to mariners', '#a99bff'], misc: ['Other warning', '#5fc8ff'],
};
const WKIND = { NAVTEX: 'NAVTEX', NAVAREA: 'NAVAREA VIII', 'T&P': 'T&P notice' };
const EFFECT_TEXT = { unlit: 'light reported unlit', racon_off: 'RACON off air', dgnss_off: 'DGNSS off air', ais_off: 'AIS off air', racon_new: 'new RACON on trial' };
const WARN_LAYERS = ['warn-fill', 'warn-line', 'warn-point', 'warn-mark'];
var WICONS = null;
async function warningIcons() {
  if (!WICONS) WICONS = await fetch('data/warning_icons.json?v=1').then(r => r.json()).catch(() => ({}));
  return WICONS;
}
// map marker: the warning's 16 × 16 pixel icon, dark on a square of its hazard colour
function badgeImage(d, colour) {
  const n = 18, cv = document.createElement('canvas');
  cv.width = cv.height = n;
  const g = cv.getContext('2d');
  g.fillStyle = '#05060a'; g.fillRect(0, 0, n, n);
  g.fillStyle = colour; g.fillRect(1, 1, n - 2, n - 2);
  g.fillStyle = '#05060a'; g.translate(1, 1); g.fill(new Path2D(d));
  return g.getImageData(0, 0, n, n);
}
const wicon = (name, cls = '') => `<svg class="i wi ${cls}" aria-hidden="true"><use href="warning-icons.svg?v=1#w-${name || 'misc'}"/></svg>`;

function warnBBox(g) {
  const pts = g.type === 'Point' ? [g.coordinates] : g.type === 'MultiPoint' ? g.coordinates : g.coordinates.flat();
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
async function loadWarnings() {
  try {
    const d = await fetch(`data/warnings.json?t=${Math.floor(Date.now() / 600000)}`).then(r => r.json());
    WARN.active = d.active || [];
    WARN.meta = d.meta || {};
    WARN.byKey = new Map(WARN.active.map(w => [w.key, w]));
    // one map feature per event: NHO usually issues the same warning as NAVTEX and as NAVAREA VIII
    const rank = { NAVTEX: 0, NAVAREA: 1, 'T&P': 2 }, groups = new Map();
    for (const w of WARN.active) {
      if (!w.geometry) continue;
      const g = groups.get(w.group);
      if (!g || rank[w.kind] < rank[g.kind]) groups.set(w.group, w);
    }
    WARN.features = [...groups.values()].map(w => ({ type: 'Feature', geometry: w.geometry, bbox: warnBBox(w.geometry),
      properties: { key: w.key, category: w.category, tp: w.kind === 'T&P' ? 1 : 0 } }));
    // one icon marker per event: on the point, or in the middle of an area
    WARN.marks = [...groups.values()].map(w => {
      const g = w.geometry, ring = g.type === 'Polygon' ? g.coordinates[0].slice(0, -1) : null;
      const at = g.type === 'Point' ? g.coordinates : g.type === 'MultiPoint' ? g.coordinates[0]
        : [ring.reduce((a, p) => a + p[0], 0) / ring.length, ring.reduce((a, p) => a + p[1], 0) / ring.length];
      const ic = w.plain?.icon || 'misc';
      return { type: 'Feature', geometry: { type: 'Point', coordinates: at },
               properties: { key: w.key, tp: w.kind === 'T&P' ? 1 : 0, icon: ic, category: w.category, img: `wi-${ic}-${w.category}` } };
    });
    await warningIcons();
    const o = WARN.meta.outages || {};
    layer.setOutages({ unlit: o.unlit || [], racon: o.racon_off || [] });
    const f = WARN.meta.in_force || {};
    const checked = WARN.meta.last_live_fetch ? `, checked ${WARN.meta.last_live_fetch.slice(11, 16)} UTC` : '';
    $('#warn-count').textContent = (f.NAVTEX || 0) + (f.NAVAREA || 0);
    $('#warn-note').textContent = `${f.NAVTEX || 0} NAVTEX · ${f.NAVAREA || 0} NAVAREA in force${checked}`;
    $('#tp-note').textContent = `${f['T&P'] || 0} in force`;
    const counts = {};
    for (const ft of WARN.features) if (!ft.properties.tp) counts[ft.properties.category] = (counts[ft.properties.category] || 0) + 1;
    $('#warn-legend').innerHTML = Object.entries(WCAT).filter(([k]) => counts[k])
      .map(([k, [l, c]]) => `<span><i style="background:${c}"></i>${l} ${counts[k]}</span>`).join('');
    addWarningLayers();
    if (!WARN.opened && location.hash.startsWith('#warning=')) { WARN.opened = true; openWarning(decodeURIComponent(location.hash.slice(9))); }
  } catch (e) {
    $('#warn-note').textContent = 'warnings unavailable right now';
  }
}
function hatchImage(color) {
  const n = 8, cv = document.createElement('canvas');
  cv.width = cv.height = n;
  const g = cv.getContext('2d');
  g.fillStyle = color;
  g.globalAlpha = 0.14; g.fillRect(0, 0, n, n);
  g.globalAlpha = 0.95; for (let i = 0; i < n; i++) g.fillRect(i, n - 1 - i, 1, 1);   // one pixel diagonal per tile
  return g.getImageData(0, 0, n, n);
}
function addWarningLayers() {
  if (!styleReady) return;
  const data = { type: 'FeatureCollection', features: WARN.features };
  const marks = { type: 'FeatureCollection', features: WARN.marks || [] };
  for (const f of marks.features) {         // pixelRatio 0.5: one icon pixel = 2 × 2 CSS px, like the half-resolution map
    const { img, icon: ic, category } = f.properties;
    if (!map.hasImage(img) && WICONS?.[ic]) map.addImage(img, badgeImage(WICONS[ic], (WCAT[category] || WCAT.misc)[1]), { pixelRatio: 0.5 });
  }
  if (map.getSource('warnings')) {
    map.getSource('warnings').setData(data);
    map.getSource('warning-marks')?.setData(marks);
    applyWarningVisibility();
    return;
  }
  for (const [k, [, c]] of Object.entries(WCAT)) if (!map.hasImage(`hatch-${k}`)) map.addImage(`hatch-${k}`, hatchImage(c));
  map.addSource('warnings', { type: 'geojson', data });
  const colour = ['match', ['get', 'category'], ...Object.entries(WCAT).flatMap(([k, [, c]]) => [k, c]), '#5fc8ff'];
  const before = map.getLayer('lighthouses-3d') ? 'lighthouses-3d' : undefined;     // beams draw over warnings
  map.addLayer({ id: 'warn-fill', type: 'fill', source: 'warnings', paint: { 'fill-pattern': ['concat', 'hatch-', ['get', 'category']] } }, before);
  map.addLayer({ id: 'warn-line', type: 'line', source: 'warnings',
    paint: { 'line-color': colour, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1, 10, 2.5] } }, before);
  map.addLayer({ id: 'warn-point', type: 'circle', source: 'warnings', maxzoom: 5.5,
    paint: { 'circle-color': colour, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3, 10, 6],
             'circle-stroke-color': '#05060a', 'circle-stroke-width': 2, 'circle-pitch-alignment': 'map' } }, before);
  // closer in, every warning shows its icon: firing, wreck, buoy, rig, cable, survey …
  map.addSource('warning-marks', { type: 'geojson', data: marks });
  map.addLayer({ id: 'warn-mark', type: 'symbol', source: 'warning-marks', minzoom: 5.5,
    layout: { 'icon-image': ['get', 'img'], 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-pitch-alignment': 'viewport' } }, before);
  applyWarningVisibility();
}
function applyWarningVisibility() {
  if (!styleReady || !map.getLayer('warn-fill')) return;
  const nav = $('#l-warn').checked, tp = $('#l-tp').checked;
  const kinds = ['in', ['get', 'tp'], ['literal', [...(nav ? [0] : []), ...(tp ? [1] : [])]]];
  const poly = ['==', ['geometry-type'], 'Polygon'];
  const pt = ['any', ['==', ['geometry-type'], 'Point'], ['==', ['geometry-type'], 'MultiPoint']];
  map.setFilter('warn-fill', ['all', poly, kinds]);
  map.setFilter('warn-line', ['all', poly, kinds]);
  map.setFilter('warn-point', ['all', pt, kinds]);
  if (map.getLayer('warn-mark')) map.setFilter('warn-mark', kinds);
  // warnings in force belong to today, not to a year picked on the history slider
  const on = (nav || tp) && layer.year >= new Date().getFullYear();
  for (const id of WARN_LAYERS) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
}
$('#l-warn').addEventListener('change', applyWarningVisibility);
$('#l-tp').addEventListener('change', applyWarningVisibility);
function warningAt(pt) {
  if (!map.getLayer('warn-fill') || map.getLayoutProperty('warn-fill', 'visibility') === 'none') return null;
  const f = map.queryRenderedFeatures([[pt.x - 6, pt.y - 6], [pt.x + 6, pt.y + 6]], { layers: WARN_LAYERS });
  const hit = f.find(x => x.layer.id === 'warn-mark') || f.find(x => x.layer.id === 'warn-point') || f[0];
  return hit ? hit.properties.key : null;
}
function openWarning(key) {
  const w = WARN.byKey.get(key);
  if (!w) return;
  stopVoyage();
  layer.setSelected(null);
  if (!desktop) setSheet(false);
  if ($('#card').hidden) lastFocus = document.activeElement;
  renderWarningCard(w);
  if (w.geometry) {
    const b = warnBBox(w.geometry), card = $('#card');
    const padding = desktop ? { left: 360, right: (card.offsetWidth || 384) + 40, top: 70, bottom: 70 }
      : { left: 24, right: 24, top: 90, bottom: Math.round(card.offsetHeight || innerHeight * 0.58) + 16 };
    const duration = reduceMotion ? 0 : 2000;
    if (b[0] === b[2] && b[1] === b[3]) map.flyTo({ center: [b[0], b[1]], zoom: Math.max(map.getZoom(), 9.5), padding, duration, essential: true });
    else map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding, maxZoom: 11, duration, essential: true });
  }
  emit('warning:view', { key });
}
function renderWarningCard(w) {
  const card = $('#card');
  cancelAnimationFrame(cardAnim);
  const [label, colour] = WCAT[w.category] || WCAT.misc;
  const related = WARN.active.filter(x => x.group === w.group && x.key !== w.key);
  const passed = w.cancel_at && w.cancel_at < new Date().toISOString();
  const row = (k, v) => (v ? `<dt>${k}</dt><dd>${v}</dd>` : '');
  const short = id => nice(byId.get(id)?.name || id).replace(/\s+(Lighthouse|Light House).*$/i, '');
  const p = w.plain || {};
  card.innerHTML = `
    <button class="close" aria-label="Close">${icon('close')}</button>
    <div class="body">
      <div class="warn-head" style="--c:${colour}">${wicon(p.icon)}<div>
        <h2 id="card-title" tabindex="-1">${esc(p.title || `${WKIND[w.kind] || w.kind} ${w.identifier}`)}</h2>
        <div class="region">${esc(WKIND[w.kind] || w.kind)} ${esc(w.identifier)} · ${esc([w.area, w.place].filter(Boolean).join(' · ') || label)}</div>
      </div></div>
      <div class="badges">
        <span class="badge warn-cat" style="--c:${colour}">${icon('alert')}${esc(label)}</span>
        <span class="badge">${passed ? 'Cancel time passed' : 'In force'}</span>
      </div>
      <section class="spec"><h3 class="spec-h">${icon('info')}What it means</h3>
        <p class="plain">${esc(p.summary || w.message)}</p>
        ${(p.when || []).length ? `<ul class="when">${p.when.map(x => `<li>${icon('clock')}<span>${esc(x)}</span></li>`).join('')}</ul>` : ''}
        ${p.advice ? `<p class="advice">${icon('alert')}<span>${esc(p.advice)}</span></p>` : ''}
      </section>
      <details class="spec original"><summary>${icon('doc')}Original warning, as issued</summary><p class="warn-msg">${esc(w.message)}</p></details>
      <section class="spec"><h3 class="spec-h">${icon('list')}Details</h3><dl class="facts">
        ${row('Issued', esc(w.dtg || w.issued))}
        ${row('Broadcast', w.b_char ? `${esc(w.b_char)}${(w.navtex_stations || []).length ? ` · ${esc(w.navtex_stations.map(short).join(', '))}` : ''}` : '')}
        ${row('Also issued as', related.map(r => `<button type="button" class="linkish warn-open" data-key="${esc(r.key)}">${esc(WKIND[r.kind])} ${esc(r.identifier)}</button>`).join(', '))}
        ${row('Cancels itself', w.cancel_at ? esc(`${w.cancel_at.slice(0, 16).replace('T', ' ')} UTC`) : '')}
        ${row('Charts', esc((w.charts || []).join(' ')))}
        ${row('Effect', esc((w.effects || []).map(e => EFFECT_TEXT[e] || e).join(', ')))}
        ${row('Lighthouse', (w.stations || []).map(id => `<button type="button" class="linkish st-open" data-id="${esc(id)}">${esc(nice(byId.get(id)?.name || id))}</button>`).join(', '))}
        ${row('First listed here', esc((w.first_seen || '').slice(0, 10)))}
      </dl></section>
      <div class="links">
        <a href="${esc(w.link)}" target="_blank" rel="noopener">NHO India WINS</a>
        <a href="warnings.html#w-${esc(w.key.replace(/[^\w-]/g, '_'))}">Warning archive</a>
      </div>
      <p class="note fine">The plain-language version is written automatically from NHO's text; the original warning is the authority. Not for navigation: use the official broadcast and Notices to Mariners.</p>
    </div>`;
  card.hidden = false;
  card.scrollTop = 0;
  card.querySelector('.close').onclick = closeCard;
  card.querySelectorAll('.warn-open').forEach(b => { b.onclick = () => openWarning(b.dataset.key); });
  card.querySelectorAll('.st-open').forEach(b => { b.onclick = () => select(b.dataset.id, true); });
}
// on a station card: the warnings in force that concern it, one line per event
function stationWarnings(s) {
  const seen = new Set();
  const list = WARN.active.filter(w => (w.stations || []).includes(s.id) && !seen.has(w.group) && seen.add(w.group));
  if (!list.length) return '';
  return `<div class="check warn-check" role="note">${icon('alert')}<div><b>Navigational warning in force</b><ul>${list.map(w =>
    `<li><button type="button" class="linkish warn-open" data-key="${esc(w.key)}">${esc(WKIND[w.kind])} ${esc(w.identifier)}</button>: ${
      esc(w.plain?.title || (w.effects || []).map(e => EFFECT_TEXT[e]).filter(Boolean).join(', ') || `${w.message.slice(0, 90)}…`)}${w.issued ? `, since ${esc(w.issued)}` : ''}</li>`).join('')}</ul></div></div>`;
}
loadWarnings();
setInterval(loadWarnings, 10 * 60 * 1000);

/* ------------------------------------------------------- picture & video */
// The legend a saved picture or video carries: only what is switched on, in view, and visible at this
// zoom and year. record.js draws it and fades rows in and out as the scene changes during a take.
function mediaLegend() {
  const b = map.getBounds(), z = map.getZoom(), yr = layer.year;
  const inView = (lon, lat, pad = 0) => lon >= b.getWest() - pad && lon <= b.getEast() + pad && lat >= b.getSouth() - pad && lat <= b.getNorth() + pad;
  const shown = lights.filter(s => inView(s.lon, s.lat) && layer.bornBy(s, yr));
  const hex = c => '#' + c.getHexString();
  const items = [];
  const beams = $('#l-beams').checked;
  if (shown.length) {
    const fn = COLOUR_MODES[colourMode].fn;
    const group = (id, test, label) => { const s = shown.find(test); if (s) items.push({ id, type: 'swatch', color: hex(fn(s)), label }); };
    if (colourMode === 'light') {
      group('c-w', s => (s.colour || 'W') === 'W', 'White light');
      group('c-r', s => s.colour === 'R', 'Red light');
      group('c-g', s => s.colour === 'G', 'Green light');
    } else if (colourMode === 'tech') {
      group('t-n', s => s.navtex, 'Light with NAVTEX');
      group('t-r', s => !s.navtex && s.racon, 'Light with RACON');
      group('t-l', s => !s.navtex && !s.racon, 'Light only');
    } else if (colourMode === 'age') {
      items.push({ id: 'age', type: 'ramp', colors: [1840, 1885, 1930, 1975, 2020].map(y => hex(ageRamp(y))), label: 'Year lit: 1840 to 2020' });
    } else if (colourMode === 'visit') {
      group('v-m', s => s.museum, 'Museum');
      group('v-p', s => s.tourism && !s.museum, 'Public access');
      group('v-n', s => !s.tourism, 'No public access');
    }
    if (beams && shown.some(s => s.sim?.mode === 'revolving')) items.push({ id: 'sweep', type: 'wedge', color: '#ffe27a', label: 'Revolving beam, ledger rotation' });
    if (beams && shown.some(s => s.phases && s.sim?.mode !== 'revolving')) items.push({ id: 'flash', type: 'dots', color: '#ffe27a', label: 'Flashes in place' });
    if (beams && z < 11.5) items.push({ id: 'reach', type: 'swatch', color: '#6b5426', label: 'Reach at sea (luminous range)' });
    if (beams && z >= 7 && shown.some(s => s.screen_mask)) items.push({ id: 'screen', type: 'wedge', color: '#454b57', label: 'Dark arc: lantern screened' });
    if ($('#l-towers').checked && z >= 6.2) items.push({ id: 'tower', type: 'block', color: '#c23b2b', label: 'Tower: ledger type and colours' });
    if (shown.some(s => s.kind === 'lightvessel')) items.push({ id: 'vessel', type: 'block', color: '#d23a2a', label: 'Light vessel' });
  }
  if ($('#l-navtex').checked && z < 12) {
    const nav = data.navtex.filter(n => (!n.since || yr >= n.since) && inView(n.lon, n.lat, 4.2));
    if (nav.length) {
      const live = navtexStatus().liveNames.find(x => nav.some(n => x.startsWith(n.name)));
      items.push({ id: 'navtex', type: 'ring', color: hex(COLOURS.navtex), label: `NAVTEX broadcast, 250 NM${live ? ` · on air: ${live.split(' (')[0]}` : ''}` });
    }
  }
  if ($('#l-racon').checked && z < 12 && shown.some(s => s.racon && !(s.equip_since?.racon?.year > yr)))
    items.push({ id: 'racon', type: 'ring', color: hex(COLOURS.racon), label: 'RACON radar beacon, Morse ID' });
  if (z >= 5 && P.planned.sites.some(s => inView(s.lon, s.lat))) items.push({ id: 'planned', type: 'ring', color: '#d9a066', label: 'Planned light (Brahmaputra)' });
  if ($('#l-base').checked && z >= 14) items.push({ id: 'buildings', type: 'block', color: '#52627a', label: 'Buildings, OpenStreetMap heights' });
  if (shown.some(s => layer.unlit.has(s.id))) items.push({ id: 'unlit', type: 'swatch', color: '#454b57', label: 'Light reported unlit (warning)' });
  if (styleReady && map.getLayer('warn-fill') && map.getLayoutProperty('warn-fill', 'visibility') !== 'none') {
    const nav = $('#l-warn').checked, tp = $('#l-tp').checked;
    const cats = new Set(WARN.features.filter(f => (f.properties.tp ? tp : nav) && f.bbox[2] >= b.getWest() && f.bbox[0] <= b.getEast()
      && f.bbox[3] >= b.getSouth() && f.bbox[1] <= b.getNorth()).map(f => f.properties.category));
    for (const [k, [l, c]] of Object.entries(WCAT)) if (cats.has(k)) items.push({ id: `w-${k}`, type: 'swatch', color: c, label: `Warning: ${l}` });
  }
  return items;
}
{
  const capture = createCapture({
    map,
    cropLeft: () => (desktop ? 340 : 0),                  // the desktop panel covers the map's left edge
    year: () => $('#wm-year').textContent,
    subtitle: () => (!$('#history-caption').hidden && $('#history-caption').textContent) || 'Lighthouses of India',
    legend: mediaLegend,
    // pictures and videos open in the viewer first: look, then save or share
    onMedia: m => openViewer({ title: m.kind === 'image' ? 'Picture of the map' : 'Video of the map', subtitle: m.name,
                               blob: m.blob, kind: m.kind, filename: m.name }),
    onState: st => {
      if ('recording' in st) {
        $('#rec-badge').hidden = !st.recording;
        $('#cap-rec').setAttribute('aria-pressed', String(!!st.recording));
        $('#cap-rec').classList.toggle('on', !!st.recording);
        $('#cap-rec').innerHTML = icon(st.recording ? 'stop' : 'record');
        $('#cap-rec').title = st.recording ? 'Stop recording' : 'Record a video of the map';
        if (st.recording) {
          const s = Math.floor(st.seconds || 0);
          $('#rec-time').textContent = `REC ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} / ${Math.floor(capture.maxSeconds / 60)}:${String(capture.maxSeconds % 60).padStart(2, '0')}`;
        }
      }
      if (st.note) {
        const n = $('#cap-note');
        n.textContent = st.note; n.classList.toggle('warn', !!st.warn); n.hidden = false;
        clearTimeout(n._t); n._t = setTimeout(() => { n.hidden = true; }, 6000);
      }
    },
  });
  $('#cap-shot').onclick = () => capture.snapshot();
  $('#cap-rec').onclick = () => { if (!desktop) setSheet(false); capture.toggleRecording(); };
}

// deep links: #station-slug
if (location.hash.length > 1 && byId.has(location.hash.slice(1))) setTimeout(() => select(location.hash.slice(1), true), 600);
