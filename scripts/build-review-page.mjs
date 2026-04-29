#!/usr/bin/env node
/**
 * build-review-page.mjs
 * Generates data/venues-review.html — a quick-scan review page for the
 * LOW-confidence discovery output. Each row links to Google Maps and
 * Google Search so you can confirm whether the venue actually has
 * outdoor seating in 2 seconds.
 *
 * Usage:
 *   node scripts/build-review-page.mjs
 *
 * Workflow:
 *   1. Open data/venues-review.html in a browser.
 *   2. Cmd-click each row's "Maps" or "Search" link to verify outdoor
 *      seating exists. Tick the checkbox for keepers.
 *   3. Click "Copy keeper IDs" at the top — pastes a JSON array of
 *      googlePlaceIds to the clipboard.
 *   4. Run: node scripts/promote-from-review.mjs <paste>
 *      …which moves keepers into venues-fetched.json for the next
 *      merge-venues run.
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

const review = JSON.parse(readFileSync(join(ROOT, 'data/venues-review.json'), 'utf8'));

// Sort by signal strength (more sources first → more likely real),
// then by name.
const signalRank = s => {
  const parts = (s || '').split(',');
  const hasGoogleFlag = parts.includes('outdoorSeating') ? 1 : 0;
  return parts.length * 10 + hasGoogleFlag;
};
review.sort((a, b) =>
  signalRank(b.discoverySignal) - signalRank(a.discoverySignal) ||
  a.name.localeCompare(b.name, 'no')
);

const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const rows = review.map((v, i) => {
  const [lat, lng] = v.coords ?? [0, 0];
  const mapsUrl  = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}&query_place_id=${encodeURIComponent(v.googlePlaceId ?? '')}`;
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(v.name + ' ' + (v.address ?? ''))}`;
  return `
    <tr data-id="${escape(v.googlePlaceId)}" data-name="${escape(v.name)}">
      <td><input type="checkbox" class="keep"></td>
      <td>${i + 1}</td>
      <td><b>${escape(v.name)}</b></td>
      <td>${escape(v.area)}</td>
      <td>${escape(v.category)}</td>
      <td><span class="signal">${escape(v.discoverySignal)}</span></td>
      <td>${escape(v.address)}</td>
      <td>
        <a href="${mapsUrl}" target="_blank" rel="noopener">Maps</a> ·
        <a href="${searchUrl}" target="_blank" rel="noopener">Search</a>
      </td>
    </tr>
  `;
}).join('');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Venue review queue (${review.length})</title>
<style>
  body { font: 13px/1.45 -apple-system, sans-serif; margin: 16px; background: #fafaf9; }
  header { display: flex; gap: 12px; align-items: baseline; margin-bottom: 12px; position: sticky; top: 0; background: #fafaf9; padding: 8px 0; border-bottom: 1px solid #ddd; z-index: 10; }
  header h1 { font-size: 16px; margin: 0; }
  header .stats { color: #666; }
  button { padding: 6px 12px; cursor: pointer; }
  button.primary { background: #2563eb; color: white; border: 1px solid #1e40af; border-radius: 4px; }
  table { width: 100%; border-collapse: collapse; background: white; }
  th, td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #eee; vertical-align: top; }
  th { background: #f5f5f4; position: sticky; top: 56px; z-index: 5; }
  tr:hover { background: #fef9c3; }
  tr.kept { background: #dcfce7; }
  tr.kept:hover { background: #bbf7d0; }
  .signal { font-family: ui-monospace, monospace; font-size: 11px; color: #555; }
  td a { color: #2563eb; text-decoration: none; margin-right: 4px; }
  td a:hover { text-decoration: underline; }
  input[type=search] { padding: 4px 8px; border: 1px solid #ccc; border-radius: 4px; min-width: 200px; }
  .filter-pills { display: flex; gap: 6px; flex-wrap: wrap; }
  .pill { padding: 3px 8px; border: 1px solid #ccc; border-radius: 12px; cursor: pointer; user-select: none; font-size: 12px; }
  .pill.active { background: #2563eb; color: white; border-color: #1e40af; }
</style>
</head>
<body>

<header>
  <h1>Venue review queue</h1>
  <span class="stats" id="stats"></span>
  <input type="search" placeholder="Filter by name / area / signal…" id="filter">
  <div class="filter-pills" id="signal-pills"></div>
  <button class="primary" id="copy">Copy keeper IDs</button>
</header>

<table>
  <thead>
    <tr>
      <th>Keep</th>
      <th>#</th>
      <th>Name</th>
      <th>Area</th>
      <th>Type</th>
      <th>Signal</th>
      <th>Address</th>
      <th>Verify</th>
    </tr>
  </thead>
  <tbody id="rows">${rows}</tbody>
</table>

<script>
  const rows = [...document.querySelectorAll('#rows tr')];
  const stats = document.getElementById('stats');
  const filterEl = document.getElementById('filter');
  const pills = document.getElementById('signal-pills');
  const STORAGE_KEY = 'solsteder-review-kept';

  // Restore previously-kept selections
  const kept = new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'));
  rows.forEach(r => {
    const id = r.dataset.id;
    if (kept.has(id)) {
      r.classList.add('kept');
      r.querySelector('.keep').checked = true;
    }
  });

  function persist() {
    const ids = rows.filter(r => r.querySelector('.keep').checked).map(r => r.dataset.id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
    updateStats();
  }

  function updateStats() {
    const total = rows.length;
    const visible = rows.filter(r => r.style.display !== 'none').length;
    const keptCount = rows.filter(r => r.querySelector('.keep').checked).length;
    stats.textContent = \`\${visible}/\${total} shown · \${keptCount} kept\`;
  }

  // Checkbox change
  document.addEventListener('change', e => {
    if (e.target.classList.contains('keep')) {
      e.target.closest('tr').classList.toggle('kept', e.target.checked);
      persist();
    }
  });

  // Click row to toggle (except links/checkbox)
  document.addEventListener('click', e => {
    if (e.target.tagName === 'A' || e.target.tagName === 'INPUT') return;
    const tr = e.target.closest('tr');
    if (!tr || !tr.dataset.id) return;
    const cb = tr.querySelector('.keep');
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // Filter
  filterEl.addEventListener('input', () => {
    const q = filterEl.value.toLowerCase();
    rows.forEach(r => {
      r.style.display = q && !r.textContent.toLowerCase().includes(q) ? 'none' : '';
    });
    updateStats();
  });

  // Signal pills
  const signals = [...new Set(rows.map(r => r.querySelector('.signal').textContent))].sort();
  let activeSignal = null;
  signals.forEach(s => {
    const p = document.createElement('span');
    p.className = 'pill';
    p.textContent = s;
    p.onclick = () => {
      if (activeSignal === s) { activeSignal = null; p.classList.remove('active'); }
      else { activeSignal = s; pills.querySelectorAll('.pill').forEach(x => x.classList.remove('active')); p.classList.add('active'); }
      rows.forEach(r => {
        const matches = !activeSignal || r.querySelector('.signal').textContent === activeSignal;
        r.style.display = matches ? '' : 'none';
      });
      updateStats();
    };
    pills.appendChild(p);
  });

  // Copy keeper IDs
  document.getElementById('copy').onclick = async () => {
    const ids = rows.filter(r => r.querySelector('.keep').checked).map(r => r.dataset.id);
    if (!ids.length) { alert('No keepers selected.'); return; }
    await navigator.clipboard.writeText(JSON.stringify(ids));
    alert(\`Copied \${ids.length} place IDs. Now run:\\n\\n  node scripts/promote-from-review.mjs '<paste>'\\n\\n…replacing <paste> with the clipboard contents.\`);
  };

  updateStats();
</script>

</body>
</html>
`;

writeFileSync(join(ROOT, 'data/venues-review.html'), html);
console.log(`Wrote data/venues-review.html — ${review.length} entries.`);
console.log(`Open it with:  open data/venues-review.html`);
