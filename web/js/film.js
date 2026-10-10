// A scripted film of the map: a close-up of each lighthouse on one coast, with an info box on top.
// Loaded only for ?film (see scripts/film.mjs, which drives it frame by frame in headless Chrome).
//
// The map animates in real time, and this server has no GPU, so frames are rendered one at a time
// against a virtual clock (the page's performance.now and requestAnimationFrame are replaced by the
// driver). Every frame is therefore complete: tiles and 3D buildings have loaded before it is kept,
// and the video runs at its true speed however slowly the frames were drawn.
// Each frame is the same composite as a saved picture (record.js: map, names, legend, credit band) plus
// the info box drawn by `overlay` below.

// Tamil Nadu's lights in order along the coast: round the south, up the Bay of Bengal side.
// (Karaikal and Puducherry are in the Union Territory of Puducherry, so they are not here.)
export const TAMIL_NADU = [
  'muttom-point-lighthouse-and-navtex-station', 'kanyakumari-lighthouse', 'kuthenkuli-lighthouse', 'manapad-point-lighthouse',
  'pandiyan-tivu-lighthouse-and-dgps-station', 'vembar-lighthouse', 'kilakkarai-lighthouse', 'pamban-lighthouse', 'olakuda-lighthouse',
  'dhanushkodi-lighthouse', 'passipattinam-lighthouse', 'ammapattinam-lighthouse', 'mallipattinam-lighthouse', 'kodikkarai-lighthouse',
  'point-calimere-lighthouse', 'nagapattinam-lighthouse-and-dgps-station', 'poompuhar-lighthouse', 'portonovo-lighthouse-and-navtex-station',
  'cuddalore-lighthouse', 'kadapakkam-lighthouse', 'mahabalipuram-lighthouse', 'chennai-lighthouse', 'pulicat-lighthouse-and-dgps-station',
];

// One line of history each, only what DGLL's ledgers or the Lighthouse Directory (Rowlett) state.
// The dates shown above it come from the data: established = first light at the station, tower_year = present tower.
const NOTES = {
  'muttom-point-lighthouse-and-navtex-station': 'Mast and post lights came first, then a granite tower in 1875. A rotating 2nd-order Fresnel lens is in use.',
  'kanyakumari-lighthouse': 'Marks the southern tip of India, which the British charted as Cape Comorin.',
  'kuthenkuli-lighthouse': 'One of the newest towers on the coast: 45 m, with an LED optic.',
  'manapad-point-lighthouse': 'Stands beside a church the Portuguese founded in 1581, on a cape south of Tiruchendur.',
  'pandiyan-tivu-lighthouse-and-dgps-station': 'First a light on a flag post, then an 11 m masonry obelisk, then a lighthouse in 1935. On the island that shelters Thoothukudi harbour.',
  'vembar-lighthouse': 'An octagonal concrete tower just off the beach at Vembar, at the northern edge of Thoothukudi district.',
  'kilakkarai-lighthouse': 'A hexagonal concrete tower on the northern shore of the Gulf of Mannar.',
  'pamban-lighthouse': 'Replaced the original 17 m stone tower, listed as "Palk Bay" in 1879. Stands on Pamban Island, along Rama\'s Bridge.',
  'olakuda-lighthouse': 'Built under the Palk Strait Lighthouse Project, near Rameswaram.',
  'dhanushkodi-lighthouse': 'Inaugurated in May 2022. A red and white chequered tower with an observation room, near the end of Adam\'s Bridge.',
  'passipattinam-lighthouse': 'Built under the Palk Strait Lighthouse Project, on the west side of Palk Strait.',
  'ammapattinam-lighthouse': 'A 45 m tower on the Palk Strait coast.',
  'mallipattinam-lighthouse': 'The first Indian lighthouse painted in red and white vertical stripes.',
  'kodikkarai-lighthouse': 'Kodikkarai is the Tamil name of Point Calimere. Its lantern was used earlier at Pulicat.',
  'point-calimere-lighthouse': 'A short 16 m tower near the Point Calimere wildlife sanctuary coast.',
  'nagapattinam-lighthouse-and-dgps-station': 'The British built a 20 m tower here in 1846, replaced by a 23 m tower in 1870, then by the present one.',
  'poompuhar-lighthouse': 'An octagonal tower with an observation level below the lantern, painted in red and white vertical stripes.',
  'portonovo-lighthouse-and-navtex-station': 'The 2004 tsunami hit this coast hard. Porto Novo was named by Portuguese sailors.',
  'cuddalore-lighthouse': 'A British-era tower: white, with a red lantern dome.',
  'kadapakkam-lighthouse': 'Placed in service in November 2013, close to the 1760 Alamparai Fort.',
  'mahabalipuram-lighthouse': 'An unpainted stone tower beside the Shore Temple, still using its 2nd-order Fresnel lens.',
  'chennai-lighthouse': 'The coast\'s first light, shown in 1796. Waves from the 2004 tsunami damaged the base of the present tower.',
  'pulicat-lighthouse-and-dgps-station': 'Opened to visitors for the first time in January 2014, at the entrance to Pulicat Lake.',
};

const FPS = 12;                        // the map's pixel effects step at 12 fps anyway
const HOLD_S = 3.4;                    // time on each lighthouse once the camera arrives
const COLOUR_WORD = { W: 'white', R: 'red', G: 'green', Y: 'yellow' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const titleCase = n => n.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/\bDgps\b/, 'DGPS').replace(/\bNavtex\b/, 'NAVTEX');
// "Chennai Lighthouse"; the equipment that shares the site is listed in the technical line instead
const shortName = n => titleCase(n).replace(/\s+(and\s+)?(NAVTEX|DGPS)(\s+and\s+(NAVTEX|DGPS))?\s+Station$/i, '').replace(/\s+&\s+VTS station$/i, '');

function describe(s, idx, total) {
  const est = s.established, ty = s.tower_year;
  let when;
  if (est && ty && ty !== est) when = `First lit ${est} · present tower ${ty}`;
  else if (ty || est) when = `Built ${ty || est}`;
  else when = 'Date not given';
  const sim = s.sim || {};
  const parts = [];
  if (s.ckind) parts.push(`${s.ckind}${s.group > 1 ? `(${s.group})` : ''} ${s.colour || ''} ${s.period} s`.replace(/\s+/g, ' '));
  if (s.lum_nm) parts.push(`${s.lum_nm} NM range`);
  if (s.elev_m) parts.push(`light ${Math.round(s.elev_m)} m up`);
  if (s.tower_h_m) parts.push(`tower ${Math.round(s.tower_h_m * 10) / 10} m`);
  parts.push(sim.mode === 'revolving' ? `revolving optic, 1 turn / ${Math.round(sim.rev_s)} s` : s.optic === 'flasher' ? 'LED flasher' : 'flashing optic');
  const radio = [];
  if (s.racon) radio.push(`RACON ${s.racon}`);
  if (s.navtex || /navtex/i.test(s.name)) radio.push('NAVTEX');
  if (s.dgps || /dgps/i.test(s.name)) radio.push('DGPS');
  if (s.ais) radio.push('AIS');
  return { name: shortName(s.name), idx, total, when, note: NOTES[s.id] || '', tech: parts, radio };
}

// word-wrap `text` into lines no wider than `max`
function wrap(ctx, text, max) {
  const lines = []; let line = '';
  for (const w of text.split(/\s+/)) {
    const t = line ? `${line} ${w}` : w;
    if (line && ctx.measureText(t).width > max) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

function drawBox(ctx, w, h, s, info, a) {
  if (a <= 0) return;
  const W = Math.min(w - 40 * s, 520 * s), pad = 12 * s, x0 = Math.round((w - W) / 2), y0 = Math.round(12 * s);
  ctx.save();
  ctx.globalAlpha = a;
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  const F = (wt, px, fam = 'Inter') => `${wt} ${Math.round(px * s)}px ${fam}, system-ui, sans-serif`;
  // measure first, so the box fits its text
  ctx.font = F(400, 12.5);
  const noteLines = info.note ? wrap(ctx, info.note, W - pad * 2) : [];
  ctx.font = F(500, 11.5);
  const chips = [...info.tech.map(t => [t, '#e6ecf1']), ...info.radio.map(t => [t, '#3fd6ff'])];
  const gap = 6 * s, ch = 20 * s, cp = 7 * s;
  const rows = []; let row = [], rw = 0;
  for (const c of chips) {
    const cw = ctx.measureText(c[0]).width + cp * 2;
    if (row.length && rw + cw + gap > W - pad * 2) { rows.push(row); row = []; rw = 0; }
    row.push([...c, cw]); rw += cw + gap;
  }
  if (row.length) rows.push(row);
  const H = pad + 28 * s + 20 * s + noteLines.length * 17 * s + (noteLines.length ? 6 * s : 0) + rows.length * (ch + 5 * s) + pad - 5 * s;

  ctx.fillStyle = 'rgba(8,11,18,.9)'; ctx.fillRect(x0, y0, W, H);
  ctx.strokeStyle = '#05060a'; ctx.lineWidth = 3 * s; ctx.strokeRect(x0, y0, W, H);
  ctx.fillStyle = '#ffd84a'; ctx.fillRect(x0, y0, W, 3 * s);                // gold lip, like the panels
  let y = y0 + pad + 22 * s;
  ctx.fillStyle = '#fff'; ctx.font = F(700, 22, '"Pixelify Sans"');
  ctx.fillText(info.name, x0 + pad, y);
  if (info.total) {
    ctx.font = F(600, 12); ctx.fillStyle = '#9aa3bb'; ctx.textAlign = 'right';
    ctx.fillText(`${info.idx} of ${info.total}`, x0 + W - pad, y - 4 * s); ctx.textAlign = 'left';
  }
  y += 20 * s;
  ctx.font = F(600, 13.5); ctx.fillStyle = '#ffd84a';
  ctx.fillText(info.when, x0 + pad, y);
  y += 6 * s;
  ctx.font = F(400, 12.5); ctx.fillStyle = '#d6dce8';
  for (const l of noteLines) { y += 17 * s; ctx.fillText(l, x0 + pad, y); }
  y += noteLines.length ? 6 * s : 0;
  ctx.font = F(500, 11.5);
  for (const r of rows) {
    let x = x0 + pad;
    for (const [t, col, cw] of r) {
      ctx.fillStyle = '#161c2a'; ctx.fillRect(x, y, cw, ch);
      ctx.strokeStyle = col === '#e6ecf1' ? '#3a4458' : col; ctx.lineWidth = Math.max(1, 1.5 * s); ctx.strokeRect(x, y, cw, ch);
      ctx.fillStyle = col; ctx.fillText(t, x + cp, y + ch / 2 + 4 * s);
      x += cw + gap;
    }
    y += ch + 5 * s;
  }
  ctx.restore();
}

export function init({ map, layer, S, byId, capture, setLayerOn, seaBearing, onOverlay, onSubtitle }) {
  const stations = TAMIL_NADU.map(id => byId.get(id)).filter(Boolean);
  const OVERVIEW = { center: [79.15, 10.0], zoom: 6.7, pitch: 38, bearing: 0 };
  const PAD = { left: 0, right: 0, top: 290, bottom: 16 };
  const CAM_ANGLE = 28;                                  // degrees off the straight-on view: an acute angle shows the tower's depth, with the sea behind it

  let shot = null, shotT = 0, prev = null;             // current shot, its time in s, and the box of the one before
  onSubtitle(() => 'Lighthouses of Tamil Nadu');

  // zoom so the tower stands about 200 px tall: metres per CSS px = 78271.5 × cos(lat) / 2^zoom
  const zoomFor = s => Math.max(16.5, Math.min(19.2, Math.log2(200 * 78271.5 * Math.cos(s.lat * Math.PI / 180) / ((s.tower_h_m || 30) * 0.94))));
  const camFor = s => ({ center: [s.lon, s.lat], zoom: zoomFor(s), pitch: 72, roll: 0, padding: PAD,
                         bearing: (seaBearing(s) + CAM_ANGLE) % 360 });     // from the land side, looking out to sea past the tower
  const km = (a, b) => Math.hypot((a.lon - b.lon) * 111 * Math.cos(a.lat * Math.PI / 180), (a.lat - b.lat) * 111);

  // ---- shots: an intro, each lighthouse (fly in, then hold), an outro
  const shots = [{ kind: 'intro', fly: 0, hold: 3.6 }];
  stations.forEach((s, i) => {
    const from = i ? stations[i - 1] : null;
    const fly = from ? Math.min(5, 2.6 + km(from, s) / 70) : 5.2;
    shots.push({ kind: 'station', s, i, fly, hold: HOLD_S, info: describe(s, i + 1, stations.length) });
  });
  shots.push({ kind: 'outro', fly: 5, hold: 3.4 });
  for (const k of shots) k.frames = Math.round((k.fly + k.hold) * FPS);

  const introInfo = { name: 'Lighthouses of Tamil Nadu', total: 0, idx: 0, when: `${stations.length} lights, from Muttom Point to Pulicat`,
    note: 'Each light flashes its real rhythm from the DGLL Master Ledgers. Radio aids: RACON radar beacons and NAVTEX.', tech: [], radio: [] };
  const outroInfo = { name: 'maps.reclaimchennai.city/lighthouses', total: 0, idx: 0, when: 'Every active light on India\'s coast',
    note: 'Data: Directorate General of Lighthouses and Lightships, Lok Sabha, Lighthouse Directory. Map: OpenStreetMap, OpenFreeMap.', tech: [], radio: [] };

  const boxOf = k => k.kind === 'intro' ? introInfo : k.kind === 'outro' ? outroInfo : k.info;
  // the box: the previous one fades out as the camera leaves, the next fades in as it nears
  onOverlay((ctx, w, h, s) => {
    if (!shot) return;
    const cut = 0.35, appear = shot.kind === 'intro' ? 0.2 : Math.max(0.2, shot.fly * 0.5);
    if (prev && shotT < cut) drawBox(ctx, w, h, s, prev, 1 - shotT / cut);
    if (shotT >= appear) drawBox(ctx, w, h, s, boxOf(shot), Math.min(1, (shotT - appear) / 0.35));
  });

  // ---- the driver's virtual clock lives in window.__vstep (scripts/film.mjs)
  const vstep = dt => window.__vstep(dt);
  async function settle(dt) {                          // advance, then wait for tiles and buildings
    const t0 = window.__realNow();
    for (let n = 0; ; n++) {
      map.triggerRepaint();
      vstep(n ? 0 : dt);
      if ((map.loaded() && map.areTilesLoaded()) || window.__realNow() - t0 > 9000) return;
      await sleep(150);
    }
  }
  function alignLight(s, seconds) {                    // make the light show a flash `seconds` into the hold
    const e = layer.entries.find(x => x.st.id === s.id);
    const u = e?.beamMat?.uniforms;
    if (!u) return;
    const rot = u.uRot.value > 0.5;
    const period = u.uPeriod.value, start = u.uStart.value[0] || 0;
    // clock value wanted when the hold begins: the first lit window starts `seconds` later
    let T = (rot ? 0 : (period - seconds + start)) % period;
    if (T < 0) T += period;
    const wanted = T - shot.fly;                         // the clock at the start of this shot
    layer.t0 = performance.now() - wanted * 1000;
  }

  window.__film = {
    fps: FPS,
    plan: () => shots.map(k => ({ kind: k.kind, frames: k.frames, id: k.s?.id || null })),
    async ready() {
      for (let i = 0; i < 600; i++) {
        vstep(16);
        if (layer.towersBuilt && map.loaded()) break;
        await sleep(100);
      }
      await Promise.all(['600 34px "LH Digits"', '600 20px "Pixelify Sans"', '700 20px "Pixelify Sans"', '400 12px Inter', '500 12px Inter', '600 12px Inter', '700 12px Inter'].map(f => document.fonts.load(f)));
      map.setPadding({ left: 0, right: 0, top: 0, bottom: 0 });
      setLayerOn('#l-racon', 'racon', true); setLayerOn('#l-navtex', 'navtex', true);
      setLayerOn('#l-towers', 'towers', true); setLayerOn('#l-beams', 'beams', true);
      map.jumpTo({ ...OVERVIEW, padding: { left: 0, right: 0, top: 0, bottom: 0 } });
      await settle(16);
      return { stations: stations.length, size: [innerWidth, innerHeight] };
    },
    // put the camera where shot k-1 ended, and load everything around it (the buildings), before shot k begins
    async prime(k) {
      const before = shots[k - 1];
      prev = before ? boxOf(before) : null;
      if (!before || before.kind === 'intro') map.jumpTo({ ...OVERVIEW, padding: { left: 0, right: 0, top: 0, bottom: 0 } });
      else if (before.kind === 'station') map.jumpTo(camFor(before.s));
      await settle(0);
    },
    async begin(k) {
      shot = shots[k]; shotT = 0;
      if (shot.kind === 'station') {
        // preload the destination's tiles and buildings in the background, then fly there
        alignLight(shot.s, 0.7);
        map.flyTo({ ...camFor(shot.s), duration: shot.fly * 1000, curve: 1.35, essential: true });
      } else if (shot.kind === 'outro') {
        map.flyTo({ ...OVERVIEW, padding: { left: 0, right: 0, top: 0, bottom: 0 }, duration: shot.fly * 1000, curve: 1.2, essential: true });
      }
    },
    async frame(i) {
      shotT = (i + 1) / FPS;
      await settle(1000 / FPS);
      const c = capture.frame(false);
      return c.toDataURL('image/jpeg', 0.92);
    },
  };
  window.__filmReady = true;
}
