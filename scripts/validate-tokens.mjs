#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// validate-tokens.mjs — design-token enforcement
//
// Flags raw literals that should be design tokens, OUTSIDE the :root
// token-definition block (:root is where literals legitimately live; every
// component should consume var(--token) — DESIGN.md → Color/Type/Radius/Spacing).
//
// Categories (DESIGN-FIXES "Implementation plan" Phase 1):
//   rawHexOutsideRoot — #rgb / #rgba / #rrggbb / #rrggbbaa colour literals
//   rawAlpha          — rgba() / hsla() literals
//   rawBlur           — blur() literals (use var(--blur-*))
//   rawFontSize       — font-size with a raw px/rem/em length
//   rawBorderRadius   — border-radius (any corner) with a raw length
//   rawSpacing        — padding / margin / gap with a raw length
//
// COUNT BASELINE: the pre-migration tree is intentionally dirty (Phase 2
// migrates these away). Rather than a hard zero rule, we pin a per-category
// count in scripts/token-baseline.json and fail only when a category GROWS.
// Migration drives counts down; `--update` re-pins them lower. This survives
// the file split (line/file moves don't change totals) and the token add (new
// literals go INSIDE :root, which is excluded).
//
// No dependencies — Node built-ins only (the repo has no runtime npm deps).
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, 'scripts', 'token-baseline.json');
const UPDATE = process.argv.includes('--update');
const VERBOSE = process.argv.includes('--list'); // print every hit, not just growth

// ── File discovery ───────────────────────────────────────────────────────────
// index.html (only its <style> blocks) + every css/*.css (whole file).
function scanTargets() {
  const targets = [];
  const indexPath = join(ROOT, 'index.html');
  if (existsSync(indexPath)) targets.push({ path: indexPath, kind: 'html' });
  const cssDir = join(ROOT, 'css');
  if (existsSync(cssDir)) {
    for (const name of readdirSync(cssDir).sort()) {
      if (name.endsWith('.css')) targets.push({ path: join(cssDir, name), kind: 'css' });
    }
  }
  return targets;
}

// ── Masking helpers ──────────────────────────────────────────────────────────
// Replace a [start,end) span with spaces, preserving newlines so byte offsets
// (and therefore line numbers) stay exact.
function blank(text, start, end) {
  let out = '';
  for (let i = start; i < end; i++) out += text[i] === '\n' ? '\n' : ' ';
  return text.slice(0, start) + out + text.slice(end);
}

// Keep only <style>…</style> content for HTML; blank everything else.
function isolateStyle(text) {
  let masked = text;
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  const keep = [];
  let m;
  while ((m = re.exec(text))) {
    const open = m.index + m[0].indexOf('>') + 1;
    const close = m.index + m[0].length - '</style>'.length;
    keep.push([open, close]);
  }
  if (keep.length === 0) return ' '.repeat(text.length);
  let cursor = 0;
  for (const [open, close] of keep) {
    masked = blank(masked, cursor, open);
    cursor = close;
  }
  return blank(masked, cursor, masked.length);
}

// Blank /* … */ comments.
function blankComments(text) {
  let masked = text;
  const re = /\/\*[\s\S]*?\*\//g;
  let m;
  while ((m = re.exec(text))) masked = blank(masked, m.index, m.index + m[0].length);
  return masked;
}

// Blank any rule whose selector contains ":root" (token definitions + the
// :root:has(...) keyboard override). Brace-matched.
function blankRootBlocks(text) {
  let masked = text;
  const re = /:root[^{}]*\{/g;
  let m;
  while ((m = re.exec(text))) {
    let selStart = m.index;
    while (selStart > 0 && !'};'.includes(text[selStart - 1])) selStart--;
    let depth = 0;
    let i = m.index + m[0].length - 1; // position of '{'
    for (; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    masked = blank(masked, selStart, i);
  }
  return masked;
}

// ── Per-category matchers ────────────────────────────────────────────────────
// Each returns [{ text, rel }] where rel = offset of the match within `value`.
function matchHex(prop, value) {
  // Drop url(#fragment) SVG refs (clip/filter ids, not colours).
  const cleaned = value.replace(/url\([^)]*\)/g, (s) => ' '.repeat(s.length));
  const hits = [];
  const re = /#[0-9a-fA-F]{3,8}\b/g;
  let m;
  while ((m = re.exec(cleaned))) {
    const len = m[0].length - 1;
    if ([3, 4, 6, 8].includes(len)) hits.push({ text: m[0], rel: m.index });
  }
  return hits;
}

function matchFunc(re) {
  return (prop, value) => {
    const hits = [];
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(value))) hits.push({ text: m[0], rel: m.index });
    return hits;
  };
}

// A raw length = a non-var px/rem/em number. Blank var(...) first so tokenized
// values (and calc(var(--x))) don't count; a literal offset inside calc still does.
function matchLength(prop, value) {
  const cleaned = value.replace(/var\([^)]*\)/g, (s) => ' '.repeat(s.length));
  const hits = [];
  const re = /(?<![\w.])\d*\.?\d+(px|rem|em)\b/g;
  let m;
  while ((m = re.exec(cleaned))) {
    // Ignore pure-zero lengths (0px / 0.0rem) — 0 is not a scale step.
    if (/^0*\.?0+(px|rem|em)$/.test(m[0])) continue;
    hits.push({ text: m[0], rel: m.index });
  }
  return hits;
}

const SPACING_PROP = /^(padding|margin|gap|row-gap|column-gap|grid-gap)$|^(padding|margin)-(top|right|bottom|left|inline|block)(-(start|end))?$/;
const RADIUS_PROP = /^border-(top|bottom)-(left|right)-radius$|^border-(start|end)-(start|end)-radius$|^border-radius$/;

const RULES = [
  { key: 'rawHexOutsideRoot', label: 'raw hex colour',        run: (p, v) => matchHex(p, v) },
  { key: 'rawAlpha',          label: 'rgba()/hsla()',          run: matchFunc(/\b(rgba|hsla)\(/g) },
  { key: 'rawBlur',           label: 'blur()',                 run: matchFunc(/\bblur\(/g) },
  { key: 'rawFontSize',       label: 'raw font-size',          run: (p, v) => (p === 'font-size' ? matchLength(p, v) : []) },
  { key: 'rawBorderRadius',   label: 'raw border-radius',      run: (p, v) => (RADIUS_PROP.test(p) ? matchLength(p, v) : []) },
  { key: 'rawSpacing',        label: 'raw padding/margin/gap',  run: (p, v) => (SPACING_PROP.test(p) ? matchLength(p, v) : []) },
];

// ── Declaration scan ─────────────────────────────────────────────────────────
// A declaration value starts right after `{` or `;` as `prop: value`. This
// structurally excludes selectors (incl. #id and :pseudo).
const DECL_RE = /[{;]\s*(-?[-a-zA-Z]+)\s*:\s*([^;{}]+)/g;

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

// ── Run ──────────────────────────────────────────────────────────────────────
const hitsByRule = Object.fromEntries(RULES.map((r) => [r.key, []]));

for (const { path, kind } of scanTargets()) {
  const raw = readFileSync(path, 'utf8');
  let masked = kind === 'html' ? isolateStyle(raw) : raw;
  masked = blankComments(masked);
  masked = blankRootBlocks(masked);
  let d;
  DECL_RE.lastIndex = 0;
  while ((d = DECL_RE.exec(masked))) {
    const prop = d[1].toLowerCase();
    const value = d[2];
    const valueOffset = d.index + d[0].length - value.length;
    for (const rule of RULES) {
      for (const hit of rule.run(prop, value)) {
        hitsByRule[rule.key].push({
          file: relative(ROOT, path),
          line: lineOf(raw, valueOffset + hit.rel),
          text: hit.text,
          prop,
        });
      }
    }
  }
}

const counts = Object.fromEntries(RULES.map((r) => [r.key, hitsByRule[r.key].length]));

if (UPDATE) {
  writeFileSync(BASELINE_PATH, JSON.stringify(counts, null, 2) + '\n');
  console.log('token-baseline.json updated:');
  for (const r of RULES) console.log(`  ${r.key} = ${counts[r.key]}`);
  process.exit(0);
}

const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : {};

let failed = false;
console.log('validate-tokens:');
for (const r of RULES) {
  const have = counts[r.key];
  const base = baseline[r.key] ?? 0;
  const mark = have > base ? '✗' : have < base ? '↓' : '·';
  console.log(`  ${mark} ${r.label.padEnd(22)} ${have}  (baseline ${base})`);
  if (have > base) {
    failed = true;
    console.error(`\n✗ ${r.label} grew by ${have - base} — must use var(--token):`);
    for (const h of hitsByRule[r.key]) console.error(`    ${h.file}:${h.line}  ${h.prop}: …${h.text}`);
  }
}

if (VERBOSE && !failed) {
  for (const r of RULES) {
    if (!hitsByRule[r.key].length) continue;
    console.log(`\n— ${r.label} (${hitsByRule[r.key].length}) —`);
    for (const h of hitsByRule[r.key]) console.log(`    ${h.file}:${h.line}  ${h.prop}: …${h.text}`);
  }
}

if (failed) {
  console.error('\nMove the literal into a :root token and reference it via var(). For an intentional reduction elsewhere, run with --update.');
  process.exit(1);
}

const anyDown = RULES.some((r) => counts[r.key] < (baseline[r.key] ?? 0));
console.log(anyDown ? '\n↓ some categories shrank — run "node scripts/validate-tokens.mjs --update" to re-pin.' : '\n✓ no new raw literals.');
process.exit(0);
