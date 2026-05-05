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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node scripts/merge-seating-corrections.mjs <corrections.json>');
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
    cache.venues[key] = {
      ...(prev ?? {}),
      polygon,
      confidence: 1.0,
      notVisible: false,
      detectedAt: c.timestamp ?? new Date().toISOString(),
      source:    'manual',
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
