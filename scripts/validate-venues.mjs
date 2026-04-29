#!/usr/bin/env node
/**
 * validate-venues.mjs
 * Minimal JSON-Schema-style validator for data/venues.json against
 * data/venues.schema.json. Designed to catch the common bug categories
 * (missing required field, wrong type, bad enum value, out-of-range
 * number). Not a full JSON Schema implementation — keeps the project
 * dependency-free.
 *
 * Usage:
 *   node scripts/validate-venues.mjs
 *
 * Exit code 0 on success, 1 on validation failure. Suitable for CI.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

const venues = JSON.parse(readFileSync(join(ROOT, 'data/venues.json'), 'utf8'));
const schema = JSON.parse(readFileSync(join(ROOT, 'data/venues.schema.json'), 'utf8'));

const itemSchema = schema.items;
const required   = itemSchema.required ?? [];
const propsDef   = itemSchema.properties ?? {};

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typesAllowed(def) {
  const t = def.type;
  if (Array.isArray(t)) return t;
  return t ? [t] : [];
}

function checkValue(path, value, def, errors) {
  const allowed = typesAllowed(def);
  const t = typeOf(value);
  // 'integer' satisfies both 'integer' and 'number'
  const ok = allowed.length === 0 ||
             allowed.includes(t) ||
             (t === 'integer' && allowed.includes('number'));
  if (!ok) {
    errors.push(`${path}: expected ${allowed.join('|')}, got ${t}`);
    return;
  }
  if (def.enum && !def.enum.includes(value)) {
    errors.push(`${path}: value ${JSON.stringify(value)} not in enum [${def.enum.map(JSON.stringify).join(', ')}]`);
  }
  if (typeof value === 'number') {
    if (def.minimum != null && value < def.minimum) errors.push(`${path}: ${value} < minimum ${def.minimum}`);
    if (def.maximum != null && value > def.maximum) errors.push(`${path}: ${value} > maximum ${def.maximum}`);
  }
  if (typeof value === 'string') {
    if (def.minLength != null && value.length < def.minLength) errors.push(`${path}: string shorter than ${def.minLength}`);
  }
  if (Array.isArray(value)) {
    if (def.minItems != null && value.length < def.minItems) errors.push(`${path}: fewer than ${def.minItems} items`);
    if (def.maxItems != null && value.length > def.maxItems) errors.push(`${path}: more than ${def.maxItems} items`);
    if (def.items) value.forEach((v, i) => checkValue(`${path}[${i}]`, v, def.items, errors));
  }
  if (def.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    if (def.required) {
      for (const key of def.required) {
        if (!(key in value)) errors.push(`${path}.${key}: missing required field`);
      }
    }
    if (def.properties) {
      for (const [k, v] of Object.entries(value)) {
        if (def.properties[k]) checkValue(`${path}.${k}`, v, def.properties[k], errors);
      }
    }
    if (def.additionalProperties && typeof def.additionalProperties === 'object') {
      const known = new Set(Object.keys(def.properties ?? {}));
      for (const [k, v] of Object.entries(value)) {
        if (!known.has(k)) checkValue(`${path}.${k}`, v, def.additionalProperties, errors);
      }
    }
  }
}

const errors = [];
const idsSeen = new Map();
const placeIdsSeen = new Map();

venues.forEach((v, i) => {
  const path = `[${i}](${v.name ?? '<no name>'})`;
  for (const r of required) {
    if (!(r in v)) errors.push(`${path}.${r}: missing required field`);
  }
  for (const [k, val] of Object.entries(v)) {
    const pdef = propsDef[k];
    if (!pdef) {
      if (itemSchema.additionalProperties === false) {
        errors.push(`${path}.${k}: unexpected field (additionalProperties=false)`);
      }
      continue;
    }
    checkValue(`${path}.${k}`, val, pdef, errors);
  }
  // Cross-record uniqueness
  if (v.id != null) {
    if (idsSeen.has(v.id)) errors.push(`${path}.id: duplicate id ${v.id} (also ${idsSeen.get(v.id)})`);
    else idsSeen.set(v.id, v.name);
  }
  if (v.googlePlaceId) {
    if (placeIdsSeen.has(v.googlePlaceId)) {
      errors.push(`${path}.googlePlaceId: duplicate (also "${placeIdsSeen.get(v.googlePlaceId)}")`);
    } else {
      placeIdsSeen.set(v.googlePlaceId, v.name);
    }
  }
});

if (errors.length === 0) {
  console.log(`✓ data/venues.json is valid (${venues.length} entries).`);
  process.exit(0);
}

console.error(`✗ data/venues.json failed validation (${errors.length} error${errors.length > 1 ? 's' : ''}):\n`);
for (const e of errors.slice(0, 50)) console.error(`  ${e}`);
if (errors.length > 50) console.error(`  …and ${errors.length - 50} more`);
process.exit(1);
