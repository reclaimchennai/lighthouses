// Snapshot and video recording, after pol.reclaimchennai.city (~/projects/aqi/dashboard/static/js/app.js).
//
// Every saved frame is a composite, not a raw grab: the map (with the desktop panel cropped
// away), the lighthouse names, the year watermark top-left and a credit band, so a clip or a
// picture carries its own date and provenance wherever it is shared.
//
// Video: WebCodecs H.264 muxed by mp4-muxer into an ordinary MP4 with its duration in the header
// (phone galleries and editors open it). Fallback: the composite canvas streamed through
// MediaRecorder, then the WebM duration written in (webm.js), because MediaRecorder leaves it out.
// This map animates in real time, so frames are captured live at OUT_FPS with real timestamps.
import { fixWebmDuration } from './webm.js?v=5';

const OUT_FPS = 30;
const MAX_SECONDS = 90;                  // a take is capped so a phone doesn't encode for minutes
// phones read back and encode a smaller frame, so camera moves (zoom, fly-in) keep their frames
const MAX_WIDTH = matchMedia('(min-width:821px)').matches ? 1280 : 960;
const CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.42003c', 'avc1.42E01E'];
const CREDIT = 'maps.reclaimchennai.city/lighthouses · DGLL Master Ledgers · Lok Sabha · © OpenStreetMap, OpenFreeMap · Natural Earth · DataMeet';

export function createCapture({ map, cropLeft, year, subtitle, onState }) {
  const comp = document.createElement('canvas');
  let recording = null;

  function draw() {
    const src = map.getCanvas();
    if (!src.width) return null;
    const cssW = src.clientWidth || src.width, pr = src.width / cssW;
    const left = Math.round((cropLeft() || 0) * pr);
    const sw = src.width - left, sh = src.height;
    const scale = Math.min(1, MAX_WIDTH / sw);
    const w = Math.round(sw * scale), h = Math.round(sh * scale);
    const band = Math.round(34 * Math.max(0.8, scale * pr));
    if (!recording || !comp.width) {           // size stays fixed for a whole take; even for H.264
      comp.width = w + (w % 2);
      comp.height = h + band + ((h + band) % 2);
    }
    const ctx = comp.getContext('2d');
    ctx.imageSmoothingEnabled = false;             // keep the pixel-art map crisp when scaled
    ctx.fillStyle = '#05080c';
    ctx.fillRect(0, 0, comp.width, comp.height);
    ctx.drawImage(src, left, 0, sw, sh, 0, 0, w, h);

    // lighthouse names, from the HTML label layer
    const k = w / (cssW - (cropLeft() || 0));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (const el of document.querySelectorAll('#labels .lab')) {
      const x = (parseFloat(el.style.left) - (cropLeft() || 0)) * k, y = parseFloat(el.style.top) * k;
      if (!(x > 0 && x < w && y > 0 && y < h)) continue;
      const major = el.classList.contains('major');
      ctx.font = `${major ? 600 : 400} ${Math.round((major ? 12 : 11) * k)}px "Pixelify Sans", monospace`;
      ctx.lineWidth = 3 * k; ctx.strokeStyle = 'rgba(0,0,0,.85)';
      const ty = y - 10 * k;
      ctx.strokeText(el.textContent, x, ty);
      ctx.fillStyle = el.classList.contains('nav') ? '#3fd6ff' : el.classList.contains('planned') ? '#d9a066' : '#e6ecf1';
      ctx.fillText(el.textContent, x, ty);
    }

    // year watermark, top left
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const s = Math.max(0.8, w / 900);
    ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowBlur = 8 * s;
    ctx.fillStyle = '#ffffff';
    ctx.font = `600 ${Math.round(34 * s)}px "Pixelify Sans", monospace`;
    ctx.fillText(String(year()), Math.round(18 * s), Math.round(16 * s));
    ctx.font = `400 ${Math.round(12 * s)}px "Pixelify Sans", monospace`;
    ctx.fillStyle = 'rgba(255,255,255,.8)';
    ctx.fillText(subtitle(), Math.round(19 * s), Math.round(56 * s));
    ctx.shadowBlur = 0;

    // credit band
    ctx.fillStyle = '#0a0f15';
    ctx.fillRect(0, h, comp.width, comp.height - h);
    ctx.fillStyle = '#8e99a4';
    ctx.textBaseline = 'middle';
    ctx.font = `400 ${Math.round(12 * s)}px "Pixelify Sans", monospace`;
    ctx.fillText(CREDIT, Math.round(14 * s), h + (comp.height - h) / 2, comp.width - 28 * s);
    return comp;
  }

  function stamp() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 20000);
  }

  function snapshot() {
    map.triggerRepaint();
    map.once('render', () => {
      const c = draw();
      if (!c) return onState({ note: 'The map is not ready yet.', warn: true });
      c.toBlob(b => { download(b, `lighthouses-india-${year()}-${stamp()}.png`); onState({ note: 'Picture saved.' }); }, 'image/png');
    });
  }

  async function pickCodec(width, height) {
    for (const codec of CODECS) {
      const config = { codec, width, height, bitrate: 8_000_000, framerate: OUT_FPS, avc: { format: 'avc' } };
      try { if ((await VideoEncoder.isConfigSupported(config)).supported) return config; } catch (e) { /* next */ }
    }
    return null;
  }

  // Live capture loop shared by both encoders: one composite per OUT_FPS tick, drawn right after
  // MapLibre renders so the WebGL buffer still holds the frame.
  function loop(onFrame) {
    return new Promise(resolve => {
      const t0 = performance.now();
      let last = -1;
      const tick = () => {
        if (!recording || recording.stop) return resolve(performance.now() - t0);
        const t = performance.now() - t0;
        if (t / 1000 >= MAX_SECONDS) return resolve(t);
        const n = Math.floor(t / (1000 / OUT_FPS));
        if (n !== last) {
          last = n;
          const c = draw();
          if (c) onFrame(c, t);
          onState({ recording: true, seconds: t / 1000 });
        }
        map.triggerRepaint();
        map.once('render', () => requestAnimationFrame(tick));
      };
      tick();
    });
  }

  async function recordMp4() {
    const first = draw();
    const config = first && await pickCodec(first.width, first.height);
    if (!config) return false;
    const target = new Mp4Muxer.ArrayBufferTarget();
    const muxer = new Mp4Muxer.Muxer({ target, video: { codec: 'avc', width: first.width, height: first.height, frameRate: OUT_FPS }, fastStart: 'in-memory' });
    let failure = null, frames = 0;
    const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => { failure = e; } });
    encoder.configure(config);
    const ms = await loop((c, t) => {
      if (failure || encoder.encodeQueueSize > 30) return;          // drop a frame rather than stall the map
      const frame = new VideoFrame(c, { timestamp: Math.round(t * 1000), duration: Math.round(1e6 / OUT_FPS) });
      encoder.encode(frame, { keyFrame: frames % (OUT_FPS * 2) === 0 });
      frame.close();
      frames++;
    });
    try { await encoder.flush(); muxer.finalize(); } catch (e) { failure = e; }
    try { encoder.close(); } catch (e) { /* closed */ }
    if (failure || frames < 2) return false;
    download(new Blob([target.buffer], { type: 'video/mp4' }), `lighthouses-india-${year()}-${stamp()}.mp4`);
    onState({ note: `Saved ${(ms / 1000).toFixed(1)} s MP4.` });
    return true;
  }

  async function recordWebm() {
    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
    const mime = types.find(t => !MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(t));
    if (!mime || !draw()) return false;
    const stream = comp.captureStream(OUT_FPS);
    let rec;
    try { rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 }); } catch (e) { return false; }
    const chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise(r => { rec.onstop = r; });
    rec.start(250);
    const ms = await loop(() => {});
    try { rec.requestData(); } catch (e) { /* ignore */ }
    await new Promise(r => setTimeout(r, 150));
    try { rec.stop(); } catch (e) { /* ignore */ }
    await stopped;
    stream.getTracks().forEach(t => t.stop());
    if (!chunks.length) return false;
    let blob = new Blob(chunks, { type: mime });
    if (mime.startsWith('video/webm')) blob = await fixWebmDuration(blob, ms);
    download(blob, `lighthouses-india-${year()}-${stamp()}.${mime.startsWith('video/webm') ? 'webm' : 'mp4'}`);
    onState({ note: `Saved ${(ms / 1000).toFixed(1)} s video (this browser has no MP4 encoder, so WebM).` });
    return true;
  }

  async function toggleRecording() {
    if (recording) { recording.stop = true; return; }
    const hasCodecs = typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined' && typeof Mp4Muxer !== 'undefined';
    const hasStream = typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;
    if (!hasCodecs && !hasStream) return onState({ note: 'This browser cannot record video. The picture button still works.', warn: true });
    recording = { stop: false };
    comp.width = 0;
    onState({ recording: true, seconds: 0 });
    let ok = false;
    try {
      if (hasCodecs) ok = await recordMp4();
      if (!ok && hasStream) { recording = { stop: false }; comp.width = 0; ok = await recordWebm(); }
    } catch (e) { ok = false; }
    recording = null;
    comp.width = 0;
    onState({ recording: false });
    if (!ok) onState({ note: 'The recording failed in this browser. The picture button still works.', warn: true });
  }

  return { snapshot, toggleRecording, get recording() { return !!recording; }, maxSeconds: MAX_SECONDS };
}
