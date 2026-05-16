-- 024-plan-venue-name-denorm.sql — denormalize venue_name onto plans so
-- the push-notification trigger can build a body that includes the
-- venue. Without this, the push payload says "Malene har invitert deg
-- til en plan" because venues live in venues.json (client-side), not in
-- the DB — the SQL trigger has no way to look up a venue name from a
-- venue_id alone.
--
-- Trade-off: a denormalized copy of venue.name on every plan row. If a
-- venue is ever renamed in venues.json, existing plan rows keep the
-- old name (which is fine — historical record).
--
-- Both triggers from migration 022 are rewritten to use venue_name:
--   1. notif_on_plan_invite_created — writes the persisted bell-inbox
--      row. Body now reads "<X> har invitert deg til <venue> <when>."
--      Still gets client-side enrichment too (auth.js _renderBellDropdown)
--      because the client formats the date in user-friendly relative
--      phrasing ("i morgen kl 04:40") that's awkward to localize in SQL.
--      Trigger fallback uses absolute date format.
--   2. notify_plan_invite_created — fires the push payload. Body reads
--      "<X> har invitert deg til <venue> <when>" using the same date
--      logic. This is the OS-rendered notification, so server-side
--      formatting is the only option.
--
-- Date formatting uses Europe/Oslo timezone and a small CASE for the
-- common today/tomorrow/yesterday phrasing. Other dates fall back to
-- DD.MM. Norwegian month names would require lc_time tweaking; using
-- numeric date keeps it locale-independent.
--
-- Idempotent.

ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS venue_name TEXT;

-- ─── Bell-inbox notification trigger ────────────────────────────────
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
  v_when         TEXT;
  v_today_oslo   DATE;
  v_plan_date    DATE;
  v_time_oslo    TEXT;
BEGIN
  IF NEW.status != 'pending' THEN RETURN NEW; END IF;

  SELECT * INTO p FROM public.plans WHERE id = NEW.plan_id;
  IF p IS NULL THEN RETURN NEW; END IF;

  v_creator_name := public.notif_user_name(p.creator_id);
  v_venue        := COALESCE(p.venue_name, 'et sted');

  v_today_oslo := (now()        AT TIME ZONE 'Europe/Oslo')::date;
  v_plan_date  := (p.planned_at AT TIME ZONE 'Europe/Oslo')::date;
  v_time_oslo  := to_char(p.planned_at AT TIME ZONE 'Europe/Oslo', 'HH24:MI');

  v_when := CASE
    WHEN v_plan_date = v_today_oslo     THEN 'i dag kl. '     || v_time_oslo
    WHEN v_plan_date = v_today_oslo + 1 THEN 'i morgen kl. '  || v_time_oslo
    WHEN v_plan_date = v_today_oslo - 1 THEN 'i går kl. '     || v_time_oslo
    ELSE to_char(p.planned_at AT TIME ZONE 'Europe/Oslo', 'DD.MM') || ' kl. ' || v_time_oslo
  END;

  INSERT INTO public.notifications (user_id, notif_id, category, body, lead, nav)
  VALUES (
    NEW.user_id,
    'plan_invite_pending:' || NEW.id,
    'social',
    '<strong>' || v_creator_name || '</strong> har invitert deg til <strong>' || v_venue || '</strong> ' || v_when || '.',
    jsonb_build_object('type', 'avatar', 'name', v_creator_name, 'count', 0),
    jsonb_build_object('kind', 'plan', 'venueId', p.venue_id, 'plannedAt', p.planned_at)
  )
  ON CONFLICT (user_id, notif_id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- ─── Push notification trigger ──────────────────────────────────────
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
  v_when         TEXT;
  v_today_oslo   DATE;
  v_plan_date    DATE;
  v_time_oslo    TEXT;
  v_payload      jsonb;
BEGIN
  IF NEW.status != 'pending' THEN RETURN NEW; END IF;

  SELECT * INTO p FROM public.plans WHERE id = NEW.plan_id;
  IF p IS NULL THEN RETURN NEW; END IF;

  SELECT COALESCE(prof.name, split_part(prof.email, '@', 1), 'Noen')
    INTO v_creator
    FROM public.profiles prof
   WHERE prof.id = p.creator_id;

  v_venue := COALESCE(p.venue_name, 'et sted');

  v_today_oslo := (now()        AT TIME ZONE 'Europe/Oslo')::date;
  v_plan_date  := (p.planned_at AT TIME ZONE 'Europe/Oslo')::date;
  v_time_oslo  := to_char(p.planned_at AT TIME ZONE 'Europe/Oslo', 'HH24:MI');

  v_when := CASE
    WHEN v_plan_date = v_today_oslo     THEN 'i dag kl. '     || v_time_oslo
    WHEN v_plan_date = v_today_oslo + 1 THEN 'i morgen kl. '  || v_time_oslo
    WHEN v_plan_date = v_today_oslo - 1 THEN 'i går kl. '     || v_time_oslo
    ELSE to_char(p.planned_at AT TIME ZONE 'Europe/Oslo', 'DD.MM') || ' kl. ' || v_time_oslo
  END;

  v_payload := jsonb_build_object(
    'user_id', NEW.user_id,
    'payload', jsonb_build_object(
      'title', 'Shades',
      'body',  v_creator || ' har invitert deg til ' || v_venue || ' ' || v_when,
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

-- Force PostgREST schema cache reload so the new column shows up in
-- the auto-generated API immediately.
NOTIFY pgrst, 'reload schema';
