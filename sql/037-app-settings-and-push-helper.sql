-- 037-app-settings-and-push-helper.sql — eliminate the inlined anon-bearer
-- pattern in push-firing triggers and add a shared-secret gate for the
-- send-push edge function.
--
-- Background. The original sql/011-push-triggers.sql inlined the Supabase URL
-- and anon-role Bearer JWT directly into a `net.http_post` block, because the
-- hosted SQL editor lacks permission for `ALTER DATABASE ... SET app.xxx`.
-- Subsequent migrations (019, 022, 024, 026, 027, 029, 030, 032) each
-- rewrote one or more trigger functions and re-inlined the same JWT —
-- nine SQL files now carry it. CLAUDE.md's rotation instructions point at
-- only sql/011, undercounting by ~9x. A future anon-key rotation that
-- follows the doc will leave most triggers stranded on the old key.
--
-- Worse: the send-push edge function is deployed `--no-verify-jwt` and
-- accepts arbitrary { user_id, payload } from anyone, so the anon Bearer
-- is doing no work as an auth check (see also sql/035 sibling and the
-- C1 fix in the edge function rewrite). The Bearer is only there because
-- Supabase Function Gateway requires *some* authorization header.
--
-- This migration replaces all of that with three pieces:
--
-- 1. public._app_settings — a tiny key/value table for runtime config the
--    triggers need (send-push URL, current Bearer, shared trigger secret).
--    RLS denies all access from anon/authenticated; only postgres /
--    service_role / SECURITY DEFINER helpers can read it.
--
-- 2. public._do_send_push(target_user uuid, payload jsonb) — SECURITY DEFINER
--    helper that wraps the http_post. Reads the URL, Bearer, and secret
--    from _app_settings on every call. To rotate any of these, UPDATE the
--    corresponding row — no trigger rewrites needed.
--
-- 3. The six push-firing trigger functions rewritten to call _do_send_push
--    instead of inlining the http_post:
--      * notify_friend_request          (last touched: sql/011)
--      * notify_friend_accepted         (last touched: sql/019)
--      * notify_plan_invite_created     (last touched: sql/032)
--      * notify_invite_response         (last touched: sql/032)
--      * notify_plan_cancelled          (last touched: sql/032)
--      * process_plan_reminders         (last touched: sql/032)
--    Function bodies preserved exactly except the http_post block.
--
-- ── Apply order (READ THIS BEFORE RUNNING) ─────────────────────────────────
-- Step 1. Apply this migration. _app_settings is seeded with the current
--         anon JWT in 'send_push_bearer' so existing pushes keep working.
--         A fresh random uuid is generated for 'send_push_secret'.
-- Step 2. Read the generated secret:
--           SELECT value FROM public._app_settings WHERE key='send_push_secret';
-- Step 3. Make it available to the edge function:
--           supabase secrets set PUSH_TRIGGER_SECRET=<value-from-step-2>
-- Step 4. Deploy the new send-push edge function (see
--         supabase/functions/send-push/index.ts). The function now requires
--         the X-Push-Secret header to match PUSH_TRIGGER_SECRET; the
--         triggers send it from _app_settings. Anonymous callers without the
--         secret get 401.
-- Step 5. Verify a real social action fires a push (e.g. send a friend
--         request to a test user and watch send-push logs).
--
-- Rotating later: UPDATE the row in _app_settings + update the matching
-- Supabase secret (PUSH_TRIGGER_SECRET for the secret; redeploy is not
-- required since the function reads it on cold start — but in practice a
-- redeploy is the cleanest way to pick it up).
--
-- Idempotent.

-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║ 1. Settings table                                                      ║
-- ╚════════════════════════════════════════════════════════════════════════╝
CREATE TABLE IF NOT EXISTS public._app_settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- RLS: deny everything from anon/authenticated. Only the postgres /
-- service_role and SECURITY DEFINER functions (which bypass RLS) can read.
ALTER TABLE public._app_settings ENABLE ROW LEVEL SECURITY;
-- No policies created — empty policy set + RLS-on = deny-all for non-bypass
-- roles. (service_role bypasses RLS automatically.)

REVOKE ALL ON TABLE public._app_settings FROM PUBLIC, anon, authenticated;

-- Seed required keys. Values use ON CONFLICT DO NOTHING so re-running this
-- migration doesn't clobber rotated values.
INSERT INTO public._app_settings (key, value) VALUES
  ('send_push_url',    'https://wxalqodaeqgzahwlovnw.supabase.co/functions/v1/send-push')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public._app_settings (key, value) VALUES
  ('send_push_bearer', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind4YWxxb2RhZXFnemFod2xvdm53Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxODcyNDYsImV4cCI6MjA5MTc2MzI0Nn0.RzP2Fsft1yqTt7Hg-u2t1UnGLE7FvFBoG88mKstUJgo')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public._app_settings (key, value) VALUES
  ('send_push_secret', encode(gen_random_bytes(32), 'hex'))
ON CONFLICT (key) DO NOTHING;

-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║ 2. _do_send_push helper                                                ║
-- ╚════════════════════════════════════════════════════════════════════════╝
CREATE OR REPLACE FUNCTION public._do_send_push(target_user uuid, payload jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_url    text;
  v_bearer text;
  v_secret text;
BEGIN
  IF target_user IS NULL OR payload IS NULL THEN RETURN; END IF;

  SELECT value INTO v_url    FROM public._app_settings WHERE key = 'send_push_url';
  SELECT value INTO v_bearer FROM public._app_settings WHERE key = 'send_push_bearer';
  SELECT value INTO v_secret FROM public._app_settings WHERE key = 'send_push_secret';

  IF v_url IS NULL OR v_bearer IS NULL OR v_secret IS NULL THEN
    RAISE WARNING '_do_send_push: missing app_settings rows; push skipped for user %', target_user;
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type',   'application/json',
      'Authorization',  'Bearer ' || v_bearer,
      -- Read by the edge function (Deno.env.get('PUSH_TRIGGER_SECRET'))
      -- and compared in constant time. Anonymous callers without this
      -- header get 401.
      'X-Push-Secret',  v_secret
    ),
    body := jsonb_build_object('user_id', target_user, 'payload', payload)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public._do_send_push(uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║ 3. Rewrite the six push-firing trigger functions                       ║
-- ║    Bodies preserved exactly except for the http_post → _do_send_push   ║
-- ║    swap. Latest version of each is the baseline (see header comment).  ║
-- ╚════════════════════════════════════════════════════════════════════════╝

-- ── notify_friend_request (baseline: sql/011) ──────────────────────────────
CREATE OR REPLACE FUNCTION public.notify_friend_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_requester text;
BEGIN
  IF NEW.status <> 'pending' THEN RETURN NEW; END IF;
  IF NEW.user_id = NEW.friend_id THEN RETURN NEW; END IF;

  SELECT COALESCE(prof.name, split_part(prof.email, '@', 1), 'Someone')
    INTO v_requester
    FROM public.profiles prof
   WHERE prof.id = NEW.user_id;

  PERFORM public._do_send_push(
    NEW.friend_id,
    jsonb_build_object(
      'title', 'Shades',
      'body',  v_requester || ' wants to be your friend',
      'url',   '/',
      'tag',   'social_friend_request_' || NEW.id::text
    )
  );
  RETURN NEW;
END;
$$;

-- ── notify_friend_accepted (baseline: sql/019) ─────────────────────────────
CREATE OR REPLACE FUNCTION public.notify_friend_accepted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_acceptor text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status != 'accepted' THEN RETURN NEW; END IF;
    IF OLD.status = 'accepted' THEN RETURN NEW; END IF;
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.status != 'accepted' THEN RETURN NEW; END IF;
  END IF;
  IF NEW.user_id = NEW.friend_id THEN RETURN NEW; END IF;

  SELECT COALESCE(prof.name, split_part(prof.email, '@', 1), 'Someone')
    INTO v_acceptor
    FROM public.profiles prof
   WHERE prof.id = NEW.friend_id;

  PERFORM public._do_send_push(
    NEW.user_id,
    jsonb_build_object(
      'title', 'Shades',
      'body',  'Du og ' || v_acceptor || ' er nå venner.',
      'url',   '/',
      'tag',   'social_friend_accepted_' || NEW.id::text
    )
  );
  RETURN NEW;
END;
$$;

-- ── notify_plan_invite_created (baseline: sql/032) ─────────────────────────
CREATE OR REPLACE FUNCTION public.notify_plan_invite_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  p          public.plans%ROWTYPE;
  v_creator  TEXT;
  v_venue    TEXT;
  v_deeplink TEXT;
BEGIN
  IF NEW.status != 'pending' THEN RETURN NEW; END IF;
  SELECT * INTO p FROM public.plans WHERE id = NEW.plan_id;
  IF p IS NULL THEN RETURN NEW; END IF;

  SELECT COALESCE(prof.name, split_part(prof.email, '@', 1), 'Noen')
    INTO v_creator FROM public.profiles prof WHERE prof.id = p.creator_id;
  v_venue := COALESCE(p.venue_name, 'et sted');

  v_deeplink := '/?nav=plan&v=' || p.venue_id
              || '&t=' || to_char(p.planned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

  PERFORM public._do_send_push(
    NEW.user_id,
    jsonb_build_object(
      'title', 'Shades',
      'body',  v_creator || ' har invitert deg til ' || v_venue || ' ' || public.notif_when_label(p.planned_at),
      'url',   v_deeplink,
      'tag',   'social_plan_invite_' || NEW.id::text
    )
  );
  RETURN NEW;
END;
$$;

-- ── notify_invite_response (baseline: sql/032) ─────────────────────────────
CREATE OR REPLACE FUNCTION public.notify_invite_response()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_creator_id   uuid;
  v_responder    text;
  v_venue        text;
  v_venue_id     text;
  v_planned_at   timestamptz;
  v_total        int;
  v_extra        int;
  v_tail         text;
  v_verb         text;
  v_body         text;
  v_deeplink     text;
BEGIN
  IF NEW.status NOT IN ('accepted', 'declined') THEN RETURN NEW; END IF;
  IF (TG_OP = 'UPDATE') AND OLD.status = NEW.status THEN RETURN NEW; END IF;

  SELECT p.creator_id, p.venue_id, p.planned_at, COALESCE(p.venue_name, 'et sted')
    INTO v_creator_id, v_venue_id, v_planned_at, v_venue
    FROM public.plans p WHERE p.id = NEW.plan_id;

  IF v_creator_id IS NULL THEN RETURN NEW; END IF;
  IF v_creator_id = NEW.user_id THEN RETURN NEW; END IF;

  SELECT COALESCE(prof.name, split_part(prof.email, '@', 1), 'Noen')
    INTO v_responder FROM public.profiles prof WHERE prof.id = NEW.user_id;

  SELECT COUNT(*) INTO v_total
    FROM public.plan_invites pi
   WHERE pi.plan_id = NEW.plan_id AND pi.status = NEW.status;
  v_extra := GREATEST(0, v_total - 1);
  v_tail  := CASE WHEN v_extra > 0 THEN ' +' || v_extra::text ELSE '' END;
  v_verb  := CASE NEW.status WHEN 'accepted' THEN 'har godtatt' ELSE 'har avslått' END;
  v_body  := v_responder || v_tail || ' ' || v_verb || ' invitasjonen din til ' || v_venue || ' ' || public.notif_when_label(v_planned_at);

  v_deeplink := '/?nav=plan&v=' || v_venue_id
              || '&t=' || to_char(v_planned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

  PERFORM public._do_send_push(
    v_creator_id,
    jsonb_build_object(
      'title', 'Shades',
      'body',  v_body,
      'url',   v_deeplink,
      'tag',   'social_plan_response_' || NEW.status || '_' || NEW.plan_id::text
    )
  );
  RETURN NEW;
END;
$$;

-- ── notify_plan_cancelled (baseline: sql/032) ──────────────────────────────
CREATE OR REPLACE FUNCTION public.notify_plan_cancelled()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_creator      TEXT;
  v_venue        TEXT;
  v_target_user  uuid;
  v_deeplink     TEXT;
BEGIN
  IF (OLD.cancelled_at IS NOT NULL) THEN RETURN NEW; END IF;
  IF (NEW.cancelled_at IS NULL)     THEN RETURN NEW; END IF;

  SELECT COALESCE(prof.name, split_part(prof.email, '@', 1), 'Noen')
    INTO v_creator FROM public.profiles prof WHERE prof.id = NEW.creator_id;
  v_venue := COALESCE(NEW.venue_name, 'et sted');

  v_deeplink := '/?nav=plan&v=' || NEW.venue_id
              || '&t=' || to_char(NEW.planned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
              || '&cancelled=1';

  FOR v_target_user IN
    SELECT pi.user_id FROM public.plan_invites pi
     WHERE pi.plan_id = NEW.id AND pi.status IN ('pending', 'accepted')
  LOOP
    PERFORM public._do_send_push(
      v_target_user,
      jsonb_build_object(
        'title', 'Shades',
        'body',  v_creator || ' kansellerte planen til ' || v_venue || ' ' || public.notif_when_label(NEW.planned_at),
        'url',   v_deeplink,
        'tag',   'social_plan_cancelled_' || NEW.id::text
      )
    );
  END LOOP;
  RETURN NEW;
END;
$$;

-- ── process_plan_reminders (baseline: sql/032) ─────────────────────────────
CREATE OR REPLACE FUNCTION public.process_plan_reminders()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  p              public.plans%ROWTYPE;
  v_creator_name TEXT;
  v_venue        TEXT;
  v_recip_id     uuid;
  v_status       text;
  v_body         text;
  v_lead_body    text;
  v_deeplink     text;
BEGIN
  FOR p IN
    SELECT *
    FROM public.plans
    WHERE cancelled_at IS NULL
      AND reminder_sent_at IS NULL
      AND planned_at > now() + interval '25 minutes'
      AND planned_at < now() + interval '35 minutes'
  LOOP
    v_creator_name := public.notif_user_name(p.creator_id);
    v_venue        := COALESCE(p.venue_name, 'et sted');
    v_deeplink := '/?nav=plan&v=' || p.venue_id
                || '&t=' || to_char(p.planned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

    -- Creator inbox row
    v_body := 'Planen din på <strong>' || v_venue || '</strong> starter om 30 min.';
    INSERT INTO public.notifications (user_id, notif_id, category, body, lead, nav)
    VALUES (
      p.creator_id,
      'plan_reminder_creator:' || p.id,
      'social',
      v_body,
      jsonb_build_object('type', 'glyph', 'icon', '⏰'),
      jsonb_build_object('kind', 'plan', 'venueId', p.venue_id, 'plannedAt', p.planned_at)
    )
    ON CONFLICT (user_id, notif_id) DO NOTHING;

    PERFORM public._do_send_push(
      p.creator_id,
      jsonb_build_object(
        'title', 'Shades',
        'body',  'Planen din på ' || v_venue || ' starter om 30 min.',
        'url',   v_deeplink,
        'tag',   'plan_reminder_creator_' || p.id::text
      )
    );

    FOR v_recip_id, v_status IN
      SELECT pi.user_id, pi.status
      FROM public.plan_invites pi
      WHERE pi.plan_id = p.id AND pi.status IN ('accepted', 'pending')
    LOOP
      IF v_status = 'accepted' THEN
        v_body := 'Du skal til <strong>' || v_venue || '</strong> om 30 min.';
        v_lead_body := 'Du skal til ' || v_venue || ' om 30 min.';
      ELSE
        v_body := '<strong>' || v_creator_name || '</strong>s plan på <strong>' || v_venue || '</strong> starter om 30 min.';
        v_lead_body := v_creator_name || 's plan på ' || v_venue || ' starter om 30 min.';
      END IF;

      INSERT INTO public.notifications (user_id, notif_id, category, body, lead, nav)
      VALUES (
        v_recip_id,
        'plan_reminder_invitee:' || p.id,
        'social',
        v_body,
        jsonb_build_object('type', 'glyph', 'icon', '⏰'),
        jsonb_build_object('kind', 'plan', 'venueId', p.venue_id, 'plannedAt', p.planned_at)
      )
      ON CONFLICT (user_id, notif_id) DO NOTHING;

      PERFORM public._do_send_push(
        v_recip_id,
        jsonb_build_object(
          'title', 'Shades',
          'body',  v_lead_body,
          'url',   v_deeplink,
          'tag',   'plan_reminder_invitee_' || p.id::text
        )
      );
    END LOOP;

    UPDATE public.plans SET reminder_sent_at = now() WHERE id = p.id;
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.notify_friend_request()        FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_friend_accepted()       FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_plan_invite_created()   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_invite_response()       FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_plan_cancelled()        FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.process_plan_reminders()       FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
