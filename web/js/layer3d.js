// three.js custom layer for MapLibre: towers, revolving beams, NAVTEX waves, RACON Morse.
//
// Coordinates: the scene is re-centred on the map centre every frame (float32 safe).
// Inside `world`, x = metres east, y = metres SOUTH (Mercator's own direction), z = metres
// up, at the fixed origin latitude. Do not mirror y with a negative scale: MapLibre's
// matrix already carries that reflection, and three would "correct" the winding again
// and cull every face. Shaders get true east/north metres through aLocal.
import * as THREE from 'three';
import { buildLighthouse, buildLightVessel } from './models.js?v=3';

export const COLOURS = {
  W: new THREE.Color('#ffd27a'), R: new THREE.Color('#ff5a4f'), G: new THREE.Color('#3fe08a'),
  navtex: new THREE.Color('#3fd6ff'), racon: new THREE.Color('#ff7ad9'), ais: new THREE.Color('#9d8cff'),
  dgps: new THREE.Color('#7cf0c2'), plain: new THREE.Color('#ffd27a'),
};
const NM = 1852;
const RACON_NM = 15;          // DGLL: "RACON range is line-of-sight, typically greater than 15NM"

/* ---------------------------------------------------------------- rhythm */
// phases alternate light/eclipse seconds; returns 0..1 with soft edges
export function lightLevel(phases, t) {
  if (!phases || !phases.length) return 0;
  const P = phases.reduce((a, b) => a + b, 0);
  if (P <= 0) return 1;
  let x = ((t % P) + P) % P, acc = 0;
  for (let i = 0; i < phases.length; i += 2) {
    const on = phases[i], a = acc, b = acc + on;
    if (x >= a - 0.04 && x <= b + 0.12) {
      const rise = Math.min(1, (x - (a - 0.04)) / 0.04);
      const fall = x > b ? 1 - (x - b) / 0.12 : 1;
      return Math.max(0, Math.min(rise, fall));
    }
    acc = b + (phases[i + 1] || 0);
  }
  return 0;
}

const MORSE = { A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---',
  K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-',
  V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..' };
export function morsePhases(letter) {
  const u = 0.28, seq = [];
  const code = MORSE[letter] || '.';
  [...code].forEach((c, i) => { seq.push(c === '-' ? 3 * u : u); seq.push(i === code.length - 1 ? 7 * u : u); });
  return seq;
}

// Revolving optic: one lit window per beam, centred on the ledger flash centre, as long as
// the beam (ledger horizontal divergence) takes to sweep past: width/360 × seconds per turn.
function beamWindows(st, max = 8) {
  const P = st.phases.reduce((a, b) => a + b, 0);
  const starts = new Array(max).fill(0), durs = new Array(max).fill(0);
  const dur = (st.sim.width_deg / 360) * st.sim.rev_s;
  st.sim.beams.slice(0, max).forEach((b, i) => { starts[i] = b.c - dur / 2; durs[i] = dur; });
  return { starts, durs, n: Math.min(max, st.sim.beams.length), period: P };
}

// Seconds per full turn of a revolving optic. The ledger RPM is used when it is
// consistent with the characteristic (one turn = a whole number of flash periods,
// e.g. Chennai 3 rpm -> 20 s = 2 × its 10 s period); otherwise one turn per period.
export function revolution(st, period) {
  if (!period) return 0;
  if (st.rpm) {
    const rev = 60 / st.rpm, k = rev / period;
    if (k >= 0.95 && Math.abs(k - Math.round(k)) < 0.12) return Math.round(k) * period;
  }
  return period;
}

// 72-char '0'/'1' string, one per 5° clockwise from north (build_data.sea_mask), smoothed
function seaAt(mask, bearing) {
  if (!mask) return 1;
  const n = mask.length, x = bearing * n - 0.5;
  const i0 = ((Math.floor(x) % n) + n) % n, i1 = (i0 + 1) % n, f = x - Math.floor(x);
  return (mask.charCodeAt(i0) - 48) * (1 - f) + (mask.charCodeAt(i1) - 48) * f;
}

function toStartsDurs(phases, max = 8) {
  const starts = new Array(max).fill(0), durs = new Array(max).fill(0);
  let acc = 0, n = 0;
  for (let i = 0; i < phases.length && n < max; i += 2) {
    starts[n] = acc; durs[n] = phases[i]; n++;
    acc += phases[i] + (phases[i + 1] || 0);
  }
  return { starts, durs, n, period: phases.reduce((a, b) => a + b, 0) };
}

/* --------------------------------------------------------------- shaders */
const VERT = /* glsl */`
  attribute vec2 aLocal;
  varying vec2 vLocal;
  void main(){
    vLocal = aLocal;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

/* Pixel art: every sea effect is drawn in square blocks (uCell metres = 2 buffer pixels at the
   station's latitude), its brightness posterized to a few steps with a 4×4 ordered dither, and
   its clock advanced in 12 fps steps. Averages are preserved, so the ledger timings and the
   reach stay true; only the look is retro. */
const PIXEL = /* glsl */`
  uniform float uCell;
  float bayer2(vec2 a){ a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
  float bayer4(vec2 a){ return bayer2(0.5 * a) * 0.25 + bayer2(a); }
  float posterize(float a, vec2 cell){ return floor(clamp(a, 0.0, 1.0) * 4.0 + bayer4(cell)) / 4.0; }
  float stepTime(float t){ return floor(t * 12.0) / 12.0; }
`;

const BEAM_FRAG = /* glsl */`
  ${PIXEL}
  uniform float uTime, uPeriod, uRev, uReach, uRot, uAlpha, uSel, uInner, uGain;
  uniform float uStart[8]; uniform float uDur[8]; uniform int uN;
  uniform vec3 uColor;
  varying vec2 vLocal;
  float win(float x, float a, float d){
    return smoothstep(a - 0.06, a, x) * (1.0 - smoothstep(a + d, a + d + 0.18, x));
  }
  float lit(float t){
    float x = mod(t, uPeriod), v = 0.0;
    for (int i = 0; i < 8; i++) {
      if (i >= uN) break;
      float a = uStart[i], d = max(uDur[i], 0.05);
      // also test one period either side so a beam centred near the period boundary isn't cut
      v = max(v, max(win(x, a, d), max(win(x + uPeriod, a, d), win(x - uPeriod, a, d))));
    }
    return v;
  }
  void main(){
    vec2 cell = floor(vLocal / uCell);
    vec2 P = (cell + 0.5) * uCell;
    float d = length(P);
    float r = d / uReach;
    if (r > 1.0) discard;
    float az = atan(P.x, P.y) / 6.2831853;             // bearing, 0 = north, clockwise
    float T = stepTime(uTime);
    // A revolving optic turns once every uRev seconds (60 / ledger RPM). Every bearing sees
    // the published rhythm, delayed by how far round the lens has to turn to reach it, so
    // the flash groups are beams sweeping a full 360°. uRev = k × period for k groups per turn.
    float t = uRot > 0.5 ? T - az * uRev : T;
    float L = lit(t);
    // the 3D shaft leaves the lantern and lands on the sea at uInner; the sweep starts there
    L *= uRot > 0.5 ? smoothstep(uInner * 0.45, uInner, d) : 1.0;
    // A revolving beam is a narrow bright wedge; a flasher lights every bearing at once, so its
    // pulse must be a soft glow that fades fast with distance, or one flash floods a whole gulf.
    float fall = uRot > 0.5 ? pow(1.0 - r, 1.35) : pow(1.0 - r, 4.0);
    float halo = exp(-d / (uReach * 0.06)) * (uRot > 0.5 ? 0.25 : 0.35);
    float gain = (uRot > 0.5 ? 0.62 : 0.16) * uGain;
    float rim = smoothstep(0.975, 1.0, r) * (0.18 + 0.4 * uSel);
    float a = posterize((L * (fall * gain + halo) + rim + 0.028 * (1.0 - r) + 0.06 * uSel * (1.0 - r)) * uAlpha, cell);
    gl_FragColor = vec4(uColor * a, a);
  }`;

const WAVE_FRAG = /* glsl */`
  ${PIXEL}
  uniform float uTime, uR, uLive, uAlpha;
  uniform vec3 uColor;
  varying vec2 vLocal;
  void main(){
    vec2 cell = floor(vLocal / uCell);
    float d = length((cell + 0.5) * uCell);
    float r = d / uR;
    if (r > 1.0) discard;
    float lambda = 34000.0;                      // 34 km between drawn wavefronts
    float ph = fract(d / lambda - stepTime(uTime) * 0.42);
    float front = step(ph, 0.22);                // hard-edged pixel ring
    float fade = pow(1.0 - r, 0.75);
    float rim = step(0.99, r) * 0.35;
    float a = posterize((front * fade * (0.22 + 0.78 * uLive) + 0.02 * (1.0 - r) + rim) * uAlpha, cell);
    gl_FragColor = vec4(uColor * a, a);
  }`;

const RACON_FRAG = /* glsl */`
  ${PIXEL}
  uniform float uTime, uR, uAlpha, uCycle, uV;
  uniform float uStart[8]; uniform float uDur[8]; uniform int uN;
  uniform vec3 uColor;
  varying vec2 vLocal;
  float sig(float t){
    float x = mod(t, uCycle), v = 0.0;
    for (int i = 0; i < 8; i++) {
      if (i >= uN) break;
      v = max(v, step(uStart[i], x) * step(x, uStart[i] + uDur[i]));
    }
    return v;
  }
  void main(){
    vec2 cell = floor(vLocal / uCell);
    float d = length((cell + 0.5) * uCell);
    float r = d / uR;
    if (r > 1.0) discard;
    float s = sig(stepTime(uTime) - d / uV);      // the code travels outward as rings
    float a = posterize((s * (1.0 - r) * 0.55 + step(0.98, r) * 0.2) * uAlpha, cell);
    gl_FragColor = vec4(uColor * a, a);
  }`;

const GLOW_VERT = /* glsl */`
  attribute float aLevel; attribute vec3 aColor; attribute float aSize;
  uniform float uPx;
  varying float vLevel; varying vec3 vColor;
  void main(){
    vLevel = aLevel; vColor = aColor;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPx * (0.55 + 0.9 * aLevel);
  }`;
const GLOW_FRAG = /* glsl */`
  varying float vLevel; varying vec3 vColor;
  void main(){
    // 9×9 pixel sprite: a diamond glow with a square white-hot core
    vec2 c = floor(gl_PointCoord * 9.0) - 4.0;
    float d = (abs(c.x) + abs(c.y)) / 5.0;
    if (d > 1.0) discard;
    float core = step(max(abs(c.x), abs(c.y)), 0.5);
    float glow = floor((1.0 - d) * 3.0 + 0.5) / 3.0;
    float a = (core * (0.25 + 0.75 * vLevel) + glow * 0.8 * vLevel);
    gl_FragColor = vec4(mix(vColor, vec3(1.0), core * vLevel) * a, a);
  }`;

// light shaft: cone from the lantern, fading along its length
const SHAFT_VERT = /* glsl */`
  attribute float aT;
  varying float vT;
  void main(){
    vT = aT;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const SHAFT_FRAG = /* glsl */`
  ${PIXEL}
  uniform vec3 uColor; uniform float uAlpha;
  varying float vT;
  void main(){
    // bands along the shaft, dithered per 2 buffer pixels
    float q = floor(vT * 8.0) / 8.0;
    float a = posterize(pow(max(0.0, 1.0 - q), 1.9) * 0.34 * uAlpha * 2.0, floor(gl_FragCoord.xy / 2.0)) * 0.5;
    gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.35 * (1.0 - vT)) * a, a);
  }`;

// Cone with its apex in the lantern (model space, Y up), opening towards +Z (north),
// tilted down so its axis meets the sea at horizontal distance L.
function shaftGeometry(focal, L, halfAngle) {
  const h = Math.hypot(L, focal);
  const g = new THREE.ConeGeometry(Math.tan(halfAngle) * h, h, 24, 8, true);
  g.translate(0, -h / 2, 0);            // apex at the origin, opening towards -Y
  g.rotateX(-Math.PI / 2);              // opening towards +Z
  g.rotateX(Math.atan2(focal, L));      // dip to the sea
  g.translate(0, focal, 0);
  const p = g.attributes.position, aT = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) aT[i] = Math.hypot(p.getX(i), p.getY(i) - focal, p.getZ(i)) / h;
  g.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
  return g;
}

let glowTex = null;
function glowTexture() {
  if (glowTex) return glowTex;
  const cv = document.createElement('canvas');
  // 16×16 pixel halo: stepped diamond rings, sampled nearest so the blocks stay sharp
  cv.width = cv.height = 16;
  const g = cv.getContext('2d');
  const steps = [[1.5, 'rgba(255,255,255,1)'], [3.5, 'rgba(255,240,200,0.8)'], [5.5, 'rgba(255,210,122,0.35)'], [7.5, 'rgba(255,210,122,0.12)']];
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const d = Math.abs(x - 7.5) + Math.abs(y - 7.5);
    const s = steps.find(([r]) => d <= r + 0.5);
    if (s) { g.fillStyle = s[1]; g.fillRect(x, y, 1, 1); }
  }
  glowTex = new THREE.CanvasTexture(cv);
  glowTex.magFilter = glowTex.minFilter = THREE.NearestFilter;
  glowTex.generateMipmaps = false;
  return glowTex;
}

const additive = {
  transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
  blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  blendEquation: THREE.AddEquation,
};

/* ----------------------------------------------------------------- layer */
export class LighthouseLayer {
  constructor(maplibregl, data, reach) {
    this.id = 'lighthouses-3d';
    this.type = 'custom';
    this.renderingMode = '3d';
    this.ml = maplibregl;
    this.data = data;
    this.reach = reach;
    this.visible = { beams: true, navtex: true, racon: false, towers: true };
    this.year = 9999;
    this.selected = null;
    this.colourFn = s => COLOURS[s.colour] || COLOURS.W;
    this.clock = { value: 0 };
    this.beamGain = { value: 1 };          // shared by every beam material
    this.t0 = performance.now();
  }

  /* ----------------------------------------------------- geometry helpers */
  merc(lon, lat) { return this.ml.MercatorCoordinate.fromLngLat([lon, lat], 0); }

  local(lon, lat) {                      // -> world (east, south) metres at origin scale
    const m = this.merc(lon, lat);
    return [(m.x - this.origin.x) / this.s, (m.y - this.origin.y) / this.s];
  }

  polyMesh(m, st, material) {
    // m: {v: [lon, lat, ...], i: [...]} pre-triangulated in build_data.py (constrained
    // Delaunay, every triangle inside the sea polygon). aLocal = true east/north metres
    // from the station, which the shaders use for range and bearing.
    if (!m || !m.i?.length) return null;
    const mSt = this.merc(st.lon, st.lat);
    const mPerUnit = mSt.meterInMercatorCoordinateUnits();
    const n = m.v.length / 2;
    const pos = new Float32Array(n * 3), loc = new Float32Array(n * 2);
    for (let k = 0; k < n; k++) {
      const c = this.merc(m.v[k * 2], m.v[k * 2 + 1]);
      pos[k * 3] = (c.x - this.origin.x) / this.s;
      pos[k * 3 + 1] = (c.y - this.origin.y) / this.s;
      loc[k * 2] = (c.x - mSt.x) / mPerUnit;
      loc[k * 2 + 1] = -(c.y - mSt.y) / mPerUnit;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aLocal', new THREE.BufferAttribute(loc, 2));
    g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(m.i, 1) : new THREE.Uint16BufferAttribute(m.i, 1));
    const mesh = new THREE.Mesh(g, material);
    mesh.frustumCulled = false;
    return mesh;
  }

  /* ---------------------------------------------------------------- onAdd */
  onAdd(map, gl) {
    this.map = map;
    this.origin = this.merc(82.0, 15.0);
    this.s = this.origin.meterInMercatorCoordinateUnits();

    this.camera = new THREE.Camera();
    this.scene = new THREE.Scene();
    this.world = new THREE.Group();
    this.scene.add(this.world);

    this.scene.add(new THREE.HemisphereLight(0x9fb4d0, 0x1a1410, 1.25));
    const moon = new THREE.DirectionalLight(0xdde8ff, 2.2);
    moon.position.set(-0.6, -0.8, 1.0);           // north-west (y is south), high: moonlight
    this.scene.add(moon);

    this.beams = new THREE.Group(); this.beams.renderOrder = 1;
    this.waves = new THREE.Group();
    this.racons = new THREE.Group();
    this.towers = new THREE.Group();
    this.world.add(this.waves, this.beams, this.racons, this.towers);

    const px = { value: map.getPixelRatio ? map.getPixelRatio() : (window.devicePixelRatio || 1) };
    this.entries = [];

    for (const st of this.data.stations) {
      if (st.kind !== 'lighthouse' && st.kind !== 'lightvessel') continue;
      const e = { st, level: 0 };
      const [x, y] = this.local(st.lon, st.lat);
      e.xy = [x, y];
      e.k = this.merc(st.lon, st.lat).meterInMercatorCoordinateUnits() / this.s;  // latitude size fix

      if (st.phases && st.reach_nm && this.reach.lights[st.id]) {
        const rot = st.sim?.mode === 'revolving' ? 1 : 0;
        // revolving: the lit window at each bearing is the ledger beam width swept at the
        // ledger rotation speed; flashing: the ledger light/eclipse timings themselves
        const sd = rot ? beamWindows(st) : toStartsDurs(st.phases);
        e.rev = rot ? st.sim.rev_s : sd.period;
        e.beamMat = new THREE.ShaderMaterial({
          vertexShader: VERT, fragmentShader: BEAM_FRAG, ...additive,
          uniforms: {
            uTime: this.clock, uPeriod: { value: sd.period }, uRev: { value: e.rev }, uReach: { value: st.reach_nm * NM * 1.0 },
            uRot: { value: rot }, uAlpha: { value: 1 }, uSel: { value: 0 }, uInner: { value: 0 }, uGain: this.beamGain, uCell: { value: 1000 },
            uStart: { value: sd.starts }, uDur: { value: sd.durs }, uN: { value: sd.n },
            uColor: { value: this.colourFn(st).clone() },
          },
        });
        e.beam = this.polyMesh(this.reach.lights[st.id], st, e.beamMat);
        if (e.beam) this.beams.add(e.beam);
      }
      if (st.racon && this.reach.lights[st.id]) {
        const sd = toStartsDurs(morsePhases(st.racon));
        e.raconMat = new THREE.ShaderMaterial({
          vertexShader: VERT, fragmentShader: RACON_FRAG, ...additive,
          uniforms: {
            uTime: this.clock, uR: { value: Math.min(RACON_NM, st.reach_nm || RACON_NM) * NM }, uAlpha: { value: 1 },
            uCycle: { value: sd.period }, uV: { value: 9000 }, uStart: { value: sd.starts }, uDur: { value: sd.durs },
            uN: { value: sd.n }, uColor: { value: COLOURS.racon.clone() }, uCell: { value: 1000 },
          },
        });
        e.racon = this.polyMesh(this.reach.lights[st.id], st, e.raconMat);
        if (e.racon) this.racons.add(e.racon);
      }
      this.entries.push(e);
    }

    // NAVTEX broadcast areas
    this.navtex = [];
    for (const n of this.data.navtex) {
      const polys = this.reach.navtex[n.id_518];
      if (!polys) continue;
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: WAVE_FRAG, ...additive,
        uniforms: { uTime: this.clock, uR: { value: this.data.meta.navtex_nm * NM }, uLive: { value: 0 },
                    uAlpha: { value: 1 }, uColor: { value: COLOURS.navtex.clone() }, uCell: { value: 1000 } },
      });
      const mesh = this.polyMesh(polys, n, mat);
      if (mesh) { this.waves.add(mesh); this.navtex.push({ n, mat, mesh }); }
    }

    // far-zoom lamp glows (one draw call)
    const N = this.entries.length;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), lvl = new Float32Array(N), size = new Float32Array(N);
    this.entries.forEach((e, i) => {
      pos[i * 3] = e.xy[0]; pos[i * 3 + 1] = e.xy[1]; pos[i * 3 + 2] = 0;
      const c = this.colourFn(e.st); col.set([c.r, c.g, c.b], i * 3);
      size[i] = 10 + Math.min(12, (e.st.reach_nm || 10) * 0.35);
    });
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aLevel', new THREE.BufferAttribute(lvl, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    this.glow = new THREE.Points(g, new THREE.ShaderMaterial({
      vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG, ...additive, uniforms: { uPx: px },
    }));
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 5;
    this.world.add(this.glow);

    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.towersBuilt = false;
  }

  buildTowers() {
    // deferred: only when first zoomed in, keeps first paint fast
    for (const e of this.entries) {
      const holder = new THREE.Group();
      const vessel = e.st.kind === 'lightvessel';
      const model = vessel ? buildLightVessel(e.st) : buildLighthouse(e.st);
      model.rotation.x = Math.PI / 2;                 // model Y-up -> world Z-up
      holder.add(model);
      holder.position.set(e.xy[0], e.xy[1], 0);
      holder.userData.h = model.userData.spec.h + 6;
      e.lamp = model.getObjectByName('lamp');
      e.swell = model.getObjectByName('swell');
      const focal = model.userData.focal, spec = model.userData.spec, st = e.st;

      // halo at the lantern: every light glows from the top of its tower
      const col = e.beamMat ? e.beamMat.uniforms.uColor.value : this.colourFn(st);
      e.halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture(), color: col, transparent: true, depthWrite: false, depthTest: false,
        blending: THREE.AdditiveBlending,
      }));
      e.halo.position.copy(e.lamp ? e.lamp.position : new THREE.Vector3(0, focal, 0));
      e.halo.renderOrder = 6;
      e.halo.userData.base = Math.max(8, spec.h * 0.6);
      (e.lamp?.parent || model).add(e.halo);           // rides the swell on the light vessel

      // revolving optics: one shaft per flash, per group repeat within a turn
      e.shafts = [];
      if (st.sim?.mode === 'revolving' && e.beamMat) {
        const sd = beamWindows(st);
        const rev = st.sim.rev_s;
        const k = st.sim.groups_per_turn || Math.max(1, Math.round(rev / sd.period));
        // short enough to read as "leaving the lantern" at any tower exaggeration; the
        // sweep on the water (BEAM_FRAG) carries the beam on to its real range
        e.shaftL = Math.max(40, spec.h * 2.6);
        for (let n = 0; n < k; n++) {
          for (let i = 0; i < sd.n; i++) {
            // cone half-angle = half the ledger beam width (kept visible, never a spotlight fan)
            const half = THREE.MathUtils.degToRad(Math.max(1.2, Math.min(8, st.sim.width_deg / 2)));
            const mat = new THREE.ShaderMaterial({
              vertexShader: SHAFT_VERT, fragmentShader: SHAFT_FRAG, ...additive,
              uniforms: { uColor: e.beamMat.uniforms.uColor, uAlpha: { value: 1 }, uCell: { value: 1 } },
            });
            const turn = new THREE.Group();
            const mesh = new THREE.Mesh(shaftGeometry(focal, e.shaftL, half), mat);
            mesh.frustumCulled = false;
            mesh.renderOrder = 4;
            turn.add(mesh);
            model.add(turn);
            e.shafts.push({ obj: turn, mat, center: st.sim.beams[i].c + n * sd.period });
          }
        }
      }
      e.tower = holder;
      this.towers.add(holder);
    }
    this.towersBuilt = true;
  }

  /* --------------------------------------------------------------- setters */
  setVisible(v) { Object.assign(this.visible, v); this.map?.triggerRepaint(); }
  setYear(y) { this.year = y; }
  setSelected(id) { this.selected = id; }
  setColour(fn) {
    this.colourFn = fn;
    if (!this.glow) return;
    const col = this.glow.geometry.attributes.aColor;
    this.entries.forEach((e, i) => {
      const c = fn(e.st);
      col.setXYZ(i, c.r, c.g, c.b);
      if (e.beamMat) e.beamMat.uniforms.uColor.value.copy(c);
    });
    col.needsUpdate = true;
  }
  setNavtexLive(liveIds) {
    for (const x of this.navtex || []) x.target = liveIds.has(x.n.id_518) ? 1 : 0;
  }
  bornBy(st, year) {
    const y = st.established || st.tower_year;
    return !y || y <= year;
  }

  /* ---------------------------------------------------------------- render */
  render(gl, args) {
    const t = (performance.now() - this.t0) / 1000;
    this.clock.value = t;
    const map = this.map;
    const zoom = map.getZoom();

    // re-centre for float precision
    const c = map.getCenter();
    const cm = this.merc(c.lng, c.lat);
    this.world.position.set((this.origin.x - cm.x) / this.s, (this.origin.y - cm.y) / this.s, 0);
    const mm = args?.defaultProjectionData?.mainMatrix || args?.modelViewProjectionMatrix || args;
    const m = new THREE.Matrix4().fromArray(mm);
    const l = new THREE.Matrix4().makeTranslation(cm.x, cm.y, 0).scale(new THREE.Vector3(this.s, this.s, this.s));
    this.camera.projectionMatrix = m.multiply(l);

    this.beams.visible = this.visible.beams;
    this.racons.visible = this.visible.racon;
    this.waves.visible = this.visible.navtex;

    const showTowers = this.visible.towers && zoom >= 6.2;
    if (showTowers && !this.towersBuilt) this.buildTowers();
    this.towers.visible = showTowers;

    // towers stay readable at any zoom: target ~64 px tall, never below true scale
    const mpp0 = 40075016.686 / (512 * Math.pow(2, zoom));
    // pixel block for the sea effects: 2 drawing-buffer pixels, in metres at the equator
    const cellM = mpp0 * 2 / (map.getPixelRatio ? map.getPixelRatio() : 1);
    const tStep = Math.floor(t * 12) / 12;
    const lvl = this.glow.geometry.attributes.aLevel;
    const year = this.year;
    this.entries.forEach((e, i) => {
      const st = e.st;
      const on = this.bornBy(st, year);
      e.alpha = (e.alpha ?? 1) + ((on ? 1 : 0) - (e.alpha ?? 1)) * 0.12;
      const rot = st.sim?.mode === 'revolving';
      const L = lightLevel(st.phases, t);
      e.level = st.phases ? (rot ? 0.35 + 0.65 * L : L) * e.alpha : 0.15 * e.alpha;
      lvl.setX(i, showTowers ? 0 : e.level);
      const sel = this.selected === st.id ? 1 : 0;
      const cell = cellM * Math.cos(st.lat * Math.PI / 180);
      if (e.raconMat) e.raconMat.uniforms.uCell.value = cell;
      if (e.beamMat) {
        e.beamMat.uniforms.uCell.value = cell;
        e.beamMat.uniforms.uAlpha.value = e.alpha;
        e.beamMat.uniforms.uSel.value += (sel - e.beamMat.uniforms.uSel.value) * 0.15;
      }
      // no radar beacon before the ledger's installation year
      const raconYear = st.equip_since?.racon?.year;
      if (e.raconMat) e.raconMat.uniforms.uAlpha.value = e.alpha * (raconYear && year < raconYear ? 0 : 1);
      if (e.tower) {
        e.tower.visible = e.alpha > 0.05;
        const mpp = mpp0 * Math.cos(st.lat * Math.PI / 180);
        const ex = Math.max(1, (64 * mpp) / e.tower.userData.h) * e.k * (sel ? 1.35 : 1);
        e.tower.scale.setScalar(ex);
        if (e.lamp) {
          e.lamp.material.opacity = 0.15 + 0.85 * e.level;
          e.lamp.material.color.copy(this.colourFn(st)).lerp(new THREE.Color(1, 1, 1), 0.5 * e.level);
          e.lamp.scale.setScalar(1 + 1.8 * e.level);
        }
        if (e.halo) {
          // flashers pulse the whole lantern; a revolving lens keeps a steady glow inside
          const h = rot ? 0.45 : e.level;
          e.halo.material.opacity = Math.min(1, (0.1 + 0.9 * h) * e.alpha);
          e.halo.scale.setScalar(e.halo.userData.base * (0.7 + (rot ? 1.0 : 1.9) * h));
        }
        const showShafts = this.visible.beams && e.alpha > 0.05;
        for (const sh of e.shafts || []) {
          sh.obj.visible = showShafts;
          // same clock as the sea sweep: bearing = (t - flash centre) / seconds per turn
          const bearing = ((((tStep - sh.center) / e.rev) % 1) + 1) % 1;
          sh.obj.rotation.y = bearing * Math.PI * 2;
          sh.mat.uniforms.uAlpha.value = e.alpha * seaAt(st.sea_mask, bearing);
        }
        if (e.swell) {
          // moored light vessel: heave ~7 s, roll ~5.5 s, pitch ~8 s, slow swing on the cable
          const w = Math.PI * 2;
          e.swell.position.y = 0.35 * Math.sin(t * w / 7.1);
          e.swell.rotation.x = 0.07 * Math.sin(t * w / 5.5 + 1.1);
          e.swell.rotation.z = 0.025 * Math.sin(t * w / 8.3 + 0.4);
          e.swell.rotation.y = 0.6 + 0.22 * Math.sin(t * w / 95);
        }
        if (e.beamMat) e.beamMat.uniforms.uInner.value = e.shaftL ? (e.shaftL * ex) / e.k : 0;
      } else if (e.beamMat) {
        e.beamMat.uniforms.uInner.value = 0;
      }
    });
    lvl.needsUpdate = true;

    // Up close the camera sits inside 20-30 NM beams; dim the sea sweep so towers and the
    // light vessel stay readable (the shafts from the lantern keep full strength).
    this.beamGain.value = Math.max(0.4, Math.min(1, 1.3 - (zoom - 8) * 0.18));
    // 34 km wavefronts read as rings at country scale but as heavy bands up close,
    // where the beams are the story: fade the broadcast as the camera comes down.
    const navFade = Math.max(0.28, Math.min(1, 1.25 - (zoom - 6) * 0.2));
    for (const x of this.navtex || []) {
      const u = x.mat.uniforms.uLive;
      u.value += ((x.target || 0) - u.value) * 0.05;
      // no broadcast before the NAVTEX equipment year recorded in the ledgers
      const on = !x.n.since || this.year >= x.n.since ? 1 : 0;
      x.on = (x.on ?? on) + (on - (x.on ?? on)) * 0.12;
      x.mat.uniforms.uAlpha.value = navFade * x.on;
      x.mat.uniforms.uCell.value = cellM * Math.cos(x.n.lat * Math.PI / 180);
    }

    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    map.triggerRepaint();
  }
}
