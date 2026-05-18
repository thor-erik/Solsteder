// supabase/functions/send-push/index.ts
//
// Web push fan-out for Shades. Called from database triggers that read a
// shared secret from public._app_settings and forward it as X-Push-Secret.
//
// ── Auth model ──────────────────────────────────────────────────────────────
// The function is deployed `--no-verify-jwt` because the DB triggers fire as
// SECURITY DEFINER and don't sign requests with a real user JWT. Instead, the
// function authenticates the caller via the X-Push-Secret header (compared in
// constant time to the PUSH_TRIGGER_SECRET env var). Anonymous callers
// without the secret get 401 and the function never touches push_subscriptions.
//
// This closes the prior gap where the function (`--no-verify-jwt`, no
// internal auth, CORS *) accepted `{user_id, payload}` from anyone and
// would fan-out arbitrary push notifications to any user. See sql/037 for
// the trigger-side rewrite that introduced the secret.
//
// ── Payload validation ──────────────────────────────────────────────────────
// All caller-supplied fields are validated and capped:
//   * user_id     — must be a UUID
//   * payload.url — must be a same-origin path ('/...'); no protocol-relative
//                   '//evil.com', no full https://, no header-injection chars.
//                   This stops the SW from openWindow()'ing an external URL on
//                   notification click — even though the secret gate already
//                   blocks unauthorized callers, defense in depth.
//   * title/body/tag — capped to sensible lengths; body is the user-visible
//                   notification text so length matters for OS-level truncation.
//
// ── Deploy ──────────────────────────────────────────────────────────────────
//   supabase secrets set PUSH_TRIGGER_SECRET=<value-from-_app_settings>
//   supabase functions deploy send-push --no-verify-jwt
//
// Required env (set by Supabase automatically):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
// Required secrets (set manually via `supabase secrets set`):
//   VAPID_PUBLIC_KEY        — same value as VAPID_PUBLIC_KEY in js/push.js
//   VAPID_PRIVATE_KEY       — server-side only
//   VAPID_SUBJECT           — e.g. mailto:contact@findshades.app
//   PUSH_TRIGGER_SECRET     — matches public._app_settings WHERE key='send_push_secret'

import { serve }        from 'https://deno.land/std@0.224.0/http/server.ts';
import webpush          from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

webpush.setVapidDetails(
  Deno.env.get('VAPID_SUBJECT')!,
  Deno.env.get('VAPID_PUBLIC_KEY')!,
  Deno.env.get('VAPID_PRIVATE_KEY')!,
);

const TRIGGER_SECRET = Deno.env.get('PUSH_TRIGGER_SECRET') || '';

// Caps on caller-supplied fields. Anything over these is either an abuse
// attempt or a trigger-side bug — return 400 rather than push it.
const MAX_TITLE_LEN = 80;
const MAX_BODY_LEN  = 500;
const MAX_URL_LEN   = 1024;
const MAX_TAG_LEN   = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CORS = {
  // Browsers don't legitimately call this function — DB triggers do.
  // Leaving '*' for one-off testing convenience; the secret gate is the
  // actual auth boundary, not CORS.
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

// Restrict click-targets to same-origin paths. Triggers pass things like
// '/?nav=plan&v=…' — root-relative paths only. This stops the SW from
// openWindow()'ing arbitrary external URLs on notification tap (a phishing
// vector the secret gate already mitigates, kept here as defense in depth).
function sanitizeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > MAX_URL_LEN) return null;
  if (!raw.startsWith('/')) return null;
  if (raw.startsWith('//')) return null;             // protocol-relative '//evil.com'
  if (/[\r\n\0]/.test(raw)) return null;             // header / control char injection
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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }
  if (req.method !== 'POST') {
    return j(405, { error: 'method-not-allowed' });
  }

  // Fail closed if the secret isn't configured. Better to drop all pushes
  // and surface the misconfig than to silently accept anonymous calls.
  if (!TRIGGER_SECRET) {
    console.error('[send-push] PUSH_TRIGGER_SECRET not set; refusing all calls');
    return j(503, { error: 'misconfigured' });
  }

  // Authenticate the caller. Triggers read the secret from
  // public._app_settings.value WHERE key='send_push_secret' and pass it here.
  // Anonymous callers (or callers with a stale secret) get 401.
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
    .select('endpoint, p256dh, auth')
    .eq('user_id', user_id);
  if (error) return j(500, { error: 'subscriptions-fetch-failed', detail: error.message });
  if (!subs || !subs.length) return j(200, { ok: true, sent: 0 });

  const results = await Promise.allSettled(subs.map(s =>
    webpush.sendNotification(
      { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
      JSON.stringify(payload),
    )
  ));

  // Drop subscriptions the push service has declared dead so we stop
  // hammering revoked endpoints.
  let cleaned = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'rejected') {
      const reason = r.reason as { statusCode?: number; status?: number; message?: string };
      const code = reason?.statusCode || reason?.status || 0;
      if (code === 410 || code === 404) {
        await supabase.from('push_subscriptions').delete().eq('endpoint', subs[i].endpoint);
        cleaned++;
      } else {
        console.warn('[send-push] delivery failed:', reason?.message || reason);
      }
    }
  }
  const sent = results.filter(r => r.status === 'fulfilled').length;
  return j(200, { ok: true, sent, cleaned, total: subs.length });
});
