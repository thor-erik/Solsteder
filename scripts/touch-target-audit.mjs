#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// touch-target-audit.mjs — flag interactive controls with an explicit
// height/min-height below the 44px touch-target minimum (Apple HIG / WCAG 2.5.5).
//
// Heuristic: scans css/*.css for rules that declare `cursor: pointer` and an
// explicit height (or min-height) < 44px. It can't measure the rendered hit
// area (padding + line-height + content), so treat the output as candidates to
// review — many wide pills have ample horizontal area and only fail on height.
//
// Fixing: prefer an invisible 44×44 ::after hit-area (zero visual change) over
// min-height (which bloats dense rows). BUT a hit area larger than the control
// can steal clicks from adjacent controls — only expand standalone buttons, or
// verify on a device. Node built-ins only.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIN = 44;

const files = readdirSync(join(ROOT, 'css')).filter((f) => f.endsWith('.css'));
const hits = [];
for (const f of files) {
  const css = readFileSync(join(ROOT, 'css', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const sel = m[1].trim();
    const body = m[2];
    if (!/cursor:\s*pointer/.test(body)) continue;
    if (/::(after|before)/.test(sel)) continue;
    const h = (body.match(/(?:^|[;{])\s*height:\s*([0-9.]+)px/) || [])[1];
    const mh = (body.match(/min-height:\s*([0-9.]+)px/) || [])[1];
    const eff = mh || h;
    if (eff && parseFloat(eff) < MIN) hits.push({ f, eff: parseFloat(eff), sel: sel.slice(0, 64) });
  }
}
hits.sort((a, b) => a.eff - b.eff);
console.log(`\nInteractive controls with explicit height < ${MIN}px (review candidates)\n`);
console.log('  height  file                      selector');
console.log('  ──────  ────────────────────────  ' + '─'.repeat(40));
const seen = new Set();
for (const h of hits) {
  const key = h.sel + h.f;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`  ${String(h.eff + 'px').padStart(5)}   ${h.f.padEnd(24)}  ${h.sel}`);
}
console.log(`\n${seen.size} candidate(s). Expand standalone buttons via an invisible ::after hit-area; verify dense rows on a device (overlap can steal adjacent clicks).\n`);
process.exit(0);
