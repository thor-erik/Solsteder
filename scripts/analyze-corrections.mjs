/**
 * analyze-corrections.mjs
 *
 * Reads a corrections JSON file exported from the browser (via the "Eksporter" button
 * in the edit overlay) and uses the Claude API to identify patterns and suggest
 * improvements to the geometry model in update-geometry.mjs.
 *
 * Usage:
 *   node scripts/analyze-corrections.mjs path/to/corrections.json
 *
 * Requires:
 *   ANTHROPIC_API_KEY environment variable
 *   npm install @anthropic-ai/sdk  (or: npx --yes @anthropic-ai/sdk)
 */

import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';

// ── Read input file ────────────────────────────────────────────────────────────
const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node scripts/analyze-corrections.mjs <corrections.json>');
  process.exit(1);
}

const corrections = JSON.parse(fs.readFileSync(filePath, 'utf8'));
const total       = corrections.length;
const confirmed   = corrections.filter(c => c.type === 'confirmed').length;
const changed     = corrections.filter(c => c.type === 'correction').length;

console.log(`\nLoaded ${total} records: ${confirmed} confirmed, ${changed} corrections\n`);
if (!changed) {
  console.log('No corrections to analyse — model looks good!');
  process.exit(0);
}

// ── Read update-geometry.mjs for context ──────────────────────────────────────
const geometryScript = fs.readFileSync(
  path.join(path.dirname(filePath), '..', 'scripts', 'update-geometry.mjs'),
  'utf8'
);

// ── Build prompt ──────────────────────────────────────────────────────────────
const correctionSummary = corrections
  .filter(c => c.type === 'correction')
  .map(c => {
    const b = c.before, a = c.after;
    const changes = [];
    if (b.terraceType !== a.terraceType)
      changes.push(`terraceType: ${b.terraceType} → ${a.terraceType}`);
    if (JSON.stringify(b.terraceWallIndices) !== JSON.stringify(a.terraceWallIndices))
      changes.push(`wallIndices: [${b.terraceWallIndices}] → [${a.terraceWallIndices}]`);
    if (b.terraceDepth !== a.terraceDepth)
      changes.push(`depth: ${b.terraceDepth} → ${a.terraceDepth}`);
    if (Math.abs((b.facing ?? 0) - (a.facing ?? 0)) > 5)
      changes.push(`facing: ${b.facing}° → ${a.facing}°`);
    if (b.terraceDetachedLocation !== a.terraceDetachedLocation)
      changes.push('location: moved detached pin');
    return `• ${c.name} (${c.category}, ${c.buildingNodeCount ?? '?'} nodes) — ${changes.join(', ')}`;
  }).join('\n');

const confirmedSummary = corrections
  .filter(c => c.type === 'confirmed')
  .map(c => `• ${c.name} (${c.category}) — ${c.state.terraceType}, facing ${c.state.facing}°`)
  .join('\n');

const prompt = `You are analysing correction data from a solar venue finder app (Solsteder) to improve how the app automatically places outdoor terrace footprints on venues in Oslo.

## What the model does
The \`update-geometry.mjs\` script fetches OSM building geometry for each venue and tries to automatically determine:
1. Which wall faces the street / has the outdoor terrace (\`autoTerraceWallIndices\`)
2. The terrace depth in metres (\`autoTerraceDepth\`)
3. The primary facing direction (\`facing\` in degrees)

Users can then manually correct these in an editor. The corrections below are the diff between what the model computed and what the user set.

## Corrections (what the model got wrong)
${correctionSummary}

## Confirmed correct (what the model got right — positive signal)
${confirmedSummary.length ? confirmedSummary : '(none yet)'}

## Current update-geometry.mjs (the script to improve)
\`\`\`js
${geometryScript.slice(0, 8000)}${geometryScript.length > 8000 ? '\n... (truncated)' : ''}
\`\`\`

## Your task
1. Identify patterns in the corrections. What types of venues / building shapes / situations does the model consistently get wrong?
2. Suggest specific, targeted changes to \`update-geometry.mjs\` that would fix these patterns.
3. For each suggestion, show the exact code change (old → new) so I can apply it directly.

Be concrete. Skip general advice. Focus only on patterns that appear in ≥2 corrections or that represent a clear logical flaw.`;

// ── Call Claude API ────────────────────────────────────────────────────────────
const client = new Anthropic();

console.log('Sending to Claude for analysis...\n');

const message = await client.messages.create({
  model:      'claude-opus-4-6',
  max_tokens: 4096,
  messages:   [{ role: 'user', content: prompt }],
});

const analysis = message.content[0].text;
console.log('═'.repeat(72));
console.log('CORRECTION ANALYSIS');
console.log('═'.repeat(72));
console.log(analysis);
console.log('═'.repeat(72));

// Optionally save to file
const outPath = filePath.replace('.json', '-analysis.md');
fs.writeFileSync(outPath, `# Correction Analysis\n\nGenerated: ${new Date().toISOString()}\nInput: ${filePath}\n\n${analysis}\n`);
console.log(`\nSaved to: ${outPath}`);
