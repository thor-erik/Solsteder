#!/usr/bin/env node
/**
 * merge-seating-corrections.mjs
 * Ingest a corrections export from the in-app editor and write any manual
 * seating-polygon edits into data/seating-detected.json (source: "manual").
 *
 * Manual records are protected from being overwritten by --force-all in
 * detect-seating-areas.mjs.
 *
 * Usage:
 *   node scripts/merge-seating-corrections.mjs <path-to-corrections.json>
 *   node scripts/merge-seating-corrections.mjs <path> --commit-and-push
 *
 * Recognised correction shapes (from js/data.js#saveCorrection):
 *   { type:'correction', id, name,
 *     before:{ ..., seatingPolygonOverride },
 *     after: { ..., seatingPolygonOverride: [[lat,lng], ...] },
 *     autoState:'manual-polygon-edit' | 'manual-override-ai' }
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

const args         = process.argv.slice(2);
const COMMIT_PUSH  = args.includes('--commit-and-push');
const inputPath    = args.find(a => !a.startsWith('--'));
if (!inputPath) {
  console.error('Usage: node scripts/merge-seating-corrections.mjs <corrections.json> [--commit-and-push]');
  process.exit(1);
}

const cachePath = join(ROOT, 'data/seating-detected.json');
const cache = existsSync(cachePath)
  ? JSON.parse(readFileSync(cachePath, 'utf8'))
  : { version: 1, venues: {} };
if (!cache.venues) cache.venues = {};

const corrections = JSON.parse(readFileSync(inputPath, 'utf8'));
if (!Array.isArray(corrections)) {
  console.error('Corrections file must be a JSON array.');
  process.exit(1);
}

let merged = 0, cleared = 0, skipped = 0;

// Replay in chronological order so the most recent edit per venue wins.
const ordered = corrections
  .filter(c => c.type === 'correction' && c.after)
  .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

for (const c of ordered) {
  const after = c.after ?? {};
  const polygon = after.seatingPolygonOverride;
  // Only act on records that actually touch the polygon override field.
  if (polygon === undefined && c.before?.seatingPolygonOverride === undefined) {
    skipped++; continue;
  }

  const id  = String(c.id);
  const key = id;

  if (Array.isArray(polygon) && polygon.length >= 3) {
    const prev = cache.venues[key];
    // Preserve the AI proposal so evaluate-detection.mjs can compute IoU
    // (correction vs. AI) and the few-shot selector knows the model failed
    // here. Don't double-wrap if this venue was already manual.
    let originalAi = prev?.originalAi ?? null;
    if (prev && prev.source === 'ai' && Array.isArray(prev.polygon) && prev.polygon.length >= 3) {
      originalAi = {
        polygon:    prev.polygon,
        confidence: prev.confidence,
        notVisible: prev.notVisible,
        reasoning:  prev.reasoning,
        model:      prev.model,
        promptHash: prev.promptHash ?? null,
        detectedAt: prev.detectedAt,
      };
    }
    // Origin: 'from-scratch' (user drew a new polygon) vs 'drag-edit' (user
    // dragged vertices on an existing polygon). The editor sets c.origin
    // explicitly when it knows; otherwise we infer from the diff.
    //   - before had no override, after has one → from-scratch
    //   - before had an override that differs from after → drag-edit
    // While the AI is still being calibrated, from-scratch corrections are
    // strictly more valuable as few-shot examples; once AI quality is good
    // we can weight or filter by this field.
    const before = c.before ?? {};
    const beforeHadPoly = Array.isArray(before.seatingPolygonOverride)
      && before.seatingPolygonOverride.length >= 3;
    const inferredOrigin = beforeHadPoly ? 'drag-edit' : 'from-scratch';
    const origin = c.origin ?? c.after?.origin ?? inferredOrigin;
    cache.venues[key] = {
      ...(prev ?? {}),
      polygon,
      confidence: 1.0,
      notVisible: false,
      detectedAt: c.timestamp ?? new Date().toISOString(),
      source:    'manual',
      origin,
      reasoning: c.autoState ?? 'manual-polygon-edit',
      ...(originalAi ? { originalAi } : {}),
    };
    merged++;
  } else if (polygon === null) {
    // User cleared the override → revert to the AI record (if any).
    if (cache.venues[key]?.source === 'manual') {
      const prev = cache.venues[key];
      if (prev.originalAi) {
        // Restore the AI record we stashed when first overwritten.
        cache.venues[key] = { ...prev.originalAi, source: 'ai' };
      } else {
        delete cache.venues[key];
      }
      cleared++;
    }
  }
}

writeFileSync(cachePath, JSON.stringify(cache, null, 2));
console.log(`Merged ${merged} manual polygon(s), cleared ${cleared}, skipped ${skipped} unrelated.`);
console.log(`Updated: ${cachePath}`);

if (COMMIT_PUSH) {
  if (merged === 0 && cleared === 0) {
    console.log('Nothing to commit — exiting without git changes.');
    process.exit(0);
  }
  const summary = `${merged} added, ${cleared} cleared`;
  try {
    // Stage just the file we touched — never -A — so we don't sweep up
    // unrelated unstaged changes a contributor might have lying around.
    execSync(`git add ${JSON.stringify(cachePath)}`, { cwd: ROOT, stdio: 'inherit' });
    // Skip the commit if the staged diff is empty (e.g. corrections were
    // already merged in a previous run).
    try {
      execSync('git diff --cached --quiet -- data/seating-detected.json', { cwd: ROOT, stdio: 'ignore' });
      console.log('No changes to commit (corrections already merged previously).');
      process.exit(0);
    } catch (_) { /* diff returned non-zero → there ARE staged changes */ }

    const msg = `chore: import manual seating corrections (${summary})`;
    execSync(`git commit -m ${JSON.stringify(msg)}`,  { cwd: ROOT, stdio: 'inherit' });
    execSync('git push origin HEAD',                  { cwd: ROOT, stdio: 'inherit' });
    console.log(`Pushed ${summary}.`);
  } catch (err) {
    console.error('git step failed:', err.message);
    console.error('The merge succeeded — re-run `git add/commit/push` manually if needed.');
    process.exit(2);
  }
}
