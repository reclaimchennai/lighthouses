// Tender archive page: every DGLL tender, its backed-up documents and transcribed fields.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = n => `<svg class="i" aria-hidden="true"><use href="icons.svg?v=2#${n}"/></svg>`;
const nf = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const inr = v => v >= 1e7 ? `₹${nf.format(v / 1e7)} cr` : v >= 1e5 ? `₹${nf.format(v / 1e5)} lakh` : `₹${nf.format(v)}`;
const kb = b => b >= 1e6 ? `${nf.format(b / 1e6)} MB` : `${Math.round(b / 1e3)} KB`;

const [{ meta, tenders }, lh] = await Promise.all([
  fetch('data/tenders.json').then(r => r.json()),
  fetch('data/lighthouses.json').then(r => r.json()),
]);
const stationName = Object.fromEntries(lh.stations.map(s => [s.id, s.name]));
const dateOf = t => t.end || t.dates?.bid_submission_end || t.start || t.dates?.published || '';

const totalCost = tenders.reduce((a, t) => a + (t.money?.estimated_cost_inr || 0), 0);
$('#tstats').innerHTML = [
  [meta.tenders, 'tenders'], [meta.documents, 'documents backed up'],
  [meta.linked_stations, 'stations named'], [inr(totalCost), 'estimated cost stated'],
].map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('');

const opts = (sel, values) => { for (const v of values) sel.insertAdjacentHTML('beforeend', `<option>${esc(v)}</option>`); };
opts($('#dir'), [...new Set(tenders.map(t => t.region).filter(Boolean))].sort());
opts($('#cat'), [...new Set(tenders.map(t => t.category).filter(Boolean))].sort());
opts($('#yr'), [...new Set(tenders.map(t => dateOf(t).slice(0, 4)).filter(Boolean))].sort().reverse());

const params = new URLSearchParams(location.search);
if (params.get('dir')) $('#dir').value = params.get('dir');

const haystack = t => [t.title, t.listing_title, t.summary, t.directorate, t.category, t.procurement?.reference,
  ...(t.sites || []).map(s => `${s.name} ${s.work || ''}`), ...(t.scope || []).map(x => x.item), ...(t.specs || [])]
  .join(' ').toLowerCase();

function field(label, value) { return value ? `<dt>${label}</dt><dd>${value}</dd>` : ''; }

function body(t) {
  const m = t.money || {}, p = t.procurement || {}, per = t.period || {}, d = t.dates || {};
  const sites = (t.sites || []).map(s => `<li>${s.station_id ? `<a href="./#${esc(s.station_id)}">${esc(stationName[s.station_id] || s.name)}</a>` : esc(s.name)}${s.kind ? ` <span class="chipx">${esc(s.kind)}</span>` : ''}${s.work ? `: ${esc(s.work)}` : ''}</li>`).join('');
  const scope = (t.scope || []).length ? `<div class="scroll"><table><thead><tr><th>Item</th><th>Qty</th><th>Unit</th><th>Site</th></tr></thead><tbody>${
    t.scope.map(x => `<tr><td>${esc(x.item)}</td><td>${esc(x.qty ?? '')}</td><td>${esc(x.unit ?? '')}</td><td>${esc(x.site ?? '')}</td></tr>`).join('')}</tbody></table></div>` : '';
  const docs = t.docs.map(x => `<li>${icon('doc')} ${x.mirror ? `<a href="${esc(x.mirror)}" target="_blank" rel="noopener">${esc(x.file)}</a>` : esc(x.file || x.url)}
      <span class="chipx">${esc(x.kind)}</span>${x.pages ? ` ${x.pages} pp` : ''}${x.bytes ? ` · ${kb(x.bytes)}` : ''}${x.read ? ` · read from ${esc(x.read)}` : ''}
      · <a href="${esc(x.url)}" target="_blank" rel="noopener">DGLL original</a>
      ${(x.unreadable || []).length ? `<br><span class="chipx warn">unreadable</span> ${esc(x.unreadable.join('; '))}` : ''}</li>`).join('');
  return `<div class="tb">
    ${t.summary ? `<p>${esc(t.summary)}</p>` : '<p class="note">Not transcribed yet: see the documents.</p>'}
    ${sites ? `<h5>Sites</h5><ul>${sites}</ul>` : t.scope_level === 'directorate' ? `<p class="note">Covers the ${esc(t.region)} directorate without naming stations.</p>` : ''}
    <h5>Key facts</h5><dl>
      ${field('Directorate', esc(t.directorate))}
      ${field('Procurement', esc([p.mode, p.portal].filter(Boolean).join(' · ')))}
      ${field('Reference', esc(p.reference))}
      ${field('Issued by', esc(p.issuing_office))}
      ${field('Estimated cost', m.estimated_cost_inr ? inr(m.estimated_cost_inr) : '')}
      ${field('EMD', m.emd_inr ? inr(m.emd_inr) : '')}
      ${field('Tender fee', m.tender_fee_inr ? inr(m.tender_fee_inr) : '')}
      ${field('Performance security', esc(m.performance_security))}
      ${field('Money notes', esc(m.notes))}
      ${field('Completion', esc(per.completion))}
      ${field('Bid validity', esc(per.bid_validity))}
      ${field('Warranty', esc(per.warranty))}
      ${field('Published', esc(d.published || t.start))}
      ${field('Pre-bid', esc(d.pre_bid))}
      ${field('Bids close', esc(d.bid_submission_end || t.end))}
      ${field('Bids open', esc(d.bid_opening || t.bid_opening))}
    </dl>
    ${scope ? `<h5>Scope</h5>${scope}` : ''}
    ${(t.specs || []).length ? `<h5>Specifications</h5><ul>${t.specs.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${(t.eligibility || []).length ? `<h5>Eligibility</h5><ul>${t.eligibility.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${(t.corrigenda || []).length ? `<h5>Corrigenda</h5><ul>${t.corrigenda.map(x => `<li>${esc(x.date || '')} ${esc(x.change)}</li>`).join('')}</ul>` : ''}
    ${t.notes ? `<h5>Notes</h5><p>${esc(t.notes)}</p>` : ''}
    <h5>Documents</h5><ul class="docs">${docs || '<li>No document attached to the listing.</li>'}</ul>
    <p class="note fine">DGLL tender ID ${t.nid} · <a href="${esc(t.listing_url)}" target="_blank" rel="noopener">listing page</a>${t.confidence ? ` · transcription confidence ${esc(t.confidence)}` : ''}</p>
  </div>`;
}

function render() {
  const q = $('#q').value.trim().toLowerCase(), dir = $('#dir').value, cat = $('#cat').value, yr = $('#yr').value;
  const rows = tenders.filter(t => (!dir || t.region === dir) && (!cat || t.category === cat)
    && (!yr || dateOf(t).startsWith(yr)) && (!q || haystack(t).includes(q)))
    .sort((a, b) => dateOf(b).localeCompare(dateOf(a)) || b.nid - a.nid);
  $('#count').textContent = `${rows.length} of ${tenders.length} tenders`;
  $('#list').innerHTML = rows.map(t => {
    const named = (t.sites || []).filter(s => s.station_id).slice(0, 4);
    return `<details class="tender" id="t-${t.nid}">
      <summary>
        <span class="d">${esc(dateOf(t).slice(0, 7) || '–')}</span>
        <span class="h">${esc(t.title)}</span>
        <span class="m">${t.money?.estimated_cost_inr ? inr(t.money.estimated_cost_inr) : ''}</span>
        <span class="sub"><span class="chipx">${esc(t.region || t.directorate || '')}</span>
          ${t.category ? `<span class="chipx">${esc(t.category)}</span>` : ''}
          ${t.listing === 'current' ? '<span class="chipx site">open</span>' : ''}
          ${named.map(s => `<span class="chipx site">${esc(stationName[s.station_id] || s.name)}</span>`).join('')}
          ${(t.sites || []).filter(s => s.station_id).length > 4 ? `<span class="chipx site">+${t.sites.filter(s => s.station_id).length - 4}</span>` : ''}
          ${t.transcribed ? '' : '<span class="chipx warn">not transcribed</span>'}</span>
      </summary><div class="lazy"></div></details>`;
  }).join('');
  for (const el of document.querySelectorAll('.tender')) {
    el.addEventListener('toggle', () => {
      const lazy = el.querySelector('.lazy');
      if (el.open && lazy) lazy.outerHTML = body(tenders.find(t => `t-${t.nid}` === el.id));
    }, { once: false });
  }
}
for (const id of ['#q', '#dir', '#cat', '#yr']) $(id).addEventListener('input', render);
render();
if (location.hash) {
  const el = document.querySelector(location.hash);
  if (el) { el.open = true; el.scrollIntoView(); }
}
