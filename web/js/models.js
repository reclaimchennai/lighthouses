// Voxel lighthouses: every tower is built from cubes, Minecraft-style, from its DGLL ledger
// (tower type, height, colour scheme). One InstancedMesh per tower keeps ~200 towers cheap.
// The lamp stays a separate mesh named "lamp" so the layer can flash it.
import * as THREE from 'three';

const VOX = 1.5;                               // metres per voxel
const C = {
  red: 0xc8322b, white: 0xf2efe8, black: 0x2a2c31, stone: 0xa89877, yellow: 0xe3b33b,
  grey: 0x8d949b, iron: 0x33373e, dome: 0xa8321f, buff: 0xd99a6c, plinth: 0x6f6a60,
  hull: 0xb3261c, deck: 0x7a2a22, silver: 0xc9ced3, solar: 0x1d2a3a,
};

/* ------------------------------------------------------------ parse ledger */
export function towerSpec(lh) {
  const type = (lh.tower_type || '').toLowerCase();
  const col = (lh.tower_colour || '').toLowerCase();
  let shape = 'round';
  if (/triang/.test(type)) shape = 'triangle';
  else if (/hexag|octag/.test(type)) shape = 'octagon';
  else if (/square|rectang/.test(type)) shape = 'square';
  else if (/skeleton|trestle|lattice|steel structure|framework|mast/.test(type)) shape = 'skeletal';
  const tapering = /taper|conical|cone/.test(type) || (shape === 'round' && /masonry|brick|stone/.test(type));
  let pattern = 'plain', a = C.white, b = C.white;
  const has = w => col.includes(w);
  if (has('spiral') || has('helical') || has('diagonal')) pattern = 'spiral';
  else if (/band|strip|horizontal|chequer/.test(col)) pattern = 'bands';
  if (has('red') && has('white')) { a = C.red; b = C.white; if (pattern === 'plain') pattern = 'bands'; }
  else if (has('black') && has('white')) { a = C.black; b = C.white; if (pattern === 'plain') pattern = 'bands'; }
  else if (has('yellow')) { a = C.yellow; b = has('black') ? C.black : C.yellow; }
  else if (/stone|natural|unpainted|granite|laterite/.test(col + ' ' + type) && !has('white')) { a = b = C.stone; }
  else if (has('red')) { a = b = C.red; }
  if (/thangasseri/.test(lh.id || lh.slug || '')) pattern = 'spiral';
  if (/mahabalipuram/.test(lh.id || lh.slug || '')) { a = b = C.stone; pattern = 'plain'; }
  const h = Math.max(9, Math.min(70, lh.tower_h_m || 25));
  return { shape, tapering, pattern, a, b, h, marina: /chennai-lighthouse/.test(lh.id || lh.slug || '') };
}

/* ------------------------------------------------------------------ voxels */
const box = new THREE.BoxGeometry(1, 1, 1);
const voxMat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, flatShading: true });
const hash = (x, y, z) => { const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return s - Math.floor(s); };

class Voxels {
  constructor() { this.cells = new Map(); }
  set(x, y, z, color, grain = 0.08) { this.cells.set(`${x},${y},${z}`, [x, y, z, color, grain]); }
  has(x, y, z) { return this.cells.has(`${x},${y},${z}`); }
  mesh() {
    const list = [...this.cells.values()];
    const m = new THREE.InstancedMesh(box, voxMat, list.length);
    const mat = new THREE.Matrix4(), col = new THREE.Color();
    list.forEach(([x, y, z, c, g], i) => {
      mat.makeScale(VOX, VOX, VOX).setPosition(x * VOX, (y + 0.5) * VOX, z * VOX);
      m.setMatrixAt(i, mat);
      col.setHex(c);
      const k = 1 + (hash(x, y, z) - 0.5) * 2 * g;           // per-block shade, like a block texture
      col.setRGB(Math.min(1, col.r * k), Math.min(1, col.g * k), Math.min(1, col.b * k));
      m.setColorAt(i, col);
    });
    m.frustumCulled = false;
    return m;
  }
}

function inside(shape, x, z, r) {
  switch (shape) {
    case 'square': return Math.abs(x) <= r && Math.abs(z) <= r;
    case 'octagon': return Math.abs(x) <= r && Math.abs(z) <= r && Math.abs(x) + Math.abs(z) <= Math.round(r * 1.45);
    case 'triangle': return z >= -r && z <= r && Math.abs(x) <= Math.round((z + r) * 0.6);
    default: return x * x + z * z <= r * r + r;
  }
}

function colourAt(spec, x, y, z, levels) {
  if (spec.pattern === 'bands') {
    const band = Math.floor((levels - 1 - y) / Math.max(1, Math.round(levels / 5)));
    return band % 2 === 0 ? spec.a : spec.b;
  }
  if (spec.pattern === 'spiral') {
    const turn = (Math.atan2(z, x) / (Math.PI * 2) + 0.5) * 4 + (y / levels) * 5;
    return Math.floor(turn) % 2 === 0 ? spec.a : spec.b;
  }
  return spec.a;
}

function lanternTop(v, group, cy, r, spec) {
  // gallery deck + railing, lantern (the flashing lamp), dome and finial
  for (let x = -r - 1; x <= r + 1; x++) for (let z = -r - 1; z <= r + 1; z++) {
    if (inside('square', x, z, r + 1)) v.set(x, cy, z, C.iron, 0.05);
    const edge = Math.abs(x) === r + 1 || Math.abs(z) === r + 1;
    if (edge && (x + z) % 2 === 0) v.set(x, cy + 1, z, C.iron, 0.05);
  }
  const lw = Math.max(1, 2 * Math.min(r, 1) + 1);
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(lw * VOX * 0.9, 2 * VOX, lw * VOX * 0.9),
    new THREE.MeshBasicMaterial({ color: 0xfff1b8, transparent: true }));
  lamp.position.y = (cy + 2) * VOX;
  lamp.name = 'lamp';
  group.add(lamp);
  const half = Math.floor(lw / 2);
  for (let x = -half; x <= half; x++) for (let z = -half; z <= half; z++) v.set(x, cy + 3, z, C.dome, 0.12);
  v.set(0, cy + 4, 0, C.dome, 0.12);
  v.set(0, cy + 5, 0, C.iron, 0);
  return lamp.position.y;
}

export function buildLighthouse(lh) {
  const spec = towerSpec(lh);
  const group = new THREE.Group();
  const v = new Voxels();
  const levels = Math.max(6, Math.round(spec.h / VOX));
  const baseR = spec.shape === 'triangle' ? 4 : Math.max(2, Math.round(levels * 0.11));
  const topR = spec.tapering ? Math.max(1, Math.round(baseR * 0.65)) : baseR;

  // plinth
  for (let x = -baseR - 2; x <= baseR + 2; x++) for (let z = -baseR - 2; z <= baseR + 2; z++) v.set(x, 0, z, C.plinth, 0.15);

  if (spec.shape === 'skeletal') {
    const r = Math.max(2, baseR);
    for (let y = 1; y <= levels; y++) {
      const k = Math.round(r - (r - 1) * (y / levels));
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) v.set(sx * k, y, sz * k, spec.a === C.white ? C.grey : spec.a, 0.06);
      if (y % 3 === 0) for (let i = -k; i <= k; i++) { v.set(i, y, k, C.grey, 0.06); v.set(i, y, -k, C.grey, 0.06); v.set(k, y, i, C.grey, 0.06); v.set(-k, y, i, C.grey, 0.06); }
    }
    const focal = lanternTop(v, group, levels + 1, 1, spec);
    group.add(v.mesh());
    group.userData = { spec: { ...spec, h: (levels + 7) * VOX }, focal };
    return group;
  }

  for (let y = 1; y <= levels; y++) {
    const r = Math.round(baseR + (topR - baseR) * ((y - 1) / Math.max(1, levels - 1)));
    for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) {
      if (!inside(spec.shape, x, z, r)) continue;
      const edge = !inside(spec.shape, x + 1, z, r) || !inside(spec.shape, x - 1, z, r) || !inside(spec.shape, x, z + 1, r) || !inside(spec.shape, x, z - 1, r);
      if (!edge) continue;
      const c = colourAt(spec, x, y, z, levels + 1);
      v.set(x, y, z, c, c === C.stone ? 0.22 : 0.08);
    }
    // a window every few levels, spiralling up the stair
    if (y % 4 === 2) { const a = y * 1.3; v.set(Math.round(Math.cos(a) * r), y, Math.round(Math.sin(a) * r), 0x15171b, 0); }
  }
  if (spec.marina) for (let y = 1; y <= levels + 1; y++) for (let z = -1; z <= 1; z++) v.set(-baseR - 2, y, z, C.buff, 0.1);
  const focal = lanternTop(v, group, levels + 1, Math.max(1, topR), spec);
  group.add(v.mesh());
  group.userData = { spec: { ...spec, h: (levels + 7) * VOX }, focal };
  return group;
}

/* ------------------------------------------------------------ light vessel */
// Perigee Light Vessel after DGLL's photograph: red flat-decked hull, red trestle amidships with a
// silver radar reflector and a red lantern bowl, ladder mast, aft deckhouse with solar panels,
// small forward cabin and pole mast. Everything that rides the sea is inside "swell".
export function buildLightVessel() {
  const group = new THREE.Group();
  const swell = new THREE.Group();
  swell.name = 'swell';
  swell.rotation.order = 'YXZ';
  group.add(swell);
  const v = new Voxels();
  for (let x = -10; x <= 10; x++) {
    const w = x > 6 ? Math.max(0, 3 - (x - 6)) : 3;              // bow narrows
    for (let z = -w; z <= w; z++) {
      v.set(x, 0, z, C.hull, 0.1);
      const edge = Math.abs(z) === w || x === -10 || x === 10 || (x > 6 && Math.abs(z) >= w);
      v.set(x, 1, z, edge ? C.hull : C.deck, 0.1);
      if (edge && (x + z) % 2 === 0) v.set(x, 2, z, C.iron, 0.04);   // deck rail
    }
  }
  for (let y = 2; y <= 8; y++) for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) v.set(sx, y, sz, C.hull, 0.08);
  for (let i = -1; i <= 1; i++) { v.set(i, 5, 1, C.hull, 0.08); v.set(i, 5, -1, C.hull, 0.08); }
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) v.set(x, 9, z, C.silver, 0.05);
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) if (Math.abs(x) + Math.abs(z) <= 3) { v.set(x, 10, z, C.hull, 0.1); v.set(x, 11, z, C.hull, 0.1); }
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) if ((Math.abs(x) === 2 || Math.abs(z) === 2) && (x + z) % 2 === 0) v.set(x, 12, z, C.iron, 0);
  for (let y = 2; y <= 13; y++) v.set(2, y, 2, C.iron, 0);
  for (let x = -8; x <= -6; x++) for (let z = -1; z <= 1; z++) { v.set(x, 2, z, C.hull, 0.1); v.set(x, 3, z, C.hull, 0.1); v.set(x, 4, z, C.solar, 0.05); }
  for (let x = 5; x <= 6; x++) for (let z = -1; z <= 0; z++) v.set(x, 2, z, C.hull, 0.1);
  for (let y = 2; y <= 5; y++) v.set(8, y, 0, C.iron, 0);
  swell.add(v.mesh());
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(VOX * 0.9, VOX * 1.2, VOX * 0.9), new THREE.MeshBasicMaterial({ color: 0xfff1b8, transparent: true }));
  lamp.position.y = 13 * VOX;
  lamp.name = 'lamp';
  swell.add(lamp);
  group.userData = { spec: { h: 15 * VOX, shape: 'vessel' }, focal: lamp.position.y };
  return group;
}
