// Pixel scenes, after pol.reclaimchennai.city (aqi/dashboard/static/js/scenes.js): tiny canvases
// drawn with hard pixels and scaled up with image-rendering: pixelated.
//
// Each lighthouse card gets its own 96 × 54 night scene built from its ledger: the tower in its
// banding, the lantern flashing its real rhythm, a revolving beam sweeping at the ledger rotation
// speed, NAVTEX rings from the radio mast, RACON Morse blips on the sea, a light vessel riding the
// swell. The panel header gets the same scene for Chennai.
export const W = 96, H = 54;
const FPS = 15;
const scenes = new Set();
let started = false, last = 0;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

const io = new IntersectionObserver(es => { for (const e of es) if (e.target.__scene) e.target.__scene.visible = e.isIntersecting; });

/* --------------------------------------------------------------- helpers */
const hash = (i, s = 0) => { const x = Math.sin(i * 12.9898 + s * 78.233 + 1.7) * 43758.5453; return x - Math.floor(x); };
const hx = n => '#' + n.toString(16).padStart(6, '0');
function rgb(c) { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function mix(a, b, t) {
  const A = rgb(a), B = rgb(b); t = Math.max(0, Math.min(1, t));
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
function rgba(c, a) { const [r, g, b] = rgb(c); return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`; }
function rect(ctx, x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h))); }
const px = (ctx, x, y, c) => rect(ctx, x, y, 1, 1, c);
function ring(ctx, cx, cy, r, c, top = false) {
  let x = r, y = 0, err = 1 - r;
  while (x >= y) {
    for (const [a, b] of [[x, y], [y, x], [-y, x], [-x, y], [-x, -y], [-y, -x], [y, -x], [x, -y]]) if (!top || b <= 0) px(ctx, cx + a, cy + b, c);
    y++;
    if (err < 0) err += 2 * y + 1; else { x--; err += 2 * (y - x) + 1; }
  }
}

const PAL = {
  skyTop: '#04081a', skyBot: '#1b2a57', star: '#dfe7ff', moon: '#e8ecf5',
  sea: '#0a2442', seaDeep: '#061629', foam: '#5da9ff', rock: '#4a4f57', rockHi: '#6a707a', grass: '#3f6b2a', sand: '#b9a06a',
  beamW: '#ffe27a', beamR: '#ff6b5c', beamG: '#6dff9c', iron: '#2c3037', dome: '#a8321f', radio: '#64d2ff', racon: '#ff6ad5',
};

/* ----------------------------------------------------------------- scene */
function draw(s, t) {
  const { ctx, st, spec } = s;
  const horizon = 33;
  // sky in bands, stars, moon
  for (let i = 0; i < 6; i++) rect(ctx, 0, i * 6, W, 6, mix(PAL.skyTop, PAL.skyBot, i / 5));
  for (let i = 0; i < 22; i++) {
    const tw = 0.4 + 0.6 * Math.abs(Math.sin(t * (0.7 + hash(i, 3)) + i));
    px(ctx, hash(i, 1) * W, hash(i, 2) * (horizon - 6), rgba(PAL.star, tw));
  }
  rect(ctx, 80, 5, 5, 5, PAL.moon); rect(ctx, 79, 6, 1, 3, PAL.moon); rect(ctx, 85, 6, 1, 3, PAL.moon); rect(ctx, 82, 6, 2, 2, '#c9cfdb');
  // sea
  for (let i = 0; i < 4; i++) rect(ctx, 0, horizon + i * 6, W, 6, mix(PAL.sea, PAL.seaDeep, i / 3));
  for (let i = 0; i < 26; i++) {
    const y = horizon + 2 + Math.floor(hash(i, 7) * (H - horizon - 3));
    const x = (hash(i, 8) * W + t * (3 + 4 * hash(i, 9)) * (i % 2 ? 1 : -1) + W) % W;
    rect(ctx, x, y, 2 + Math.floor(hash(i, 10) * 3), 1, rgba(PAL.foam, 0.35 + 0.25 * Math.sin(t * 2 + i)));
  }

  const colour = st.colour === 'R' ? PAL.beamR : st.colour === 'G' ? PAL.beamG : PAL.beamW;
  const L = s.level(st, t);                                   // 0..1, the ledger rhythm
  const vessel = st.kind === 'lightvessel';
  let lx, ly;

  if (vessel) {
    const bob = Math.round(Math.sin(t * 0.9) * 1);
    const bx = 34, by = horizon + 8 + bob;
    rect(ctx, bx, by, 26, 4, '#b3261c'); rect(ctx, bx + 2, by + 4, 22, 1, '#7a1a14'); rect(ctx, bx + 26, by + 1, 2, 2, '#b3261c');
    rect(ctx, bx + 11, by - 9, 1, 9, '#b3261c'); rect(ctx, bx + 15, by - 9, 1, 9, '#b3261c');
    rect(ctx, bx + 12, by - 5, 3, 1, '#b3261c');
    rect(ctx, bx + 11, by - 11, 5, 2, '#c9ced3'); rect(ctx, bx + 10, by - 14, 7, 3, '#b3261c');
    rect(ctx, bx + 3, by - 3, 4, 3, '#b3261c'); rect(ctx, bx + 3, by - 4, 4, 1, '#1d2a3a');
    lx = bx + 13; ly = by - 16;
  } else {
    // headland
    rect(ctx, 0, horizon - 2, 44, H - horizon + 2, PAL.rock);
    for (let x = 0; x < 44; x++) px(ctx, x, horizon - 2 - (x < 36 ? (x % 7 === 0 ? 1 : 0) : 0), PAL.grass);
    rect(ctx, 0, horizon - 3, 36, 1, PAL.grass);
    for (let x = 36; x < 48; x++) rect(ctx, x, horizon - 2 + (x - 36), 1, H, PAL.rock);
    for (let i = 0; i < 18; i++) px(ctx, hash(i, 20) * 40, horizon + hash(i, 21) * 20, PAL.rockHi);
    // tower
    const base = horizon - 3, th = 22, cx = 24;
    const a = hx(spec.a), b = hx(spec.b);
    for (let y = 0; y < th; y++) {
      const w = spec.shape === 'skeletal' ? 5 : Math.round(7 - (spec.tapering ? 2 : 0) * (y / th));
      let c = a;
      if (spec.pattern === 'bands') c = Math.floor((th - 1 - y) / Math.round(th / 5)) % 2 === 0 ? a : b;
      const row = base - 1 - y;
      if (spec.shape === 'skeletal') { px(ctx, cx - 2, row, a); px(ctx, cx + 2, row, a); if (y % 3 === 0) rect(ctx, cx - 2, row, 5, 1, '#8d949b'); continue; }
      for (let x = 0; x < w; x++) {
        let cc = c;
        if (spec.pattern === 'spiral') cc = Math.floor((x + y * 0.8) / 3) % 2 === 0 ? a : b;
        const shade = x === 0 ? 0.25 : x === w - 1 ? -0.12 : 0;     // light from the left
        px(ctx, cx - Math.floor(w / 2) + x, row, shade > 0 ? mix(cc, '#000000', shade) : shade < 0 ? mix(cc, '#ffffff', -shade) : cc);
      }
      if (y % 6 === 3 && spec.shape !== 'skeletal') px(ctx, cx, row, '#15171b');
    }
    if (spec.marina) rect(ctx, cx - 6, base - th, 2, th, '#d99a6c');
    const top = base - th - 1;
    rect(ctx, cx - 4, top, 9, 1, PAL.iron);                         // gallery
    lx = cx; ly = top - 2;
    rect(ctx, cx - 2, top - 4, 5, 1, PAL.dome); rect(ctx, cx - 1, top - 5, 3, 1, PAL.dome); px(ctx, cx, top - 6, PAL.iron);
  }

  // beam or blink
  const sim = st.sim || {};
  if (sim.mode === 'revolving' && sim.rev_s) {
    const k = st.phases.reduce((p, q) => p + q, 0);
    const beams = (sim.beams || [{ c: 0 }]).flatMap(bm => Array.from({ length: sim.groups_per_turn || 1 }, (_, n) => bm.c + n * k));
    for (const c of beams) {
      const ang = ((((t - c) / sim.rev_s) % 1) + 1) % 1 * Math.PI * 2;
      const toward = Math.sin(ang);                                  // + = toward the viewer
      const len = Math.round(Math.cos(ang) * 60);
      const alpha = 0.18 + 0.4 * Math.max(0, toward);
      const dir = Math.sign(len) || 1;
      for (let i = 1; i <= Math.abs(len); i++) {
        const spread = Math.floor(i / 12);
        rect(ctx, lx + dir * i, ly - spread, 1, 1 + spread * 2, rgba(colour, alpha * (1 - i / 64)));
      }
    }
  }
  const lampOn = sim.mode === 'revolving' ? 0.45 + 0.55 * L : L;
  rect(ctx, lx - 1, ly - 1, 3, 3, mix('#3b3526', colour, lampOn));
  if (lampOn > 0.15) {
    rect(ctx, lx - 2, ly, 5, 1, rgba(colour, 0.5 * lampOn)); rect(ctx, lx, ly - 2, 1, 5, rgba(colour, 0.5 * lampOn));
    for (let y = horizon + 1; y < H; y += 2) rect(ctx, lx + 6 + ((y * 3) % 5), y, 2 + (y % 3), 1, rgba(colour, 0.22 * lampOn));   // glitter on the sea
  }

  // NAVTEX: radio mast with rings over the sea
  if (st.navtex && !vessel) {
    const mx = 40, my = horizon - 14;
    rect(ctx, mx, my, 1, 13, '#9aa3ad'); rect(ctx, mx - 1, my + 4, 3, 1, '#9aa3ad'); rect(ctx, mx - 2, my + 9, 5, 1, '#9aa3ad');
    px(ctx, mx, my - 1, (Math.floor(t * 4) % 2) ? PAL.radio : '#ffffff');
    for (let n = 0; n < 3; n++) {
      const r = Math.floor(((t * 10) + n * 9) % 27) + 2;
      ring(ctx, mx, my, r, rgba(PAL.radio, 0.75 * (1 - r / 29)), true);
    }
  }
  // RACON: Morse identifier as blips on a radar line across the sea
  if (st.racon) {
    const code = MORSE[st.racon] || '.';
    const unit = 0.28, seq = [];
    [...code].forEach((c, i) => { seq.push(c === '-' ? 3 : 1); seq.push(i === code.length - 1 ? 7 : 1); });
    const cycle = seq.reduce((p, q) => p + q, 0) * unit;
    let x = W - 4 - ((t % cycle) / cycle) * 60;
    const y = H - 5;
    for (let i = 0; i < seq.length; i += 2) {
      rect(ctx, x, y, seq[i] * 2, 2, PAL.racon);
      x += (seq[i] + seq[i + 1]) * 2;
    }
  }
}

const MORSE = { A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--',
  N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..' };

function loop(now) {
  requestAnimationFrame(loop);
  if (now - last < 1000 / FPS) return;
  last = now;
  for (const s of scenes) {
    if (!s.canvas.isConnected) { scenes.delete(s); io.unobserve(s.canvas); continue; }
    if (!s.visible || (reduced.matches && s.drawn)) continue;
    draw(s, s.clock ? s.clock() : now / 1000);
    s.drawn = true;
  }
}

// station: a map station record; level(station, t) -> 0..1; towerSpec: from models.js
export function mountScene(canvas, station, { level, towerSpec, clock }) {
  if (!canvas || !station) return null;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const s = { canvas, ctx, st: station, spec: towerSpec(station), level, clock, visible: true, drawn: false };
  canvas.__scene = s;
  scenes.add(s);
  io.observe(canvas);
  draw(s, clock ? clock() : performance.now() / 1000);
  if (!started) { started = true; requestAnimationFrame(loop); }
  return s;
}
