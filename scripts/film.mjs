// Render a scripted film of the map (js/film.js) frame by frame in headless Chrome, then encode it.
//   node film.mjs <outdir> [--workers 3] [--shots a-b] [--site URL]
// Frames land in <outdir>/shot-NN/fNNNN.jpg; encode with scripts/film_encode.sh.
// The page's clock is virtual (below), so a frame can take as long as it needs to draw and load its tiles.
import { chromium } from "/usr/lib/node_modules/playwright/index.mjs";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const outdir = args[0];
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : args[i + 1]; };
const WORKERS = +opt("workers", 3);
const SITE = opt("site", "https://maps.reclaimchennai.city/lighthouses/");
const only = opt("shots", null);
const W = 1280, H = 720, MAXF = +opt("max", 1e9);

const VIRTUAL_CLOCK = () => {
  if (!location.search.includes("film")) return;
  const realNow = performance.now.bind(performance);
  let vnow = 1000, id = 0, q = [];
  performance.now = () => vnow;
  window.__realNow = realNow;
  window.requestAnimationFrame = cb => { q.push([++id, cb]); return id; };
  window.cancelAnimationFrame = i => { q = q.filter(x => x[0] !== i); };
  window.__vstep = dt => { vnow += dt; const run = q; q = []; for (const [, cb] of run) { try { cb(vnow); } catch (e) { console.error(e); } } };
};

async function open() {
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--disable-gpu-vsync"] });
  const page = await (await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })).newPage();
  await page.addInitScript(VIRTUAL_CLOCK);
  page.on("pageerror", e => console.log("  page error:", e.message));
  await page.goto(`${SITE}?film=tamilnadu&t=${Date.now()}`, { waitUntil: "domcontentloaded" });
  // the page waits on animation frames (map load, data), so keep stepping its clock until the film is ready
  for (let n = 0; n < 1200; n++) {
    if (await page.evaluate(() => { window.__vstep?.(16); return !!window.__filmReady; })) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (!(await page.evaluate(() => !!window.__filmReady))) throw new Error("the film never became ready");
  const info = await page.evaluate(() => window.__film.ready());
  return { browser, page, info };
}

// the shot list comes from the page; each worker takes a contiguous run of shots
const probe = await open();
const plan = await probe.page.evaluate(() => window.__film.plan());
await probe.browser.close();
console.log(`${plan.length} shots, ${plan.reduce((a, s) => a + s.frames, 0)} frames`);
writeFileSync(`${outdir}/plan.json`, JSON.stringify(plan));

let [a, b] = only ? only.split("-").map(Number) : [0, plan.length - 1];
const all = []; for (let k = a; k <= b; k++) all.push(k);
const chunks = Array.from({ length: WORKERS }, () => []);
const per = Math.ceil(all.length / WORKERS);
all.forEach((k, i) => chunks[Math.floor(i / per)].push(k));

async function work(ks, n) {
  if (!ks.length) return;
  const { browser, page } = await open();
  for (const k of ks) {
    const dir = `${outdir}/shot-${String(k).padStart(2, "0")}`;
    if (existsSync(`${dir}/done`)) continue;
    mkdirSync(dir, { recursive: true });
    await page.evaluate(k => window.__film.prime(k), k);
    await page.evaluate(k => window.__film.begin(k), k);
    const t0 = Date.now();
    for (let i = 0; i < Math.min(plan[k].frames, MAXF); i++) {
      const url = await page.evaluate(i => window.__film.frame(i), i);
      writeFileSync(`${dir}/f${String(i).padStart(4, "0")}.jpg`, Buffer.from(url.split(",")[1], "base64"));
    }
    writeFileSync(`${dir}/done`, "");
    console.log(`[w${n}] shot ${k} (${plan[k].id || plan[k].kind}): ${plan[k].frames} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  await browser.close();
}
await Promise.all(chunks.map((ks, n) => work(ks, n)));
console.log("rendered");
