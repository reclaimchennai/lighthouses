// Pop-up media viewer: station photos and the pictures / videos a user captures.
//
// Photos open instantly on a small but legible preview; the untouched original loads only when asked
// ("Full resolution", with its size), streamed with progress. Pinch, wheel or +/− to zoom, drag to pan,
// double-tap to toggle. Captured media can be saved or shared from here. Accessible dialog: focus
// moves in, Esc closes, focus returns.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = n => `<svg class="i" aria-hidden="true"><use href="icons.svg?v=2#${n}"/></svg>`;
const mb = b => b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`;

let current = null;

export function closeViewer() { current?.(); }

export function openViewer(o) {
  closeViewer();
  const returnFocus = document.activeElement;
  const urls = [];
  const blobUrl = o.blob ? URL.createObjectURL(o.blob) : null;
  if (blobUrl) urls.push(blobUrl);
  const video = o.kind === 'video';
  const el = document.createElement('div');
  el.className = 'viewer';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', o.title || 'Viewer');
  el.innerHTML = `
    <div class="v-bar">
      <div class="v-title"><b>${esc(o.title)}</b>${o.subtitle ? `<small>${esc(o.subtitle)}</small>` : ''}</div>
      <div class="v-actions">
        ${video || o.mount ? '' : `<button type="button" class="btn icon v-out" aria-label="Zoom out">−</button>
          <button type="button" class="btn icon v-in" aria-label="Zoom in">+</button>`}
        ${o.full ? `<button type="button" class="btn v-full">${icon('eye')}Full resolution${o.fullBytes ? ` · ${mb(o.fullBytes)}` : ''}</button>` : ''}
        ${o.blob ? `<button type="button" class="btn v-save">${icon('down')}Save</button>` : ''}
        ${o.blob && navigator.canShare ? `<button type="button" class="btn v-share">${icon('external')}Share</button>` : ''}
      </div>
      <button type="button" class="btn icon v-close" aria-label="Close">${icon('close')}</button>
    </div>
    <div class="v-stage">
      ${o.mount ? '' : video ? `<video src="${blobUrl || esc(o.src)}" controls playsinline autoplay loop muted></video>` : `<img alt="${esc(o.alt || o.title)}" draggable="false"${o.blob ? ' class="pixel"' : ''}>`}
      <div class="v-status" role="status" aria-live="polite"></div>
    </div>
    ${o.credit ? `<div class="v-credit">${o.credit}</div>` : ''}`;
  document.body.appendChild(el);
  document.body.classList.add('viewer-open');

  const stage = el.querySelector('.v-stage'), img = el.querySelector('img'), status = el.querySelector('.v-status');
  const say = t => { status.textContent = t || ''; };
  // a live scene (the 3D scan viewer) mounts into the stage and hands back its own cleanup
  const unmount = o.mount ? o.mount(stage, say) : null;

  function close() {
    try { unmount?.(); } catch (e) { /* already torn down */ }
    el.remove();
    document.body.classList.remove('viewer-open');
    removeEventListener('keydown', onKey, true);
    urls.forEach(u => URL.revokeObjectURL(u));
    current = null;
    if (returnFocus && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
  }
  current = close;

  // ------------------------------------------------------------ image: preview, zoom, pan
  let scale = 1, tx = 0, ty = 0;
  const apply = () => { if (img) img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; stage.classList.toggle('zoomed', scale > 1); };
  function zoomAt(f, cx, cy) {
    const r = stage.getBoundingClientRect();
    const px = (cx ?? r.left + r.width / 2) - (r.left + r.width / 2), py = (cy ?? r.top + r.height / 2) - (r.top + r.height / 2);
    const ns = Math.max(1, Math.min(8, scale * f));
    tx = px - (px - tx) * ns / scale; ty = py - (py - ty) * ns / scale; scale = ns;
    if (scale === 1) tx = ty = 0;
    apply();
  }
  if (img) {
    say('Loading…');
    img.onload = () => say('');
    img.onerror = () => say('This photo could not be loaded.');
    img.src = blobUrl || o.src;
    const pts = new Map();
    let pinch = null;
    stage.addEventListener('pointerdown', e => { stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); });
    stage.addEventListener('pointermove', e => {
      if (!pts.has(e.pointerId)) return;
      const prev = pts.get(e.pointerId);
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (pinch) zoomAt(d / pinch, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        pinch = d;
      } else if (scale > 1) { tx += e.clientX - prev[0]; ty += e.clientY - prev[1]; apply(); }
    });
    const up = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    stage.addEventListener('wheel', e => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.25 : 0.8, e.clientX, e.clientY); }, { passive: false });
    stage.addEventListener('dblclick', e => zoomAt(scale > 1 ? 1 / scale : 2.5, e.clientX, e.clientY));
    el.querySelector('.v-in').onclick = () => zoomAt(1.5);
    el.querySelector('.v-out').onclick = () => zoomAt(1 / 1.5);
  }

  // -------------------------------------------------- the original, streamed on request
  el.querySelector('.v-full')?.addEventListener('click', async ev => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      const r = await fetch(o.full);
      if (!r.ok) throw new Error(r.status);
      const total = +r.headers.get('content-length') || o.fullBytes || 0;
      const reader = r.body.getReader(), parts = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value); got += value.length;
        say(`Full resolution ${total ? Math.min(99, Math.round(got / total * 100)) + '%' : mb(got)}`);
      }
      const url = URL.createObjectURL(new Blob(parts));
      urls.push(url);
      await new Promise((res, rej) => { const i = new Image(); i.onload = res; i.onerror = rej; i.src = url; });
      img.src = url;
      say('');
      btn.innerHTML = `${icon('eye')}Full resolution${o.fullSize ? ` · ${esc(o.fullSize)}` : ''}`;
      btn.classList.add('on');
    } catch (e) {
      say('The full-resolution photo could not be loaded.');
      btn.disabled = false;
    }
  });

  // ------------------------------------------------------------------ save and share
  el.querySelector('.v-save')?.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = blobUrl; a.download = o.filename || 'lighthouses-india';
    document.body.appendChild(a); a.click(); a.remove();
  });
  el.querySelector('.v-share')?.addEventListener('click', async () => {
    const file = new File([o.blob], o.filename || 'lighthouses-india', { type: o.blob.type });
    if (!navigator.canShare({ files: [file] })) return say('This browser cannot share files; use Save.');
    try { await navigator.share({ files: [file], title: o.title }); } catch (e) { /* cancelled */ }
  });

  el.querySelector('.v-close').onclick = close;
  el.addEventListener('click', e => { if (e.target === el) close(); });
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (img && (e.key === '+' || e.key === '=')) zoomAt(1.5);
    else if (img && e.key === '-') zoomAt(1 / 1.5);
    else if (e.key === 'Tab') {                                     // keep focus inside the dialog
      const f = [...el.querySelectorAll('button:not([disabled]), video, a[href]')];
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
  }
  addEventListener('keydown', onKey, true);
  el.querySelector('.v-close').focus();
  return close;
}
