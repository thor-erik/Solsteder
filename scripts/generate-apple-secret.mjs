#!/usr/bin/env node
/**
 * Generate an Apple client_secret JWT for Sign in with Apple / Supabase.
 *
 * Usage:
 *   node scripts/generate-apple-secret.mjs \
 *     --team-id YOUR_TEAM_ID \
 *     --key-id YOUR_KEY_ID \
 *     --service-id app.findshades.auth \
 *     --key-file path/to/AuthKey_XXXXXX.p8
 *
 * The output JWT is valid for 180 days (Apple maximum).
 * Paste it into Supabase → Authentication → Providers → Apple → Secret Key.
 */

import { readFileSync } from 'fs';
import { createPrivateKey, createSign } from 'crypto';

// ── Parse args ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= args.length) {
    console.error(`Missing required flag: --${name}`);
    process.exit(1);
  }
  return args[i + 1];
}

const teamId    = flag('team-id');
const keyId     = flag('key-id');
const serviceId = flag('service-id');
const keyFile   = flag('key-file');

// ── Build JWT ────────────────────────────────────────────────────────────────
const now = Math.floor(Date.now() / 1000);
const exp = now + 86400 * 180; // 180 days

const header = { alg: 'ES256', kid: keyId };
const payload = {
  iss: teamId,
  iat: now,
  exp,
  aud: 'https://appleid.apple.com',
  sub: serviceId,
};

function base64url(obj) {
  return Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

const headerB64  = base64url(header);
const payloadB64 = base64url(payload);
const signingInput = `${headerB64}.${payloadB64}`;

const pem = readFileSync(keyFile, 'utf8');
const key = createPrivateKey({ key: pem, format: 'pem' });

const sign = createSign('SHA256');
sign.update(signingInput);
const derSig = sign.sign({ key, dsaEncoding: 'ieee-p1363' });

const sigB64 = derSig
  .toString('base64')
  .replace(/=/g, '')
  .replace(/\+/g, '-')
  .replace(/\//g, '_');

const jwt = `${signingInput}.${sigB64}`;

console.log('\n=== Apple Client Secret JWT ===\n');
console.log(jwt);
console.log('\nExpires:', new Date(exp * 1000).toISOString().slice(0, 10));
console.log('\nPaste this into Supabase → Authentication → Providers → Apple → Secret Key\n');
