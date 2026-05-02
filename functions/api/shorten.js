// Cloudflare Pages Function: POST /api/shorten
//
// Generates a short ID (6-char base62) for a long invite token and stores
// the mapping in KV. The short URL `/s/<id>` redirects to the canonical
// `/i/<token>` route (which still does the OG-preview render and SPA bounce).
//
// SETUP: requires a KV namespace bound as `SHORTLINKS` in the Cloudflare
// Pages project Settings → Functions → KV namespace bindings. When the
// binding is missing the endpoint returns 503 and clients fall back to the
// long URL — the feature degrades cleanly.
//
// TTL: 30 days. Plans / invites typically resolve within a day or two; 30d
// is a comfortable buffer that also bounds KV growth.

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ID_LEN = 6;
const TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_RETRIES = 5;
const MAX_TOKEN_LEN = 4096;

function generateShortId() {
  const bytes = new Uint8Array(ID_LEN);
  crypto.getRandomValues(bytes);
  let id = '';
  for (let i = 0; i < ID_LEN; i++) id += ALPHABET[bytes[i] % 62];
  return id;
}

async function reserveShortId(kv, token) {
  for (let i = 0; i < MAX_RETRIES; i++) {
    const id = generateShortId();
    const existing = await kv.get(id);
    if (existing == null) {
      await kv.put(id, token, { expirationTtl: TTL_SECONDS });
      return id;
    }
  }
  return null;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  if (!env.SHORTLINKS) {
    return new Response(JSON.stringify({ error: 'kv_not_configured' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
  let body;
  try { body = await request.json(); }
  catch { return new Response('Bad JSON', { status: 400 }); }

  const token = body && body.token;
  if (typeof token !== 'string' || !token.length || token.length > MAX_TOKEN_LEN) {
    return new Response('Invalid token', { status: 400 });
  }
  // Tokens are base64-encoded JSON or UUIDs — both fit this charset. Reject
  // anything else so we don't store arbitrary data.
  if (!/^[A-Za-z0-9+/=_\-]+$/.test(token)) {
    return new Response('Invalid token chars', { status: 400 });
  }

  const id = await reserveShortId(env.SHORTLINKS, token);
  if (!id) {
    return new Response(JSON.stringify({ error: 'collision_exhausted' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ id }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}
