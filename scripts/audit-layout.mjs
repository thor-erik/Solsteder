#!/usr/bin/env node
/**
 * audit-layout.mjs
 *
 * Static layout constraint auditor. Finds every CSS rule and inline JS style
 * that touches a given set of selectors/keywords, then prints a constraint chain.
 *
 * Usage:
 *   node scripts/audit-layout.mjs                  # audit default element set
 *   node scripts/audit-layout.mjs detail-panel      # focus on one element
 *   node scripts/audit-layout.mjs height overflow   # focus on specific properties
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

const ROOT = new URL('..', import.meta.url).pathname;

// Default: layout-critical properties and their common conflict patterns
const LAYOUT_PROPS = [
  'height', 'min-height', 'max-height',
  'width', 'min-width', 'max-width',
  'overflow', 'overflow-y', 'overflow-x',
  'flex', 'flex-shrink', 'flex-grow', 'flex-basis',
  'position', 'top', 'bottom', 'left', 'right', 'inset',
  'display', 'flex-direction',
  'transform', 'translate',
  '--vh', 'vh', 'dvh', 'svh',
];

// Elements known to have been problematic — always shown in constraint chain
const KEY_SELECTORS = [
  'html', 'body', '#app',
  '#detail-panel', '.detail-panel',
  '.dp-scroll', '.dp-content', '.dp-handle',
  '#venue-list', '.venue-list',
  '#map-container', '#map',
  '#top-bar', '#bottom-bar',
];

const args = process.argv.slice(2);
const focusTerms = args.length > 0 ? args : null;

// ── Collect files ─────────────────────────────────────────────────────────────

function collectFiles(dir, exts) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectFiles(full, exts));
    } else if (exts.includes(extname(entry))) {
      results.push(full);
    }
  }
  return results;
}

const htmlFiles = collectFiles(ROOT, ['.html']);
const jsFiles = collectFiles(join(ROOT, 'js'), ['.js']);

// ── Parse CSS blocks from HTML <style> tags ───────────────────────────────────

function extractCssFromHtml(src, filename) {
  const rules = [];
  const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let sm;
  while ((sm = styleRe.exec(src)) !== null) {
    const css = sm[1];
    const baseOffset = src.slice(0, sm.index).split('\n').length;
    // Simple block parser — handles single-level rules
    const ruleRe = /([^{]+)\{([^}]*)\}/g;
    let rm;
    while ((rm = ruleRe.exec(css)) !== null) {
      const selector = rm[1].trim();
      const body = rm[2];
      const lineNo = baseOffset + css.slice(0, rm.index).split('\n').length - 1;
      const props = {};
      for (const decl of body.split(';')) {
        const [prop, ...rest] = decl.split(':');
        if (prop && rest.length) {
          props[prop.trim()] = rest.join(':').trim();
        }
      }
      if (Object.keys(props).length) {
        rules.push({ selector, props, file: filename.replace(ROOT, ''), line: lineNo, type: 'css' });
      }
    }
  }
  return rules;
}

// ── Parse inline style assignments from JS ────────────────────────────────────
// Matches: el.style.height = ..., el.style.setProperty('--vh', ...), style="..."

function extractJsStyles(src, filename) {
  const hits = [];
  const lines = src.split('\n');

  lines.forEach((line, i) => {
    // el.style.prop = value
    const assignRe = /\.style\.(\w+)\s*=\s*(.+)/g;
    let m;
    while ((m = assignRe.exec(line)) !== null) {
      hits.push({ prop: m[1], value: m[2].trim(), file: filename.replace(ROOT, ''), line: i + 1, context: line.trim(), type: 'js-assign' });
    }
    // el.style.setProperty(...)
    const setPropRe = /\.style\.setProperty\(\s*['"]([^'"]+)['"]\s*,\s*(.+?)\)/g;
    while ((m = setPropRe.exec(line)) !== null) {
      hits.push({ prop: m[1], value: m[2].trim(), file: filename.replace(ROOT, ''), line: i + 1, context: line.trim(), type: 'js-setprop' });
    }
    // documentElement/root setProperty for CSS vars
    const rootVarRe = /setProperty\(\s*['"](--.+?)['"]/g;
    while ((m = rootVarRe.exec(line)) !== null) {
      hits.push({ prop: m[1], value: '(dynamic)', file: filename.replace(ROOT, ''), line: i + 1, context: line.trim(), type: 'js-cssvar' });
    }
  });

  return hits;
}

// ── Match helpers ─────────────────────────────────────────────────────────────

function propMatches(prop, terms) {
  if (!terms) return LAYOUT_PROPS.some(p => prop.toLowerCase().includes(p));
  return terms.some(t => prop.toLowerCase().includes(t.toLowerCase()));
}

function selectorMatches(sel, terms) {
  if (!terms) return KEY_SELECTORS.some(s => sel.includes(s));
  return terms.some(t => sel.toLowerCase().includes(t.toLowerCase()));
}

function lineMatches(line, terms) {
  if (!terms) return LAYOUT_PROPS.some(p => line.toLowerCase().includes(p));
  return terms.some(t => line.toLowerCase().includes(t.toLowerCase()));
}

// ── Collect and print ─────────────────────────────────────────────────────────

console.log('\n╔══════════════════════════════════════════════════════╗');
console.log('║  LAYOUT CONSTRAINT AUDIT                             ║');
if (focusTerms) console.log(`║  Focus: ${focusTerms.join(', ').padEnd(44)}║`);
console.log('╚══════════════════════════════════════════════════════╝\n');

// CSS rules
console.log('── CSS RULES (' + (focusTerms ? `matching "${focusTerms.join('|')}"` : 'key selectors') + ') ──\n');

let cssRules = [];
for (const f of htmlFiles) {
  cssRules.push(...extractCssFromHtml(readFileSync(f, 'utf8'), f));
}

const matchedCss = cssRules.filter(r => {
  const selMatch = selectorMatches(r.selector, focusTerms);
  const propMatch = Object.keys(r.props).some(p => propMatches(p, focusTerms));
  return focusTerms ? (selMatch || propMatch) : (selMatch && propMatch);
});

if (matchedCss.length === 0) {
  console.log('  (none)\n');
} else {
  for (const r of matchedCss) {
    console.log(`  ${r.file}:${r.line}  ${r.selector}`);
    for (const [prop, val] of Object.entries(r.props)) {
      if (propMatches(prop, focusTerms) || focusTerms?.some(t => r.selector.toLowerCase().includes(t.toLowerCase()))) {
        const flag = isConflict(prop, val, r.selector, matchedCss) ? '  ⚠ CONFLICT?' : '';
        console.log(`    ${prop}: ${val}${flag}`);
      }
    }
    console.log();
  }
}

// Conflict detector: same property set differently on same selector
function isConflict(prop, val, selector, rules) {
  const same = rules.filter(r => r.selector === selector && r.props[prop] && r.props[prop] !== val);
  return same.length > 0;
}

// Duplicate height check across selectors
console.log('── HEIGHT DECLARATIONS (all key elements) ──\n');
const heightRules = cssRules.filter(r =>
  KEY_SELECTORS.some(s => r.selector.includes(s)) &&
  Object.keys(r.props).some(p => p.includes('height'))
);
for (const r of heightRules) {
  for (const [prop, val] of Object.entries(r.props)) {
    if (prop.includes('height')) {
      console.log(`  ${r.selector.padEnd(30)} ${prop}: ${val}   (${r.file}:${r.line})`);
    }
  }
}
console.log();

// JS inline styles
console.log('── JS INLINE STYLE ASSIGNMENTS ──\n');
let jsHits = [];
for (const f of jsFiles) {
  jsHits.push(...extractJsStyles(readFileSync(f, 'utf8'), f));
}
for (const h of jsFiles.flatMap(f => extractJsStyles(readFileSync(f, 'utf8'), f))) {
  if (propMatches(h.prop, focusTerms) || lineMatches(h.context, focusTerms)) {
    console.log(`  ${h.file}:${h.line}`);
    console.log(`    ${h.prop} = ${h.value}`);
    console.log(`    » ${h.context}`);
    console.log();
  }
}

// Potential conflicts: same CSS var set in both CSS and JS
console.log('── CSS VAR CONFLICTS (set in CSS + overridden in JS) ──\n');
const cssVarProps = cssRules.flatMap(r =>
  Object.keys(r.props).filter(p => p.startsWith('--')).map(p => ({ prop: p, selector: r.selector, val: r.props[p], file: r.file, line: r.line }))
);
const jsVarProps = jsFiles.flatMap(f =>
  extractJsStyles(readFileSync(f, 'utf8'), f).filter(h => h.prop.startsWith('--'))
);

for (const jv of jsVarProps) {
  const cssMatch = cssVarProps.find(cv => cv.prop === jv.prop);
  if (cssMatch) {
    console.log(`  ⚠ ${jv.prop}`);
    console.log(`    CSS default: ${cssMatch.val}   (${cssMatch.file}:${cssMatch.line}  ${cssMatch.selector})`);
    console.log(`    JS override: ${jv.value}   (${jv.file}:${jv.line})`);
    console.log();
  }
}

console.log('── OVERFLOW SETTINGS (key elements) ──\n');
const overflowRules = cssRules.filter(r =>
  KEY_SELECTORS.some(s => r.selector.includes(s)) &&
  Object.keys(r.props).some(p => p.includes('overflow'))
);
for (const r of overflowRules) {
  for (const [prop, val] of Object.entries(r.props)) {
    if (prop.includes('overflow')) {
      console.log(`  ${r.selector.padEnd(30)} ${prop}: ${val}   (${r.file}:${r.line})`);
    }
  }
}
console.log();

// Media queries that affect key elements
console.log('── MOBILE MEDIA QUERIES (@media) ──\n');
for (const f of htmlFiles) {
  const src = readFileSync(f, 'utf8');
  const mqRe = /@media[^{]+\{([\s\S]*?)(?=\n\s*@media|\n\s*<\/style>)/g;
  let m;
  while ((m = mqRe.exec(src)) !== null) {
    const block = m[0];
    const lineNo = src.slice(0, m.index).split('\n').length;
    const hasKeyEl = KEY_SELECTORS.some(s => block.includes(s));
    const hasFocusTerm = focusTerms ? focusTerms.some(t => block.toLowerCase().includes(t.toLowerCase())) : hasKeyEl;
    if (hasFocusTerm) {
      console.log(`  ${f.replace(ROOT, '')}:${lineNo}`);
      console.log(block.split('\n').slice(0, 15).map(l => '  ' + l).join('\n'));
      console.log();
    }
  }
}

console.log('\n── DONE ──\n');
