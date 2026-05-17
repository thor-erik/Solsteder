-- 030-notif-day-label-weekday.sql — extend server-rendered notification
-- date phrasing to match the client's _dayLabel:
--
--   today           → "i dag"
--   tomorrow        → "i morgen"
--   yesterday       → "i går"
--   2..7 days out   → weekday name (tirsdag, onsdag, …)  ← NEW
--   -6..-2 days     → weekday name                       ← NEW
--   else            → "DD.MM"
--
-- The same rule the top-bar date picker uses for the visible date
-- ("Onsdag" vs "15. mai"). Now the inbox row, push body, and toast
-- copy share that vocabulary.
--
-- Helpers:
--   public.notif_day_label(timestamptz) — bare day phrase
--   public.notif_when_label(timestamptz) — day phrase + " kl. HH:MM"
--
-- Locale: Norwegian weekday names hardcoded via EXTRACT(dow) +
-- CASE. Postgres's to_char(d, 'TMDay') would localize via lc_time,
-- but Supabase's default lc_time is en_US.UTF-8 so we'd get "Tuesday"
-- not "tirsdag" — easier to ship the table than to flip DB config.
-- When the app gets en/se/dk i18n on the server side, refactor to
-- accept a locale arg or branch on locale in the helper.
--
-- Rewrites every trigger function that previously inlined the date
-- CASE so they delegate to the helper:
--   notif_on_plan_invite_created     (sql/024)
--   notify_plan_invite_created       (sql/024)
--   notif_on_plan_invite_response    (sql/028)
--   notify_invite_response           (sql/027)
--   notif_on_plan_cancelled          (sql/026)
--   notify_plan_cancelled            (sql/026)
--
-- Idempotent.

CREATE OR REPLACE FUNCTION public.notif_day_label(plan_at TIMESTAMPTZ)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_today      DATE;
  v_plan_date  DATE;
  v_days_out   INT;
  v_dow        INT;
BEGIN
  v_today     := (now()     AT TIME ZONE 'Europe/Oslo')::date;
  v_plan_date := (plan_at   AT TIME ZONE 'Europe/Oslo')::date;
  v_days_out  := v_plan_date - v_today;

  IF v_days_out =  0 THEN RETURN 'i dag';    END IF;
  IF v_days_out =  1 THEN RETURN 'i morgen'; END IF;
  IF v_days_out = -1 THEN RETURN 'i går';    END IF;

  IF (v_days_out BETWEEN 2 AND 7)
     OR (v_days_out BETWEEN -6 AND -2) THEN
    v_dow := EXTRACT(dow FROM v_plan_date);
    RETURN CASE v_dow
      WHEN 0 THEN 'søndag'
      WHEN 1 THEN 'mandag'
      WHEN 2 THEN 'tirsdag'
      WHEN 3 THEN 'onsdag'
      WHEN 4 THEN 'torsdag'
      WHEN 5 THEN 'fredag'
      WHEN 6 THEN 'lørdag'
    END;
  END IF;

  RETURN to_char(plan_at AT TIME ZONE 'Europe/Oslo', 'DD.MM');
END;
$$;

CREATE OR REPLACE FUNCTION public.notif_when_label(plan_at TIMESTAMPTZ)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT public.notif_day_label(plan_at)
       || ' kl. '
       || to_char(plan_at AT TIME ZONE 'Europe/Oslo', 'HH24:MI');
$$;

-- ─── Rewrite the six callers to use the helper ──────────────────────

CREATE OR REPLACE FUNCTION public.notif_on_plan_invite_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  p              public.plans%ROWTYPE;
  v_creator_name TEXT;
  v_venue        TEXT;
BEGIN
  IF NEW.status != 'pending' THEN RETURN NEW; END IF;
  SELECT * INTO p FROM public.plans WHERE id = NEW.plan_id;
  IF p IS NULL THEN RETURN NEW; END IF;
  v_creator_name := public.notif_user_name(p.creator_id);
  v_venue        := COALESCE(p.venue_name, 'et sted');

  INSERT INTO public.notifications (user_id, notif_id, category, body, lead, nav)
  VALUES (
    NEW.user_id,
    'plan_invite_pending:' || NEW.id,
    'social',
    '<strong>' || v_creator_name || '</strong> har invitert deg til <strong>' || v_venue || '</strong> ' || public.notif_when_label(p.planned_at) || '.',
    jsonb_build_object('type', 'avatar', 'name', v_creator_name, 'count', 0),
    jsonb_build_object('kind', 'plan', 'venueId', p.venue_id, 'plannedAt', p.planned_at)
  )
  ON CONFLICT (user_id, notif_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_plan_invite_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  p              public.plans%ROWTYPE;
  v_creator      TEXT;
  v_venue        TEXT;
  v_payload      jsonb;
BEGIN
  IF NEW.status != 'pending' THEN RETURN NEW; END IF;
  SELECT * INTO p FROM public.plans WHERE id = NEW.plan_id;
  IF p IS NULL THEN RETURN NEW; END IF;

  SELECT COALESCE(prof.name, split_part(prof.email, '@', 1), 'Noen')
    INTO v_creator FROM public.profiles prof WHERE prof.id = p.creator_id;
  v_venue := COALESCE(p.venue_name, 'et sted');

  v_payload := jsonb_build_object(
    'user_id', NEW.user_id,
    'payload', jsonb_build_object(
      'title', 'Shades',
      'body',  v_creator || ' har invitert deg til ' || v_venue || ' ' || public.notif_when_label(p.planned_at),
      'url',   '/',
      'tag',   'social_plan_invite_' || NEW.id::text
    )
  );
  PERFORM net.http_post(
    url     := 'https://wxalqodaeqgzahwlovnw.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind4YWxxb2RhZXFnemFod2xvdm53Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxODcyNDYsImV4cCI6MjA5MTc2MzI0Nn0.RzP2Fsft1yqTt7Hg-u2t1UnGLE7FvFBoG88mKstUJgo'
    ),
    body    := v_payload
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.notif_on_plan_invite_response()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  p              public.plans%ROWTYPE;
  v_invitee_name TEXT;
  v_venue        TEXT;
  v_total        INT;
  v_extra        INT;
  v_tail         TEXT;
  v_verb         TEXT;
  v_body         TEXT;
BEGIN
  IF NEW.status NOT IN ('accepted', 'declined') THEN RETURN NEW; END IF;
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  SELECT * INTO p FROM public.plans WHERE id = NEW.plan_id;
  IF p IS NULL THEN RETURN NEW; END IF;
  IF p.creator_id = NEW.user_id THEN RETURN NEW; END IF;

  v_invitee_name := public.notif_user_name(NEW.user_id);
  v_venue        := COALESCE(p.venue_name, 'et sted');

  SELECT COUNT(*) INTO v_total
    FROM public.plan_invites pi
   WHERE pi.plan_id = NEW.plan_id AND pi.status = NEW.status;
  v_extra := GREATEST(0, v_total - 1);
  v_tail  := CASE WHEN v_extra > 0 THEN ' +' || v_extra::text ELSE '' END;
  v_verb  := CASE NEW.status WHEN 'accepted' THEN 'har godtatt' ELSE 'har avslått' END;
  v_body  := '<strong>' || v_invitee_name || '</strong>' || v_tail
             || ' ' || v_verb || ' invitasjonen din til <strong>' || v_venue
             || '</strong> ' || public.notif_when_label(p.planned_at) || '.';

  INSERT INTO public.notifications (user_id, notif_id, category, body, lead, nav)
  VALUES (
    p.creator_id,
    'social_invite_' || NEW.status || '_' || NEW.plan_id::text,
    'social',
    v_body,
    jsonb_build_object('type', 'avatar', 'name', v_invitee_name, 'count', 0),
    jsonb_build_object('kind', 'plan', 'venueId', p.venue_id, 'plannedAt', p.planned_at)
  )
  ON CONFLICT (user_id, notif_id) DO UPDATE
    SET body = EXCLUDED.body, lead = EXCLUDED.lead, nav = EXCLUDED.nav, read_at = NULL;
  RETURN NEW;
END;
$$;

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
  v_planned_at   timestamptz;
  v_total        int;
  v_extra        int;
  v_tail         text;
  v_verb         text;
  v_body         text;
  v_payload      jsonb;
BEGIN
  IF NEW.status NOT IN ('accepted', 'declined') THEN RETURN NEW; END IF;
  IF (TG_OP = 'UPDATE') AND OLD.status = NEW.status THEN RETURN NEW; END IF;

  SELECT p.creator_id, p.planned_at, COALESCE(p.venue_name, 'et sted')
    INTO v_creator_id, v_planned_at, v_venue
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

  v_payload := jsonb_build_object(
    'user_id', v_creator_id,
    'payload', jsonb_build_object(
      'title', 'Shades',
      'body',  v_body,
      'url',   '/',
      'tag',   'social_plan_response_' || NEW.status || '_' || NEW.plan_id::text
    )
  );
  PERFORM net.http_post(
    url     := 'https://wxalqodaeqgzahwlovnw.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind4YWxxb2RhZXFnemFod2xvdm53Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxODcyNDYsImV4cCI6MjA5MTc2MzI0Nn0.RzP2Fsft1yqTt7Hg-u2t1UnGLE7FvFBoG88mKstUJgo'
    ),
    body    := v_payload
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.notif_on_plan_cancelled()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_creator_name TEXT;
  v_venue        TEXT;
BEGIN
  IF (OLD.cancelled_at IS NOT NULL) THEN RETURN NEW; END IF;
  IF (NEW.cancelled_at IS NULL)     THEN RETURN NEW; END IF;

  v_creator_name := public.notif_user_name(NEW.creator_id);
  v_venue        := COALESCE(NEW.venue_name, 'et sted');

  INSERT INTO public.notifications (user_id, notif_id, category, body, lead, nav)
  SELECT
    pi.user_id,
    'plan_cancelled:' || NEW.id,
    'social',
    '<strong>' || v_creator_name || '</strong> kansellerte planen til <strong>' || v_venue || '</strong> ' || public.notif_when_label(NEW.planned_at) || '.',
    jsonb_build_object('type', 'avatar', 'name', v_creator_name, 'count', 0),
    jsonb_build_object('kind', 'plan', 'venueId', NEW.venue_id, 'plannedAt', NEW.planned_at, 'cancelled', true)
  FROM public.plan_invites pi
  WHERE pi.plan_id = NEW.id AND pi.status IN ('pending', 'accepted')
  ON CONFLICT (user_id, notif_id) DO NOTHING;
  RETURN NEW;
END;
$$;

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
  v_payload      jsonb;
BEGIN
  IF (OLD.cancelled_at IS NOT NULL) THEN RETURN NEW; END IF;
  IF (NEW.cancelled_at IS NULL)     THEN RETURN NEW; END IF;

  SELECT COALESCE(prof.name, split_part(prof.email, '@', 1), 'Noen')
    INTO v_creator FROM public.profiles prof WHERE prof.id = NEW.creator_id;
  v_venue := COALESCE(NEW.venue_name, 'et sted');

  FOR v_target_user IN
    SELECT pi.user_id FROM public.plan_invites pi
     WHERE pi.plan_id = NEW.id AND pi.status IN ('pending', 'accepted')
  LOOP
    v_payload := jsonb_build_object(
      'user_id', v_target_user,
      'payload', jsonb_build_object(
        'title', 'Shades',
        'body',  v_creator || ' kansellerte planen til ' || v_venue || ' ' || public.notif_when_label(NEW.planned_at),
        'url',   '/',
        'tag',   'social_plan_cancelled_' || NEW.id::text
      )
    );
    PERFORM net.http_post(
      url     := 'https://wxalqodaeqgzahwlovnw.supabase.co/functions/v1/send-push',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind4YWxxb2RhZXFnemFod2xvdm53Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxODcyNDYsImV4cCI6MjA5MTc2MzI0Nn0.RzP2Fsft1yqTt7Hg-u2t1UnGLE7FvFBoG88mKstUJgo'
      ),
      body    := v_payload
    );
  END LOOP;
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
