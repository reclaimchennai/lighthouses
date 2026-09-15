// Full Master Ledger record for one station: every section, field, table and note exactly as
// transcribed from DGLL's PDF, with a summary of what the ledger leaves blank or reports broken.
const NILS = /^\s*(|-+|—|nil|n\.?\s*a\.?|n\/a|not\s+(?:available|provided|applicable)|none|---?)\s*$/i;
const TROUBLE = /non[\s-]*functional|not\s+(?:working|functional|in\s+service)|defective|under\s+repair|removed|out\s+of\s+order|damaged|dismantled|condemned|unserviceable|sent\s+.{0,30}repair/i;

export async function openRecord(station, { icon, esc }) {
  const root = document.getElementById('record');
  root.hidden = false;
  root.innerHTML = `<div class="rec-sheet"><div class="rec-head"><button class="close" aria-label="Close record">${icon('close')}</button>
    <small>DGLL Master Ledger</small><h2>${esc(station.name)}</h2><p class="note">Loading the full record…</p></div></div>`;
  root.querySelector('.close').onclick = closeRecord;
  document.addEventListener('keydown', escClose);
  let rec;
  try {
    rec = await fetch(`data/ledgers/${encodeURIComponent(station.id)}.json`).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
  } catch (e) {
    root.querySelector('.note').textContent = 'No full record is available for this station.';
    return;
  }

  // accountability summary
  let fields = 0, blank = 0;
  const trouble = [];
  const scan = (label, v, where) => {
    fields++;
    if (NILS.test(String(v ?? ''))) blank++;
    if (TROUBLE.test(String(v ?? ''))) trouble.push(`${where}: ${label ? label + ' — ' : ''}${v}`);
  };
  for (const s of rec.sections || []) {
    for (const f of s.fields || []) scan(f.label, f.value, s.title);
    for (const t of s.tables || []) for (const row of t.rows || []) row.forEach((v, i) => scan((t.columns || [])[i], v, s.title));
    if (s.text && TROUBLE.test(s.text)) trouble.push(`${s.title}: ${s.text}`);
  }
  const issues = [...(rec.sim_flags || []), ...(rec.ledger_issues || [])];

  const cell = v => NILS.test(String(v ?? '')) ? `<span class="nil">${esc(v === '' ? 'blank' : v)}</span>` : esc(v);
  const sections = (rec.sections || []).map((s, i) => `
    <section class="rec-sec" id="sec-${i}">
      <h3><span class="no">${esc(s.no || '')}</span>${esc(s.title || 'Untitled')}${s.title_hi ? ` <small lang="hi">${esc(s.title_hi)}</small>` : ''}<span class="pg">p. ${esc(s.page ?? '–')}</span></h3>
      ${(s.fields || []).length ? `<dl class="facts">${s.fields.map(f => `<dt>${esc(f.label)}</dt><dd>${cell(f.value)}</dd>`).join('')}</dl>` : ''}
      ${(s.tables || []).map(t => `<div class="tbl">${t.caption ? `<p class="cap">${esc(t.caption)}</p>` : ''}<table>
          <thead><tr>${(t.columns || []).map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
          <tbody>${(t.rows || []).map(r => `<tr>${r.map(v => `<td>${cell(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`).join('')}
      ${s.text ? `<p class="txt">${esc(s.text)}</p>` : ''}
    </section>`).join('');

  root.innerHTML = `<div class="rec-sheet" role="dialog" aria-modal="true" aria-label="Master Ledger record, ${esc(rec.name)}">
    <div class="rec-head">
      <button class="close" aria-label="Close record">${icon('close')}</button>
      <small>DGLL Master Ledger · ${esc(rec.page_count || '?')} pages</small>
      <h2>${esc(rec.name)}</h2>
      <div class="rec-actions">
        ${rec.ledger_url ? `<a href="${esc(rec.ledger_url)}" target="_blank" rel="noopener">${icon('doc')}Original PDF</a>` : ''}
        ${rec.page_url ? `<a href="${esc(rec.page_url)}" target="_blank" rel="noopener">${icon('external')}DGLL page</a>` : ''}
        <a href="data/ledgers/${encodeURIComponent(rec.station_id)}.json" download>${icon('list')}Data (JSON)</a>
      </div>
      <input type="search" class="rec-find" placeholder="Find in this record" aria-label="Find in this record">
    </div>
    <div class="rec-body">
      <section class="rec-sum">
        <div class="stat"><b>${(rec.sections || []).length}</b><span>sections</span></div>
        <div class="stat"><b>${fields}</b><span>entries</span></div>
        <div class="stat"><b>${blank}</b><span>blank / NIL / NA</span></div>
        <div class="stat ${trouble.length ? 'warn' : ''}"><b>${trouble.length}</b><span>reported broken or removed</span></div>
      </section>
      ${trouble.length ? `<details class="story" open><summary>${icon('alert')}Reported broken, removed or not working</summary><ul class="tnotes">${trouble.map(t => `<li>${esc(t)}</li>`).join('')}</ul></details>` : ''}
      ${issues.length ? `<details class="story"><summary>${icon('list')}Inconsistencies and reading notes (${issues.length})</summary><ul class="tnotes">${issues.map(t => `<li>${esc(t)}</li>`).join('')}</ul></details>` : ''}
      ${(rec.unreadable || []).length ? `<details class="story"><summary>${icon('eye')}Unreadable in the PDF (${rec.unreadable.length})</summary><ul class="tnotes">${rec.unreadable.map(u => `<li>p. ${esc(u.page)} · ${esc(u.where)}: ${esc(u.note)}</li>`).join('')}</ul></details>` : ''}
      <nav class="rec-toc" aria-label="Sections">${(rec.sections || []).map((s, i) => `<a href="#sec-${i}">${esc(s.title || s.no)}</a>`).join('')}</nav>
      ${sections}
      <p class="note fine">Transcribed verbatim from the PDF's rendered pages; blank, NIL and NA are kept as printed. Personal phone numbers are removed.</p>
    </div></div>`;
  root.querySelector('.close').onclick = closeRecord;
  root.querySelectorAll('.rec-toc a').forEach(a => a.onclick = e => {
    e.preventDefault();
    root.querySelector(a.getAttribute('href')).scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  const find = root.querySelector('.rec-find');
  find.addEventListener('input', () => {
    const q = find.value.trim().toLowerCase();
    root.querySelectorAll('.rec-sec').forEach(sec => { sec.hidden = q && !sec.textContent.toLowerCase().includes(q); });
  });
}

function escClose(e) { if (e.key === 'Escape') closeRecord(); }
export function closeRecord() {
  const root = document.getElementById('record');
  root.hidden = true;
  root.innerHTML = '';
  document.removeEventListener('keydown', escClose);
}
