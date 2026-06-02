#!/usr/bin/env node
/**
 * generate-venue-pages.mjs — static SEO landing pages, one per venue.
 *
 * WHY: the app (index.html) is a single client-rendered URL — Google can index
 * exactly one page. These pre-rendered static pages give every venue a unique,
 * crawlable URL with real HTML content, targeting BOTH sun-intent long-tail
 * ("når er det sol på <venue>", "solrik uteservering i <område>") and branded
 * ("<venue>") queries. The content moat is the per-venue SUN data — nobody
 * else (Maps/TripAdvisor) has it.
 *
 * The runtime app is untouched: these are a separate static layer generated
 * from the same data files. Run manually or via a GitHub Action (like the
 * existing data pipeline) — NOT a runtime build step.
 *
 *   node scripts/generate-venue-pages.mjs            # generate all
 *   node scripts/generate-venue-pages.mjs --sample   # print ONE page to stdout, write nothing
 *
 * Inputs:  data/venues.json, data/sun-windows.json
 * Outputs: steder/<slug>.html (one per venue), steder/index.html (hub),
 *          steder/omrade/<area>.html (area hubs), sitemap.xml (regenerated)
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://findshades.app';
const SAMPLE = process.argv.includes('--sample');

const venues = JSON.parse(readFileSync(resolve(ROOT, 'data/venues.json'), 'utf8'));
const sunData = JSON.parse(readFileSync(resolve(ROOT, 'data/sun-windows.json'), 'utf8'));
const SUN_DATES = sunData.dates || [];
const SUN_VENUES = sunData.venues || {};

// ── helpers ──────────────────────────────────────────────────────────────────
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/å/g, 'a')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function hm(dec) {
  if (dec == null) return null;
  const h = Math.floor(dec);
  const m = Math.round((dec - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
// facing degrees (0=N,90=Ø,180=S,270=V) → Norwegian 8-point compass
const COMPASS = ['nord', 'nordøst', 'øst', 'sørøst', 'sør', 'sørvest', 'vest', 'nordvest'];
function facingNo(deg) {
  if (deg == null || Number.isNaN(deg)) return null;
  return COMPASS[Math.round(((deg % 360) / 45)) % 8];
}
const CAT_NO = {
  restaurant: 'restaurant', cafe: 'kafé', bistro_bar: 'bistro og bar',
  pub: 'pub', bar: 'bar', bakery: 'bakeri',
};
function catNo(c) { return CAT_NO[c] || 'uteservering'; }

// A representative ("typical") geometric sun window for the venue, derived from
// the precomputed data. Framed as typical (not date-stamped) so pages stay
// SEO-stable and don't need nightly regen; the LIVE exact times live in the app.
function typicalSunWindows(id) {
  const rec = SUN_VENUES[String(id)] || SUN_VENUES[id];
  if (!rec) return null;
  const day = rec[SUN_DATES[0]];
  if (!day || !Array.isArray(day.windows) || !day.windows.length) return null;
  return day.windows.map(w => `${hm(w.start)}-${hm(w.end)}`);
}

// ── unique slug assignment ─────────────────────────────────────────────────────
// Prefer the clean name slug; on collision disambiguate by area, then by id.
const nameCounts = {};
for (const v of venues) { const s = slugify(v.name); nameCounts[s] = (nameCounts[s] || 0) + 1; }
const used = new Set();
for (const v of venues) {
  const base = slugify(v.name);
  let s = base;
  if (nameCounts[base] > 1) s = `${base}-${slugify(v.area)}`;
  if (used.has(s)) s = `${base}-${slugify(v.area)}-${v.id}`;
  used.add(s);
  v._slug = s;
}

// ── page template ──────────────────────────────────────────────────────────────
function venuePage(v) {
  const area = v.area || 'Oslo';
  const cat = catNo(v.category);
  const facing = facingNo(v.facing);
  const windows = typicalSunWindows(v.id);
  const slug = v._slug;
  const url = `${ORIGIN}/steder/${slug}`;
  const appLink = `${ORIGIN}/#${slug}-${v.id}`;
  const [lat, lng] = v.coords || [];

  const sunLine = windows
    ? `typisk sol ca. ${windows.join(', ')}`
    : 'sol når været tillater det';
  const facingClause = facing ? ` Uteserveringen vender mot ${facing}.` : '';

  const title = `Sol på ${v.name}: soltider for ${cat} i ${area} | Shades`;
  const desc = `Når er det sol på ${v.name}? ${cat[0].toUpperCase() + cat.slice(1)} i ${area} med ${sunLine}.${facingClause} Se live soltider, vær og bord i sola i Shades-appen.`;

  // JSON-LD: FoodEstablishment with geo + outdoor-seating amenity. Real,
  // venue-specific data (not boilerplate) so Google sees substantive content.
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Restaurant',
    name: v.name,
    address: { '@type': 'PostalAddress', streetAddress: v.address || '', addressLocality: 'Oslo', addressCountry: 'NO' },
    ...(lat && lng ? { geo: { '@type': 'GeoCoordinates', latitude: lat, longitude: lng } } : {}),
    ...(v.rating ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: v.rating, bestRating: 5 } } : {}),
    amenityFeature: { '@type': 'LocationFeatureSpecification', name: 'Uteservering / outdoor seating', value: true },
    url,
    sameAs: appLink,
  };

  const sunBlock = windows
    ? `<p class="sun-times"><span class="label">Typisk soltid</span><strong>ca. ${windows.join(' &middot; ')}</strong></p>`
    : `<p class="sun-times"><span class="label">Soltid</span><strong>Avhenger av vær og sesong</strong></p>`;

  return `<!DOCTYPE html>
<html lang="nb">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index,follow">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(`Sol på ${v.name} i ${area}`)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${ORIGIN}/design/og-picture.png">
<meta name="theme-color" content="#111E38">
<link rel="icon" type="image/svg+xml" href="/shades-mark.svg">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<style>
  :root{--ink:#111E38;--honey:#F2A900;--cream:#FBF7EF;--muted:#5b6478}
  *{box-sizing:border-box}
  body{margin:0;font-family:'Inter',system-ui,-apple-system,sans-serif;color:var(--ink);background:var(--cream);line-height:1.55}
  main{max-width:680px;margin:0 auto;padding:24px 20px 64px}
  nav.crumb{font-size:13px;color:var(--muted);margin-bottom:20px}
  nav.crumb a{color:var(--muted);text-decoration:none}
  h1{font-size:30px;line-height:1.15;margin:0 0 6px;font-weight:800}
  .sub{color:var(--muted);margin:0 0 24px;font-size:15px}
  .card{background:#fff;border-radius:16px;padding:20px 22px;margin:0 0 20px;box-shadow:0 1px 3px rgba(17,30,56,.08)}
  .sun-times{margin:0;display:flex;flex-direction:column;gap:4px}
  .sun-times .label{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
  .sun-times strong{font-size:22px;color:var(--ink)}
  .facts{list-style:none;padding:0;margin:16px 0 0;font-size:15px}
  .facts li{padding:6px 0;border-top:1px solid #eee;display:flex;justify-content:space-between;gap:16px}
  .facts li span:first-child{color:var(--muted)}
  .cta{display:inline-block;background:var(--honey);color:var(--ink);font-weight:700;text-decoration:none;padding:14px 22px;border-radius:12px;font-size:16px}
  .prose{font-size:15px;color:#2a3346}
  footer{margin-top:40px;font-size:13px;color:var(--muted)}
  footer a{color:var(--muted)}
</style>
</head>
<body>
<main>
  <nav class="crumb"><a href="/steder/">Steder</a> / <a href="/steder/omrade/${slugify(area)}">${esc(area)}</a> / ${esc(v.name)}</nav>
  <h1>Sol på ${esc(v.name)}</h1>
  <p class="sub">${esc(cat[0].toUpperCase() + cat.slice(1))} i ${esc(area)}${v.rating ? ` &middot; ${v.rating} ★` : ''}</p>
  <div class="card">
    ${sunBlock}
    <ul class="facts">
      ${facing ? `<li><span>Vender mot</span><span>${esc(facing)}</span></li>` : ''}
      ${v.address ? `<li><span>Adresse</span><span>${esc(v.address)}</span></li>` : ''}
      <li><span>Område</span><span>${esc(area)}</span></li>
    </ul>
  </div>
  <p><a class="cta" href="${appLink}">Åpne ${esc(v.name)} i Shades →</a></p>
  <div class="card prose">
    <p>${esc(v.name)} er en ${esc(cat)} i ${esc(area)} i Oslo.${facing ? ` Uteserveringen vender mot ${esc(facing)}, som avgjør når på dagen den får direkte sol.` : ''} Shades regner ut soltidene fra byggenes skygger og kombinerer dem med værmeldingen, så du ser når det faktisk er sol i bordet, ikke bare når sola er oppe.</p>
    <p>Vil du finne et bord i sola akkurat nå? <a href="${appLink}">Åpne ${esc(v.name)} i Shades</a> for live soltider, vær og hvilke venner som er ute.</p>
  </div>
  <footer>
    <a href="/steder/">Alle steder i Oslo</a> &middot; <a href="${ORIGIN}/">Shades: finn bord i sola</a>
  </footer>
</main>
</body>
</html>`;
}

// ── listing pages (hub + area hubs) ─────────────────────────────────────────
const LIST_STYLE = `:root{--ink:#111E38;--honey:#F2A900;--cream:#FBF7EF;--muted:#5b6478}
  *{box-sizing:border-box}
  body{margin:0;font-family:'Inter',system-ui,-apple-system,sans-serif;color:var(--ink);background:var(--cream);line-height:1.55}
  main{max-width:720px;margin:0 auto;padding:24px 20px 64px}
  nav.crumb{font-size:13px;color:var(--muted);margin-bottom:20px}
  nav.crumb a{color:var(--muted);text-decoration:none}
  h1{font-size:30px;line-height:1.15;margin:0 0 6px;font-weight:800}
  .lead{color:var(--muted);margin:0 0 24px;font-size:16px}
  ul.list{list-style:none;padding:0;margin:0}
  ul.list li{border-top:1px solid #e7e1d5;padding:0}
  ul.list li a{display:flex;justify-content:space-between;gap:16px;align-items:baseline;padding:13px 4px;text-decoration:none;color:var(--ink);font-weight:600}
  ul.list li a:hover{color:var(--honey)}
  ul.list li a span{color:var(--muted);font-weight:400;font-size:14px;text-align:right}
  footer{margin-top:40px;font-size:13px;color:var(--muted)}
  footer a{color:var(--muted)}`;

function listShell({ title, desc, canonical, crumb, h1, lead, rows }) {
  const url = `${ORIGIN}${canonical}`;
  return `<!DOCTYPE html>
<html lang="nb">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index,follow">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${ORIGIN}/design/og-picture.png">
<meta name="theme-color" content="#111E38">
<link rel="icon" type="image/svg+xml" href="/shades-mark.svg">
<style>${LIST_STYLE}</style>
</head>
<body>
<main>
  <nav class="crumb">${crumb}</nav>
  <h1>${esc(h1)}</h1>
  <p class="lead">${esc(lead)}</p>
  <ul class="list">${rows}</ul>
  <footer><a href="${ORIGIN}/">Shades: finn bord i sola</a></footer>
</main>
</body>
</html>`;
}

function venueRow(v) {
  const w = typicalSunWindows(v.id);
  const meta = [v.area, w ? `sol ca. ${w[0]}` : null].filter(Boolean).join(' &middot; ');
  return `<li><a href="/steder/${v._slug}">${esc(v.name)}<span>${meta}</span></a></li>`;
}

// ── run ─────────────────────────────────────────────────────────────────────
if (SAMPLE) {
  // Pick a venue WITH facing + sun data so the sample shows the rich case.
  const sample = venues.find(v => v.facing != null && typicalSunWindows(v.id)) || venues[0];
  process.stdout.write(`<!-- SAMPLE: ${sample.name} -> /steder/${sample._slug} -->\n`);
  process.stdout.write(venuePage(sample));
  process.exit(0);
}

// Full generation (only runs without --sample).
const outDir = resolve(ROOT, 'steder');
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(resolve(outDir, 'omrade'), { recursive: true });

// 1) venue pages
for (const v of venues) writeFileSync(resolve(outDir, `${v._slug}.html`), venuePage(v));

// 1b) slug -> id map. The Cloudflare edge function (functions/steder/[slug].js)
// reads this to bounce a HUMAN visitor straight into the web app on the venue
// (/#<slug>-<id>) instead of showing the static page — while still serving the
// static HTML to crawlers so the venue stays indexed. Keeps clean /steder/<slug>
// URLs without baking the id into them.
const slugMap = Object.fromEntries(venues.map(v => [v._slug, v.id]));
writeFileSync(resolve(outDir, 'slug-map.json'), JSON.stringify(slugMap));

// 2) area hubs — group venues by area
const byArea = {};
for (const v of venues) (byArea[v.area || 'Oslo'] ||= []).push(v);
const areas = Object.keys(byArea).sort((a, b) => a.localeCompare(b, 'nb'));
for (const area of areas) {
  const list = byArea[area].slice().sort((a, b) => a.name.localeCompare(b.name, 'nb'));
  const rows = list.map(venueRow).join('\n');
  writeFileSync(resolve(outDir, 'omrade', `${slugify(area)}.html`), listShell({
    title: `Solrike uteserveringer i ${area} | Shades`,
    desc: `Hvor er det sol i ${area}? ${list.length} uteserveringer i ${area} med soltider regnet ut fra byggenes skygger. Finn bord i sola i Shades.`,
    canonical: `/steder/omrade/${slugify(area)}`,
    crumb: `<a href="/steder/">Steder</a> / ${esc(area)}`,
    h1: `Sol i ${area}`,
    lead: `${list.length} uteserveringer i ${area}, sortert med typiske soltider. Åpne et sted for detaljer, eller Shades-appen for live sol og vær.`,
    rows,
  }));
}

// 3) top-level hub — list areas (each links to its area hub)
const areaRows = areas.map(a =>
  `<li><a href="/steder/omrade/${slugify(a)}">${esc(a)}<span>${byArea[a].length} steder</span></a></li>`
).join('\n');
writeFileSync(resolve(outDir, 'index.html'), listShell({
  title: 'Solrike uteserveringer i Oslo: soltider for hvert sted | Shades',
  desc: `Hvor er det sol i Oslo akkurat nå? ${venues.length} uteserveringer fordelt på ${areas.length} områder, med soltider regnet ut fra byggenes skygger og værmeldingen.`,
  canonical: '/steder/',
  crumb: `<a href="${ORIGIN}/">Shades</a> / Steder`,
  h1: 'Solrike uteserveringer i Oslo',
  lead: `${venues.length} steder i ${areas.length} områder. Velg et område for å se soltidene, eller åpne Shades-appen for live sol, vær og venner.`,
  rows: areaRows,
}));

// 4) sitemap.xml — homepage + hub + area hubs + every venue page (clean URLs)
const urls = [
  `${ORIGIN}/`,
  `${ORIGIN}/steder/`,
  ...areas.map(a => `${ORIGIN}/steder/omrade/${slugify(a)}`),
  ...venues.map(v => `${ORIGIN}/steder/${v._slug}`),
];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${u}</loc></url>`).join('\n')}
</urlset>
`;
writeFileSync(resolve(ROOT, 'sitemap.xml'), sitemap);

console.log(`Wrote ${venues.length} venue pages + ${areas.length} area hubs + index + sitemap (${urls.length} URLs).`);
