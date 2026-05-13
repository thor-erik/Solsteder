-- 010-push-subscriptions.sql
--
-- Web push subscription registry. Each row is one browser/device the
-- user has opted in to receive push notifications on. Multi-device is
-- allowed: a user can have several rows (laptop Chrome + phone PWA).
--
-- The endpoint is the URL the browser's push service expects POSTs to.
-- p256dh + auth are the encryption keys returned alongside the
-- subscription; the edge function uses them to sign the payload.
--
-- Lifecycle: client INSERT/UPSERT on permission grant (js/push.js
-- _savePushSubscription), DELETE on toggle-off (pushDisable). The
-- server-side sender deletes rows that return 410 Gone from the push
-- service (browser uninstalled, subscription revoked).

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  endpoint   text NOT NULL UNIQUE,
  p256dh     text NOT NULL,
  auth       text NOT NULL,
  user_agent text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(user_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Users manage their own subscription rows.
CREATE POLICY "Users manage own push subscriptions" ON push_subscriptions
  FOR ALL USING (auth.uid() = user_id);

-- Service role bypass is automatic; the edge function uses the service
-- role to read ALL subscriptions when fanning out a push.

-- ─── Delivery scaffolding (deploy separately) ────────────────────────────
--
-- The actual push send lives in a Supabase Edge Function so that the
-- VAPID private key never reaches the browser. Two parts to deploy
-- after running this migration:
--
-- 1) Generate VAPID keys (one-time, on your dev machine):
--      npx web-push generate-vapid-keys
--    Public key  -> paste into js/push.js  VAPID_PUBLIC_KEY
--    Private key -> supabase secrets set VAPID_PRIVATE_KEY=...
--                   supabase secrets set VAPID_SUBJECT=mailto:you@example.com
--
-- 2) Edge function (supabase/functions/send-push/index.ts):
--
--    import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
--    import webpush from 'npm:web-push@3.6.7';
--    import { createClient } from 'npm:@supabase/supabase-js@2';
--
--    const supabase = createClient(
--      Deno.env.get('SUPABASE_URL')!,
--      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
--    );
--    webpush.setVapidDetails(
--      Deno.env.get('VAPID_SUBJECT')!,
--      Deno.env.get('VAPID_PUBLIC_KEY')!,
--      Deno.env.get('VAPID_PRIVATE_KEY')!,
--    );
--
--    serve(async (req) => {
--      const { user_id, payload } = await req.json();
--      const { data: subs } = await supabase
--        .from('push_subscriptions')
--        .select('endpoint, p256dh, auth')
--        .eq('user_id', user_id);
--      const results = await Promise.allSettled((subs || []).map(s =>
--        webpush.sendNotification(
--          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
--          JSON.stringify(payload),
--        )
--      ));
--      // 410 = subscription gone; clean it up so we don't keep trying.
--      for (let i = 0; i < results.length; i++) {
--        const r = results[i];
--        if (r.status === 'rejected' && r.reason?.statusCode === 410) {
--          await supabase.from('push_subscriptions').delete().eq('endpoint', subs[i].endpoint);
--        }
--      }
--      return new Response(JSON.stringify({ ok: true, sent: results.length }));
--    });
--
--    Deploy:
--      supabase functions deploy send-push --no-verify-jwt
--
-- 3) Database trigger that calls the function on social events:
--
--    CREATE OR REPLACE FUNCTION public.notify_invite_response()
--    RETURNS trigger AS $$
--    DECLARE
--      creator_id uuid;
--      venue_id   text;
--      title text; body text;
--    BEGIN
--      IF NEW.status NOT IN ('accepted','declined') THEN RETURN NEW; END IF;
--      IF NEW.status = OLD.status THEN RETURN NEW; END IF;
--      SELECT p.creator_id, p.venue_id INTO creator_id, venue_id
--        FROM plans p WHERE p.id = NEW.plan_id;
--      title := 'Shades';
--      body  := CASE NEW.status WHEN 'accepted' THEN 'Someone said yes to your plan'
--                                ELSE 'Someone can''t make it' END;
--      PERFORM net.http_post(
--        url     := current_setting('app.send_push_url', true),
--        headers := jsonb_build_object('Content-Type','application/json',
--                                      'Authorization','Bearer '||current_setting('app.send_push_anon_key', true)),
--        body    := jsonb_build_object('user_id', creator_id,
--                                       'payload', jsonb_build_object('title', title, 'body', body, 'url', '/'))::text
--      );
--      RETURN NEW;
--    END;
--    $$ LANGUAGE plpgsql SECURITY DEFINER;
--
--    CREATE TRIGGER trg_invite_response_push
--      AFTER UPDATE ON plan_invites
--      FOR EACH ROW EXECUTE FUNCTION notify_invite_response();
--
--    (Requires the pg_net extension: `create extension if not exists pg_net;`
--     and ALTER DATABASE settings for `app.send_push_url` /
--     `app.send_push_anon_key`. You can also call the function directly
--     from the client after the action — simpler, but trades server-side
--     reliability for client-side convenience.)
--
-- For a friend-request push, add an analogous trigger on `friendships`
-- AFTER INSERT WHERE status='pending'.
