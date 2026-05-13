// supabase/functions/send-push/index.ts
//
// Web push fan-out for Shades. Called from a database trigger on
// plan_invites status changes and friendships inserts; can also be
// invoked directly from the client (or from another edge function).
//
// Deploy:
//   supabase functions deploy send-push --no-verify-jwt
//
// Required secrets (supabase secrets set ...):
//   VAPID_PUBLIC_KEY   — same value as VAPID_PUBLIC_KEY in js/push.js
//   VAPID_PRIVATE_KEY  — keep server-side only
//   VAPID_SUBJECT      — e.g. mailto:contact@findshades.app
//
// Required env (set by Supabase automatically inside edge functions):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Request body:
//   {
//     "user_id": "uuid",
//     "payload": {
//       "title": "Shades",
//       "body":  "Maja said yes to Vinland",
//       "url":   "/",
//       "tag"?:  "social_invite_accepted_<plan_id>",
//       "icon"?: "/favicon-192.png"
//     }
//   }
//
// Response: { ok: true, sent: N }
//
// On a 410 Gone from the push service, the corresponding row in
// push_subscriptions is deleted so we don't keep trying.

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

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method-not-allowed' }), {
      status: 405, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  let body;
  try { body = await req.json(); }
  catch { return j(400, { error: 'invalid-json' }); }

  const { user_id, payload } = body || {};
  if (!user_id || !payload) return j(400, { error: 'missing-fields' });

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

  // Clean up dead subscriptions so we stop pushing to revoked endpoints.
  let cleaned = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'rejected') {
      const code = (r.reason && (r.reason.statusCode || r.reason.status)) || 0;
      if (code === 410 || code === 404) {
        await supabase.from('push_subscriptions').delete().eq('endpoint', subs[i].endpoint);
        cleaned++;
      } else {
        console.warn('[send-push] delivery failed:', r.reason?.message || r.reason);
      }
    }
  }
  const sent = results.filter(r => r.status === 'fulfilled').length;
  return j(200, { ok: true, sent, cleaned, total: subs.length });
});

function j(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
