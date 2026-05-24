#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// contrast-audit.mjs — WCAG 2.1 contrast for the design-system text/surface pairs.
//
// Phase 6 acceptance: MEASURE contrast on the new surfaces, don't assert it.
// Translucent surfaces are alpha-composited over their effective background
// (chrome/sheet = Jordy 25% over the MAP, so the map tone matters; content =
// Delft 90% over the map; raised = opaque cream). Text with alpha is then
// composited over that surface. AA threshold: 4.5:1 normal, 3:1 large/bold.
//
// Node built-ins only.
// ─────────────────────────────────────────────────────────────────────────────

// ── colour math ──────────────────────────────────────────────────────────────
const hex = (h) => {
  const s = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
// composite fg (with alpha a) over bg → opaque rgb
const over = (fg, a, bg) => fg.map((c, i) => Math.round(c * a + bg[i] * (1 - a)));
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const L = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
const ratio = (a, b) => { const l1 = L(a), l2 = L(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); };

// ── tokens (mirror of :root) ───────────────────────────────────────────────────
const C = {
  delft:      hex('#111E38'),  // --bg / panel-text ink
  cream:      hex('#FFF4E0'),  // --text
  creamRaise: hex('#FFF2EB'),  // --surface-raised
  honey:      hex('#F5C25E'),  // --accent
  honeyOn:    hex('#2C1F02'),  // --accent-on
  muted:      hex('#9BA9BC'),  // --muted
  jordy:      hex('#9CBDE7'),  // chrome/sheet tint base
};
// representative map tones (from map-style.js): dominant light land, + darkest element
const MAP = { land: hex('#EFE4CD'), water: hex('#C4D9F0'), darkest: hex('#5A5048') };

// effective surfaces (composited over a given map base where translucent)
const delft90 = (map) => over(C.delft, 0.90, map);          // --surface-content/modal
const chrome25 = (map) => over(C.jordy, 0.25, map);          // --surface-chrome/sheet

// ── the audit pairs ────────────────────────────────────────────────────────────
const AA_NORMAL = 4.5, AA_LARGE = 3.0;
const rows = [];
const add = (label, fg, bg, large = false) => {
  const r = ratio(fg, bg);
  const thr = large ? AA_LARGE : AA_NORMAL;
  rows.push({ label, r, thr, pass: r >= thr, large });
};

// content card (Delft 90% over map) — text is cream/honey/secondary/muted
for (const [mname, map] of Object.entries({ 'map-land': MAP.land, 'map-water': MAP.water, 'map-dark': MAP.darkest })) {
  const bg = delft90(map);
  add(`cream text on Delft-90% (${mname})`, C.cream, bg);
  add(`secondary cream@.78 on Delft-90% (${mname})`, over(C.cream, 0.78, bg), bg);
  add(`honey on Delft-90% (${mname})`, C.honey, bg);
  add(`muted #9BA9BC on Delft-90% (${mname})`, C.muted, bg);
}
// chrome surface (Jordy 25% over map) — ink text. THIS is the map-dependent one.
for (const [mname, map] of Object.entries({ 'map-land': MAP.land, 'map-water': MAP.water, 'map-dark': MAP.darkest })) {
  const bg = chrome25(map);
  add(`ink text on chrome Jordy-25% (${mname})`, C.delft, bg);
  add(`ink-muted@.55 on chrome (${mname})`, over(C.delft, 0.55, bg), bg);
}
// raised cream dropdown (opaque) — ink text
add('ink on cream raised dropdown', C.delft, C.creamRaise);
add('ink-muted@.55 on cream raised', over(C.delft, 0.55, C.creamRaise), C.creamRaise);
// honey CTA — dark text on honey
add('accent-on #2C1F02 on honey CTA', C.honeyOn, C.honey);
add('delft ink on honey CTA', C.delft, C.honey);

// ── print ──────────────────────────────────────────────────────────────────────
console.log('\nWCAG contrast audit (AA: 4.5 normal · 3.0 large/bold)\n');
console.log('  ratio   AA      pair');
console.log('  ─────   ────    ' + '─'.repeat(48));
let fails = 0;
for (const r of rows) {
  const mark = r.pass ? '✓' : '✗';
  if (!r.pass) fails++;
  console.log(`  ${r.r.toFixed(2).padStart(5)}   ${mark} ${String(r.thr).padEnd(4)}  ${r.label}`);
}
console.log(`\n${fails === 0 ? '✓ all pairs pass AA' : `✗ ${fails} pair(s) below AA — see ✗ rows`}\n`);
process.exit(0);
