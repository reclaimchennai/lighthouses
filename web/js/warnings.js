// Warning archive page: every NHO navigational warning seen, in force or ended (data/warnings_archive.json).
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const CATEGORY = {
  firing: ['Firing / danger area', '#ff5a4f'], operations: ['Survey, rig or cable work', '#ffb03a'],
  danger: ['Wreck or danger', '#ff6ad5'], aton: ['Light, buoy or RACON', '#ffd84a'],
  notice: ['Notice to mariners', '#a99bff'], misc: ['Other', '#5fc8ff'],
};
const KIND = { NAVTEX: 'NAVTEX', NAVAREA: 'NAVAREA VIII', 'T&P': 'T&P notice' };
const EFFECT = { unlit: 'light reported unlit', racon_off: 'RACON off', dgnss_off: 'DGNSS off air', ais_off: 'AIS off', racon_new: 'new RACON' };
const day = iso => (iso || '').slice(0, 10);

const [{ meta, warnings }, lh] = await Promise.all([
  fetch('data/warnings_archive.json').then(r => r.json()),
  fetch('data/lighthouses.json').then(r => r.json()),
]);
const stationName = Object.fromEntries(lh.stations.map(s => [s.id, s.name]));

const inForce = warnings.filter(w => w.status === 'active');
$('#tstats').innerHTML = [
  [meta.in_force?.NAVTEX ?? 0, 'NAVTEX in force'], [meta.in_force?.NAVAREA ?? 0, 'NAVAREA VIII in force'],
  [meta.in_force?.['T&P'] ?? 0, 'T&P notices in force'], [warnings.length, 'in the archive'],
  // one count per lighthouse: NHO issues each outage as both NAVTEX and NAVAREA VIII
  [new Set(inForce.filter(w => (w.effects || []).some(e => e !== 'racon_new')).flatMap(w => w.stations || [])).size, 'lighthouses with an outage'],
].map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('');

const opt = (sel, entries) => { for (const [v, l] of entries) sel.insertAdjacentHTML('beforeend', `<option value="${esc(v)}">${esc(l)}</option>`); };
opt($('#kind'), Object.entries(KIND));
opt($('#cat'), Object.entries(CATEGORY).map(([k, [l]]) => [k, l]));
opt($('#yr'), [...new Set(warnings.map(w => (w.issued || '').slice(0, 4)).filter(Boolean))].sort().reverse().map(y => [y, y]));

function body(w) {
  const f = (k, v) => (v ? `<dt>${k}</dt><dd>${v}</dd>` : '');
  const stations = (w.stations || []).map(id => `<a href="./#${esc(id)}">${esc(stationName[id] || id)}</a>`).join(', ');
  return `<div class="tb">
    <p class="msg">${esc(w.message)}</p>
    <dl>
      ${f('Kind', esc(KIND[w.kind] || w.kind))}
      ${f('Identifier', esc(w.identifier))}
      ${f('Broadcast', w.b_char ? `${esc(w.b_char)}${(w.navtex_stations || []).length ? ` · ${esc(w.navtex_stations.map(id => (stationName[id] || id).replace(/\s+(Lighthouse|Light House).*$/i, '')).join(', '))}` : ''}` : '')}
      ${f('Place', esc([w.area, w.place].filter(Boolean).join(' · ')))}
      ${f('Issued', esc(w.dtg || w.issued))}
      ${f('Cancels itself', esc(w.cancel_at ? w.cancel_at.replace('T', ' ').replace(':00Z', ' UTC') : ''))}
      ${f('Cancels', esc((w.cancels || []).join(', ')))}
      ${f('Charts', esc((w.charts || []).join(' ')))}
      ${f('Effect', esc((w.effects || []).map(e => EFFECT[e] || e).join(', ')))}
      ${f('Lighthouses', stations)}
      ${f('First listed', esc(day(w.first_seen)))}
      ${f('Last listed', esc(day(w.last_seen)))}
      ${f('Ended', w.status === 'ended' ? esc(w.ended ? `by ${day(w.ended)}` : `after ${day(w.last_seen)}`) : '')}
      ${f('Sources', esc((w.sources || []).map(s => s === 'api' ? 'India WINS' : s.replace('pdf:', 'PDF ')).join(', ')))}
    </dl>
    <p class="note fine">${w.has_geometry && w.status === 'active' ? `<a href="./#warning=${encodeURIComponent(w.key)}">Show on the map</a> · ` : ''}<a href="${esc(w.link)}" target="_blank" rel="noopener">NHO</a></p>
  </div>`;
}

function render() {
  const q = $('#q').value.trim().toLowerCase(), kind = $('#kind').value, cat = $('#cat').value, st = $('#status').value, yr = $('#yr').value;
  const rows = warnings.filter(w => (!kind || w.kind === kind) && (!cat || w.category === cat) && (!st || w.status === st)
    && (!yr || (w.issued || '').startsWith(yr))
    && (!q || [w.identifier, w.place, w.area, w.message, w.b_char, ...(w.stations || []).map(id => stationName[id])].join(' ').toLowerCase().includes(q)));
  $('#count').textContent = `${rows.length} of ${warnings.length} warnings`;
  $('#list').innerHTML = rows.map(w => {
    const [label, colour] = CATEGORY[w.category] || CATEGORY.misc;
    const gone = w.status === 'active' && w.cancel_at && w.cancel_at < new Date().toISOString();
    return `<details class="warn" id="w-${esc(w.key.replace(/[^\w-]/g, '_'))}" style="border-left-color:${colour}">
      <summary>
        <span class="d">${esc(day(w.issued) || '–')}</span>
        <span class="h">${esc(KIND[w.kind] || w.kind)} ${esc(w.identifier)} · ${esc(w.place || w.area || label)}</span>
        <span class="sub">
          <span class="chipx" style="color:${colour}">${esc(label)}</span>
          <span class="chipx ${w.status === 'active' ? 'on' : ''}">${w.status === 'active' ? 'in force' : 'ended'}</span>
          ${gone ? '<span class="chipx warnc">cancel time passed</span>' : ''}
          ${(w.stations || []).map(id => `<span class="chipx site">${esc(stationName[id] || id)}</span>`).join('')}
        </span>
      </summary><div class="lazy"></div></details>`;
  }).join('');
  for (const el of document.querySelectorAll('.warn')) {
    el.addEventListener('toggle', () => {
      const lazy = el.querySelector('.lazy');
      if (el.open && lazy) lazy.outerHTML = body(rows.find(w => `w-${w.key.replace(/[^\w-]/g, '_')}` === el.id));
    });
  }
}
for (const id of ['#q', '#kind', '#cat', '#status', '#yr']) $(id).addEventListener('input', render);
render();
if (location.hash) {
  const el = document.getElementById(decodeURIComponent(location.hash.slice(1)));
  if (el) { el.open = true; el.scrollIntoView(); }
}
