// supabase/functions/send-push/index.ts
//
// Push fan-out for Shades. Called from database triggers that read a
// shared secret from public._app_settings and forward it as X-Push-Secret.
//
// Per-platform dispatch:
//   * platform='web'     → web-push (VAPID-signed) to the subscription endpoint
//   * platform='ios'     → APN HTTP/2 POST to api.push.apple.com,
//                          signed with the .p8 auth key (ES256 JWT)
//   * platform='android' → FCM HTTP v1 POST to fcm.googleapis.com,
//                          signed with the Firebase service account JWT
//
// Triggers don't know about platforms. They emit one push intent per
// user; this function reads each push_subscriptions row's platform
// discriminator (sql/043) and routes to the right delivery channel.
//
// ── Auth model ──────────────────────────────────────────────────────────────
// Deployed `--no-verify-jwt` because the DB triggers fire as SECURITY
// DEFINER and don't sign requests with a real user JWT. Caller is
// authenticated via the X-Push-Secret header (constant-time compared to
// the PUSH_TRIGGER_SECRET env var). Anonymous callers get 401 and the
// function never touches push_subscriptions.
//
// ── Payload validation ──────────────────────────────────────────────────────
// All caller-supplied fields are validated and capped:
//   * user_id     — must be a UUID
//   * payload.url — must be a same-origin path ('/...'); no protocol-
//                   relative '//evil.com', no https://, no header
//                   injection chars
//   * title/body/tag — capped to OS-friendly sizes
//
// ── Deploy ──────────────────────────────────────────────────────────────────
//   supabase functions deploy send-push --no-verify-jwt
//
// Required env (set by Supabase automatically):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Required secrets (set manually via `supabase secrets set`):
//   PUSH_TRIGGER_SECRET     — matches _app_settings WHERE key='send_push_secret'
//
//   Web push (VAPID):
//   VAPID_PUBLIC_KEY        — same value as VAPID_PUBLIC_KEY in js/push.js
//   VAPID_PRIVATE_KEY       — server-side only
//   VAPID_SUBJECT           — e.g. mailto:contact@findshades.app
//
//   iOS push (APN — set after Apple Developer portal setup):
//   APN_AUTH_KEY_BASE64     — full .p8 file contents, base64-encoded
//                             (avoids env-var newline parsing pitfalls).
//                             Generate locally with: base64 -i AuthKey_XXX.p8
//   APN_KEY_ID              — 10-char key ID from the APN key page
//   APN_TEAM_ID             — 10-char team ID from Membership page
//   APN_BUNDLE_ID           — 'app.findshades'
//   APN_ENV                 — 'sandbox' (TestFlight or local dev build)
//                             or 'production' (App Store). Defaults to
//                             'sandbox'. Both endpoints are otherwise
//                             identical.
//
//   Android push (FCM — set after Firebase project setup):
//   FCM_PROJECT_ID          — Firebase project ID
//   FCM_SERVICE_ACCOUNT     — service account JSON (one line, escaped)
//
// Any platform with missing secrets is silently skipped — the function
// still delivers to platforms that ARE configured. So you can stand up
// iOS first, leave Android empty, and FCM-targeted rows just get
// counted as "skipped".

import { serve }        from 'https://deno.land/std@0.224.0/http/server.ts';
import webpush          from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

const VAPID_PUBLIC  = Deno.env.get('VAPID_PUBLIC_KEY')  || '';
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') || '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT')     || '';
if (VAPID_PUBLIC && VAPID_PRIVATE && VAPID_SUBJECT) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

const APN_AUTH_KEY_BASE64 = Deno.env.get('APN_AUTH_KEY_BASE64') || '';
const APN_KEY_ID    = Deno.env.get('APN_KEY_ID')    || '';
const APN_TEAM_ID   = Deno.env.get('APN_TEAM_ID')   || '';
const APN_BUNDLE_ID = Deno.env.get('APN_BUNDLE_ID') || '';
const APN_ENV       = Deno.env.get('APN_ENV')       || 'sandbox';
const APN_CONFIGURED = !!(APN_AUTH_KEY_BASE64 && APN_KEY_ID && APN_TEAM_ID && APN_BUNDLE_ID);

const FCM_PROJECT_ID     = Deno.env.get('FCM_PROJECT_ID')     || '';
const FCM_SERVICE_ACCT   = Deno.env.get('FCM_SERVICE_ACCOUNT') || '';
const FCM_CONFIGURED = !!(FCM_PROJECT_ID && FCM_SERVICE_ACCT);

const TRIGGER_SECRET = Deno.env.get('PUSH_TRIGGER_SECRET') || '';

const MAX_TITLE_LEN = 80;
const MAX_BODY_LEN  = 500;
const MAX_URL_LEN   = 1024;
const MAX_TAG_LEN   = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-push-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

function sanitizeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > MAX_URL_LEN) return null;
  if (!raw.startsWith('/')) return null;
  if (raw.startsWith('//')) return null;
  if (/[\r\n\0]/.test(raw)) return null;
  return raw;
}

interface PushPayload { title: string; body: string; url: string; tag: string }

function sanitizePayload(raw: unknown): PushPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const title = typeof p.title === 'string' ? p.title.slice(0, MAX_TITLE_LEN) : 'Shades';
  const body  = typeof p.body  === 'string' ? p.body.slice(0,  MAX_BODY_LEN)  : '';
  const url   = sanitizeUrl(p.url) || '/';
  const tag   = typeof p.tag   === 'string' ? p.tag.slice(0,   MAX_TAG_LEN)   : 'shades-default';
  return { title, body, url, tag };
}

function j(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ── APN: ES256 JWT signing ──────────────────────────────────────────────────
//
// Apple wants a JWT signed with the private key from the .p8 file. The key
// is ECDSA P-256; the JWT alg is ES256. Apple accepts JWTs valid up to 60
// minutes; we mint fresh every 55 min to leave margin.

let _apnJwtCache    = '';
let _apnJwtExpiryMs = 0;
let _apnKeyPromise: Promise<CryptoKey> | null = null;

function _b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _b64urlEncodeJson(obj: object): string {
  return _b64urlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

async function _importApnKey(): Promise<CryptoKey> {
  if (!_apnKeyPromise) {
    _apnKeyPromise = (async () => {
      // APN_AUTH_KEY_BASE64 is base64(.p8 file contents). Decoding it
      // gives the PEM-formatted private key with BEGIN/END markers and
      // line breaks. Strip those to isolate the base64-encoded DER and
      // decode again into raw bytes for crypto.subtle.importKey.
      const pemText = atob(APN_AUTH_KEY_BASE64);
      const pemBody = pemText
        .replace(/-----BEGIN PRIVATE KEY-----/g, '')
        .replace(/-----END PRIVATE KEY-----/g, '')
        .replace(/\s+/g, '');
      const der = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
      return await crypto.subtle.importKey(
        'pkcs8',
        der,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign'],
      );
    })();
  }
  return _apnKeyPromise;
}

async function _makeApnJwt(): Promise<string> {
  if (_apnJwtCache && _apnJwtExpiryMs > Date.now() + 60_000) return _apnJwtCache;
  const key = await _importApnKey();
  const now = Math.floor(Date.now() / 1000);
  const header  = { alg: 'ES256', kid: APN_KEY_ID, typ: 'JWT' };
  const payload = { iss: APN_TEAM_ID, iat: now };
  const signingInput = `${_b64urlEncodeJson(header)}.${_b64urlEncodeJson(payload)}`;
  const sigBuf = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput),
  );
  const jwt = `${signingInput}.${_b64urlEncode(sigBuf)}`;
  _apnJwtCache    = jwt;
  _apnJwtExpiryMs = (now + 3300) * 1000; // 55 min
  return jwt;
}

async function _sendApn(deviceToken: string, payload: PushPayload):
    Promise<{ ok: boolean; status: number; reason?: string }> {
  const jwt  = await _makeApnJwt();
  const host = APN_ENV === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
  const body = JSON.stringify({
    aps: {
      alert:            { title: payload.title, body: payload.body },
      sound:            'default',
      'mutable-content': 1,
    },
    // Custom fields the client picks up in pushNotificationReceived /
    // pushNotificationActionPerformed listeners (see js/push.js).
    url: payload.url,
    tag: payload.tag,
  });
  const resp = await fetch(`https://${host}/3/device/${deviceToken}`, {
    method: 'POST',
    headers: {
      'authorization':    `bearer ${jwt}`,
      'apns-topic':       APN_BUNDLE_ID,
      'apns-push-type':   'alert',
      'apns-priority':    '10',
      'apns-collapse-id': payload.tag.slice(0, 64), // APN limit
      'content-type':     'application/json',
    },
    body,
  });
  if (resp.ok) return { ok: true, status: resp.status };
  // Apple returns JSON `{"reason":"BadDeviceToken"}` on 4xx
  let reason: string | undefined;
  try { reason = (await resp.json()).reason; } catch { /* no-op */ }
  return { ok: false, status: resp.status, reason };
}

// ── FCM HTTP v1 (Android) ───────────────────────────────────────────────────
//
// Stub for now — real implementation comes after the user sets up a
// Firebase project. The shape matches what the dispatcher expects so
// adding FCM later only touches this function and the env vars.

async function _sendFcm(_deviceToken: string, _payload: PushPayload):
    Promise<{ ok: boolean; status: number; reason?: string }> {
  if (!FCM_CONFIGURED) {
    return { ok: false, status: 501, reason: 'fcm-not-configured' };
  }
  // TODO: implement when Firebase is wired up. Needs service-account JWT
  // exchange for an OAuth token + POST to
  // https://fcm.googleapis.com/v1/projects/{FCM_PROJECT_ID}/messages:send.
  return { ok: false, status: 501, reason: 'fcm-not-implemented' };
}

// ── Per-platform dispatch ───────────────────────────────────────────────────

interface SubRow {
  id:        string;
  platform:  'web' | 'ios' | 'android';
  endpoint:  string | null;
  p256dh:    string | null;
  auth:      string | null;
  apn_token: string | null;
  fcm_token: string | null;
}

async function _sendWeb(sub: SubRow, payload: PushPayload):
    Promise<{ ok: boolean; status: number; reason?: string }> {
  if (!sub.endpoint || !sub.p256dh || !sub.auth) {
    return { ok: false, status: 400, reason: 'web-row-missing-fields' };
  }
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
    );
    return { ok: true, status: 200 };
  } catch (e) {
    const err = e as { statusCode?: number; status?: number; message?: string };
    return { ok: false, status: err.statusCode || err.status || 500, reason: err.message };
  }
}

async function _deliver(sub: SubRow, payload: PushPayload) {
  switch (sub.platform) {
    case 'web':     return _sendWeb(sub, payload);
    case 'ios':
      if (!APN_CONFIGURED || !sub.apn_token) return { ok: false, status: 501, reason: 'apn-skipped' };
      return _sendApn(sub.apn_token, payload);
    case 'android':
      if (!sub.fcm_token) return { ok: false, status: 400, reason: 'fcm-no-token' };
      return _sendFcm(sub.fcm_token, payload);
    default:
      return { ok: false, status: 400, reason: 'unknown-platform' };
  }
}

// Decide whether a delivery failure means we should DELETE the
// subscription row. Different platforms surface different "this device
// is gone forever" codes:
//   * Web push:       410 Gone, 404
//   * APN:            BadDeviceToken (400), Unregistered (410)
//   * FCM:            UNREGISTERED, INVALID_ARGUMENT for bad tokens
function _shouldDrop(platform: string, status: number, reason?: string): boolean {
  if (platform === 'web') return status === 410 || status === 404;
  if (platform === 'ios') {
    if (status === 410) return true;
    if (status === 400 && reason === 'BadDeviceToken') return true;
    return false;
  }
  if (platform === 'android') {
    return reason === 'UNREGISTERED' || (status === 404);
  }
  return false;
}

// ── Entry point ─────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return j(405, { error: 'method-not-allowed' });

  if (!TRIGGER_SECRET) {
    console.error('[send-push] PUSH_TRIGGER_SECRET not set; refusing all calls');
    return j(503, { error: 'misconfigured' });
  }
  const provided = req.headers.get('x-push-secret') || '';
  if (!constantTimeEqual(provided, TRIGGER_SECRET)) {
    return j(401, { error: 'unauthorized' });
  }

  let body: unknown;
  try { body = await req.json(); }
  catch { return j(400, { error: 'invalid-json' }); }

  const { user_id, payload: rawPayload } =
    (body && typeof body === 'object') ? (body as Record<string, unknown>) : {};

  if (!isUuid(user_id)) return j(400, { error: 'invalid-user_id' });
  const payload = sanitizePayload(rawPayload);
  if (!payload) return j(400, { error: 'invalid-payload' });

  const { data: subs, error } = await supabase
    .from('push_subscriptions')
    .select('id, platform, endpoint, p256dh, auth, apn_token, fcm_token')
    .eq('user_id', user_id);
  if (error) return j(500, { error: 'subscriptions-fetch-failed', detail: error.message });
  if (!subs || !subs.length) return j(200, { ok: true, sent: 0 });

  const results = await Promise.allSettled(
    (subs as SubRow[]).map(s => _deliver(s, payload))
  );

  // Tally + clean up dead subscriptions.
  let sent    = 0;
  let cleaned = 0;
  let failed  = 0;
  for (let i = 0; i < results.length; i++) {
    const r   = results[i];
    const sub = subs[i] as SubRow;
    if (r.status === 'rejected') {
      failed++;
      console.warn('[send-push] delivery threw:', sub.platform, r.reason);
      continue;
    }
    const { ok, status, reason } = r.value;
    if (ok) { sent++; continue; }
    failed++;
    if (_shouldDrop(sub.platform, status, reason)) {
      await supabase.from('push_subscriptions').delete().eq('id', sub.id);
      cleaned++;
    } else if (reason !== 'apn-skipped' && reason !== 'fcm-not-configured') {
      console.warn('[send-push] delivery failed:', sub.platform, status, reason);
    }
  }

  return j(200, { ok: true, sent, failed, cleaned, total: subs.length });
});
