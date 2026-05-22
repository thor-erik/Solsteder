#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// validate-tokens.mjs — design-token enforcement (MINIMAL stub)
//
// Phase scope (per DESIGN-FIXES "Implementation plan"): this is the minimal
// guardrail that must exist from the first commit of the design-system overhaul.
// It flags ONE thing for now: raw hex colour literals that live OUTSIDE the
// :root token-definition block. :root is where literals legitimately live;
// every component should consume var(--token) instead (DESIGN.md → Color tokens).
//
// Phase 1 will EXTEND this to also flag rgba alphas, blur(), font-size,
// border-radius, and padding/gap/margin — see the punch-list. Keep that in mind
// before over-engineering here.
//
// Because the pre-migration codebase is intentionally dirty (the whole point of
// Phase 2 is to migrate these literals away), a hard "zero hex" rule would fail
// on master today. Instead we use a COUNT BASELINE: the build is green as long
// as the number of raw-hex-outside-:root occurrences does not GROW. Migration
// drives the count down; `--update` re-pins the baseline lower. This survives the
// Phase −1 file split (line numbers and file boundaries move; the total doesn't)
// and the Phase 0 token add (new literals go INSIDE :root, which is excluded).
//
// No dependencies — Node built-ins only (the repo has no runtime npm deps).
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, 'scripts', 'token-baseline.json');
const UPDATE = process.argv.includes('--update');

// ── File discovery ───────────────────────────────────────────────────────────
// index.html (only its <style> blocks) + every css/*.css (whole file).
function scanTargets() {
  const targets = [];
  const indexPath = join(ROOT, 'index.html');
  if (existsSync(indexPath)) {
    targets.push({ path: indexPath, kind: 'html' });
  }
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
  if (keep.length === 0) return ' '.repeat(text.length); // no CSS here
  // Blank everything not inside a kept range.
  let cursor = 0;
  for (const [open, close] of keep) {
    masked = blank(masked, cursor, open);
    cursor = close;
  }
  masked = blank(masked, cursor, masked.length);
  return masked;
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
// :root:has(...) keyboard override). Brace-matched so nested values are covered.
function blankRootBlocks(text) {
  let masked = text;
  const re = /:root[^{}]*\{/g;
  let m;
  while ((m = re.exec(text))) {
    // Walk back to the start of the selector (after the previous } or ;).
    let selStart = m.index;
    while (selStart > 0 && !'};'.includes(text[selStart - 1])) selStart--;
    // Match the body braces from the opening { at the end of m[0].
    let depth = 0;
    let i = m.index + m[0].length - 1; // position of '{'
    for (; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) { i++; break; }
      }
    }
    masked = blank(masked, selStart, i);
  }
  return masked;
}

// ── Hex detection in declaration values ──────────────────────────────────────
// Only look at values: a declaration value starts right after `{` or `;`, is
// `prop: value`, and runs until the next `;`/`{`/`}`. This structurally excludes
// selectors (incl. `#id` selectors and `:pseudo`), which never appear as
// `{|;  prop : value`.
const DECL_RE = /[{;]\s*[-a-zA-Z]+\s*:\s*([^;{}]+)/g;
const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function findRawHex(masked) {
  const hits = [];
  let d;
  DECL_RE.lastIndex = 0;
  while ((d = DECL_RE.exec(masked))) {
    const value = d[1];
    // Offset of the value group within `masked`.
    const valueOffset = d.index + d[0].length - value.length;
    // Drop url(#fragment) refs (SVG filter/clip ids that are not colours).
    const cleaned = value.replace(/url\([^)]*\)/g, (s) => ' '.repeat(s.length));
    let h;
    HEX_RE.lastIndex = 0;
    while ((h = HEX_RE.exec(cleaned))) {
      // 3/4/6/8 hex digits are valid CSS colours; 5/7 are not — skip those.
      const len = h[0].length - 1;
      if (![3, 4, 6, 8].includes(len)) continue;
      hits.push({ offset: valueOffset + h.index, hex: h[0] });
    }
  }
  return hits;
}

// ── Run ──────────────────────────────────────────────────────────────────────
const all = [];
for (const { path, kind } of scanTargets()) {
  const raw = readFileSync(path, 'utf8');
  let masked = kind === 'html' ? isolateStyle(raw) : raw;
  masked = blankComments(masked);
  masked = blankRootBlocks(masked);
  for (const hit of findRawHex(masked)) {
    all.push({ file: relative(ROOT, path), line: lineOf(raw, hit.offset), hex: hit.hex });
  }
}

const count = all.length;

if (UPDATE) {
  writeFileSync(BASELINE_PATH, JSON.stringify({ rawHexOutsideRoot: count }, null, 2) + '\n');
  console.log(`token-baseline.json updated: rawHexOutsideRoot = ${count}`);
  process.exit(0);
}

const baseline = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).rawHexOutsideRoot ?? 0
  : 0;

console.log(`validate-tokens: ${count} raw hex outside :root (baseline ${baseline})`);

if (count > baseline) {
  console.error(`\n✗ raw-hex count grew by ${count - baseline} — new colour literals must use var(--token):\n`);
  for (const h of all) console.error(`  ${h.file}:${h.line}  ${h.hex}`);
  console.error('\nMove the colour into a :root token and reference it via var(). If this is an intentional reduction elsewhere, run with --update.');
  process.exit(1);
}

if (count < baseline) {
  console.log(`✓ down ${baseline - count} from baseline — run "node scripts/validate-tokens.mjs --update" to re-pin.`);
} else {
  console.log('✓ no new raw hex outside :root.');
}
process.exit(0);
