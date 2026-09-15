// Record short clips of the live map doing specific things, using headless Chrome's screencast.
//   node record_actions.mjs <outdir> [clip ...]
// Needs Chrome started with --remote-debugging-port=9333. Writes <outdir>/<clip>/%05d.jpg + frames.txt
// (ffconcat with real frame durations) for ffmpeg.
import { mkdirSync, writeFileSync } from "node:fs";

const SITE = "https://maps.reclaimchennai.city/lighthouses/";
const W = 1280, H = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CLIPS = {
  // pick a lighthouse: search, open its card
  "select-lighthouse": async (p) => {
    await p.load(SITE);
    await sleep(3000);
    await p.eval(`(() => { const s = document.getElementById("search"); s.focus(); return true; })()`);
    for (const ch of "Mahabalipuram") { await p.send("Input.insertText", { text: ch }); await sleep(120); }
    await sleep(1500);
    // the app opens a station's card from the URL hash when it loads; leave the page first so this is a real load
    await p.send("Page.navigate", { url: "about:blank" });
    await sleep(300);
    await p.load(SITE + "#mahabalipuram-lighthouse");
    await sleep(12000);
  },
  // the history slider: the coast lighting up from 1796
  "history": async (p) => {
    await p.load(SITE);
    await sleep(3000);
    await p.click("#play");
    await sleep(16000);
  },
  // colour the lights by age, equipment and visitor access
  "colour-modes": async (p) => {
    await p.load(SITE);
    await sleep(3000);
    for (const v of ["age", "tech", "visit", "light"]) { await p.click(`#colour-by [data-v="${v}"]`); await sleep(3500); }
  },
  // NAVTEX wavefronts and RACON Morse rings
  "navtex-racon": async (p) => {
    await p.load(SITE);
    await sleep(3000);
    await p.click("#l-racon");
    await p.click('[data-fly="east"]');
    await sleep(12000);
  },
  // fly to each region
  "regions": async (p) => {
    await p.load(SITE);
    await sleep(3000);
    for (const r of ["chennai", "west", "lakshadweep", "andaman"]) { await p.click(`[data-fly="${r}"]`); await sleep(4500); }
  },
  // the night-voyage camera tour
  "tour": async (p) => {
    await p.load(SITE);
    await sleep(3000);
    await p.click("#tour");
    await sleep(18000);
  },
};

async function connect() {
  const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map(), handlers = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method && handlers.has(m.method)) handlers.get(m.method)(m.params);
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const p = {
    send,
    on: (ev, fn) => handlers.set(ev, fn),
    eval: async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true })).result,
    load: async (url) => { await send("Page.navigate", { url }); await p.waitFor(`!!window.__lhReady || document.readyState === "complete"`, 20000); },
    waitFor: async (expr, ms) => { const t = Date.now(); while (Date.now() - t < ms) { const r = await p.eval(expr); if (r?.result?.value) return; await sleep(250); } },
    click: async (sel) => {
      const r = await p.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({block: "center"}); el.click(); return true; })()`);
      if (!r?.result?.value) console.warn(`  no element for ${sel}`);
      await sleep(300);
    },
  };
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  return p;
}

const [outdir, ...names] = process.argv.slice(2);
const p = await connect();
for (const name of names.length ? names : Object.keys(CLIPS)) {
  const dir = `${outdir}/${name}`;
  mkdirSync(dir, { recursive: true });
  const frames = [];
  let recording = false;
  p.on("Page.screencastFrame", (f) => {
    p.send("Page.screencastFrameAck", { sessionId: f.sessionId });
    if (!recording) return;
    const file = `${String(frames.length).padStart(5, "0")}.jpg`;
    writeFileSync(`${dir}/${file}`, Buffer.from(f.data, "base64"));
    frames.push([file, f.metadata.timestamp]);
  });
  await p.load("about:blank");
  await p.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  recording = true;
  console.log(`recording ${name}`);
  await CLIPS[name](p);
  recording = false;
  await p.send("Page.stopScreencast");
  // screencast only sends frames when something changes, so keep each frame's real duration
  const lines = ["ffconcat version 1.0"];
  frames.forEach(([file, ts], i) => {
    const next = frames[i + 1]?.[1] ?? ts + 0.1;
    lines.push(`file ${file}`, `duration ${Math.max(0.01, next - ts).toFixed(3)}`);
  });
  if (frames.length) lines.push(`file ${frames.at(-1)[0]}`);
  writeFileSync(`${dir}/frames.txt`, lines.join("\n") + "\n");
  console.log(`  ${frames.length} frames`);
}
process.exit(0);
