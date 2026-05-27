#!/usr/bin/env node
/**
 * sync-seating-from-supabase.mjs
 * Pull the shared seating_corrections log from Supabase and replay it into
 * data/seating-detected.json (source: "manual") — the DB-sourced replacement
 * for merge-seating-corrections.mjs. Manual records are protected from
 * --force-all in detect-seating-areas.mjs exactly as before.
 *
 * Env:
 *   SUPABASE_URL          (default: prod project URL)
 *   SUPABASE_SERVICE_KEY  (service role key — bypasses RLS; CI secret)
 *
 * Usage:
 *   node scripts/sync-seating-from-supabase.mjs
 *   node scripts/sync-seating-from-supabase.mjs --commit-and-push
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const COMMIT_PUSH = process.argv.includes('--commit-and-push');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wxalqodaeqgzahwlovnw.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!KEY) {
  console.error('Missing SUPABASE_SERVICE_KEY env var (service-role key).');
  process.exit(1);
}

/** Fetch the whole seating_corrections log, oldest-first (replay order). */
async function fetchAll() {
  const out = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const url = `${SUPABASE_URL}/rest/v1/seating_corrections`
      + `?select=venue_id,type,polygon,before,after,origin,created_at`
      + `&order=created_at.asc`;
    const resp = await fetch(url, {
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        Range: `${from}-${from + pageSize - 1}`,
      },
    });
    if (!resp.ok) {
      console.error('Supabase fetch failed:', resp.status, await resp.text());
      process.exit(2);
    }
    const rows = await resp.json();
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

const cachePath = join(ROOT, 'data/seating-detected.json');
const cache = existsSync(cachePath)
  ? JSON.parse(readFileSync(cachePath, 'utf8'))
  : { version: 1, venues: {} };
if (!cache.venues) cache.venues = {};

const corrections = await fetchAll();
let merged = 0, cleared = 0, skipped = 0;

// Replay chronologically; the latest polygon per venue wins. Mirrors
// merge-seating-corrections.mjs so the output is byte-compatible.
for (const c of corrections) {
  if (c.type !== 'correction') { skipped++; continue; }
  const after = c.after ?? {};
  const polygon = (c.polygon !== undefined && c.polygon !== null)
    ? c.polygon
    : (after.seatingPolygonOverride !== undefined ? after.seatingPolygonOverride : undefined);
  if (polygon === undefined) { skipped++; continue; }

  const key = String(c.venue_id);

  if (Array.isArray(polygon) && polygon.length >= 3) {
    const prev = cache.venues[key];
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
    const before = c.before ?? {};
    const beforeHadPoly = Array.isArray(before.seatingPolygonOverride)
      && before.seatingPolygonOverride.length >= 3;
    const origin = c.origin ?? (beforeHadPoly ? 'drag-edit' : 'from-scratch');
    cache.venues[key] = {
      ...(prev ?? {}),
      polygon,
      confidence: 1.0,
      notVisible: false,
      detectedAt: c.created_at ?? new Date().toISOString(),
      source:    'manual',
      origin,
      reasoning: 'supabase-sync',
      ...(originalAi ? { originalAi } : {}),
    };
    merged++;
  } else if (polygon === null) {
    if (cache.venues[key]?.source === 'manual') {
      const prev = cache.venues[key];
      if (prev.originalAi) cache.venues[key] = { ...prev.originalAi, source: 'ai' };
      else delete cache.venues[key];
      cleared++;
    }
  }
}

writeFileSync(cachePath, JSON.stringify(cache, null, 2));
console.log(`Synced ${merged} manual polygon(s), cleared ${cleared}, skipped ${skipped} of ${corrections.length} rows.`);
console.log(`Updated: ${cachePath}`);

if (COMMIT_PUSH) {
  try {
    execSync(`git add ${JSON.stringify(cachePath)}`, { cwd: ROOT, stdio: 'inherit' });
    try {
      execSync('git diff --cached --quiet -- data/seating-detected.json', { cwd: ROOT, stdio: 'ignore' });
      console.log('No changes to commit.');
      process.exit(0);
    } catch (_) { /* staged changes exist */ }
    execSync('git commit -m "chore: sync manual seating polygons from Supabase [skip ci]"', { cwd: ROOT, stdio: 'inherit' });
    execSync('git push origin HEAD', { cwd: ROOT, stdio: 'inherit' });
  } catch (err) {
    console.error('git step failed:', err.message);
    process.exit(2);
  }
}
