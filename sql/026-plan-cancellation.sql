-- 026-plan-cancellation.sql — soft-cancel a plan + notify invitees.
--
-- Adds plans.cancelled_at (TIMESTAMPTZ, nullable). Non-null means the
-- creator has called off the plan. The row stays in the table so the
-- invitees can still load it for context, but it's filtered out of
-- active-plan lists at the client layer.
--
-- Two triggers fire on the cancel transition (NULL → non-NULL):
--   1. notif_on_plan_cancelled: writes a notifications row for each
--      invitee, body "<creator> kansellerte planen til <venue> <when>."
--      That makes the bell-inbox row show up; CTA opens the
--      plan-preview in its (new) cancelled state.
--   2. notify_plan_cancelled: fires the push payload using the same
--      body, tagged 'social_plan_cancelled_<plan_id>' so a duplicate
--      cancellation push doesn't pile up.
--
-- RLS for cancel: only the creator can SET cancelled_at. The existing
-- "Creator and invitees see plans" SELECT policy already lets invitees
-- read the cancelled row. Add a new UPDATE policy specifically for the
-- creator's cancel action.
--
-- Idempotent.

ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

-- Creator can update their own plan (already exists implicitly via
-- "Users create plans" INSERT policy + the lack of an UPDATE policy
-- would block it). Add a permissive UPDATE policy so the cancel
-- happens via a normal client UPDATE.
DROP POLICY IF EXISTS "Creator updates own plan" ON public.plans;
CREATE POLICY "Creator updates own plan" ON public.plans
  FOR UPDATE
  USING ((SELECT auth.uid()) = creator_id)
  WITH CHECK ((SELECT auth.uid()) = creator_id);

-- ─── Bell-inbox notification on cancel ──────────────────────────────
CREATE OR REPLACE FUNCTION public.notif_on_plan_cancelled()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_creator_name TEXT;
  v_venue        TEXT;
  v_when         TEXT;
  v_today_oslo   DATE;
  v_plan_date    DATE;
  v_time_oslo    TEXT;
BEGIN
  -- Only fire on the cancel transition.
  IF (OLD.cancelled_at IS NOT NULL) THEN RETURN NEW; END IF;
  IF (NEW.cancelled_at IS NULL)     THEN RETURN NEW; END IF;

  v_creator_name := public.notif_user_name(NEW.creator_id);
  v_venue        := COALESCE(NEW.venue_name, 'et sted');

  v_today_oslo := (now()          AT TIME ZONE 'Europe/Oslo')::date;
  v_plan_date  := (NEW.planned_at AT TIME ZONE 'Europe/Oslo')::date;
  v_time_oslo  := to_char(NEW.planned_at AT TIME ZONE 'Europe/Oslo', 'HH24:MI');
  v_when := CASE
    WHEN v_plan_date = v_today_oslo     THEN 'i dag kl. '     || v_time_oslo
    WHEN v_plan_date = v_today_oslo + 1 THEN 'i morgen kl. '  || v_time_oslo
    WHEN v_plan_date = v_today_oslo - 1 THEN 'i går kl. '     || v_time_oslo
    ELSE to_char(NEW.planned_at AT TIME ZONE 'Europe/Oslo', 'DD.MM') || ' kl. ' || v_time_oslo
  END;

  INSERT INTO public.notifications (user_id, notif_id, category, body, lead, nav)
  SELECT
    pi.user_id,
    'plan_cancelled:' || NEW.id,
    'social',
    '<strong>' || v_creator_name || '</strong> kansellerte planen til <strong>' || v_venue || '</strong> ' || v_when || '.',
    jsonb_build_object('type', 'avatar', 'name', v_creator_name, 'count', 0),
    jsonb_build_object('kind', 'plan', 'venueId', NEW.venue_id, 'plannedAt', NEW.planned_at, 'cancelled', true)
  FROM public.plan_invites pi
  WHERE pi.plan_id = NEW.id
    AND pi.status IN ('pending', 'accepted')  -- already-declined invitees don't need this ping
  ON CONFLICT (user_id, notif_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notif_on_plan_cancelled ON public.plans;
CREATE TRIGGER notif_on_plan_cancelled
  AFTER UPDATE ON public.plans
  FOR EACH ROW
  EXECUTE FUNCTION public.notif_on_plan_cancelled();

REVOKE EXECUTE ON FUNCTION public.notif_on_plan_cancelled() FROM PUBLIC, anon, authenticated;

-- ─── Push notification on cancel ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.notify_plan_cancelled()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_creator      TEXT;
  v_venue        TEXT;
  v_when         TEXT;
  v_today_oslo   DATE;
  v_plan_date    DATE;
  v_time_oslo    TEXT;
  v_target_user  uuid;
  v_payload      jsonb;
BEGIN
  IF (OLD.cancelled_at IS NOT NULL) THEN RETURN NEW; END IF;
  IF (NEW.cancelled_at IS NULL)     THEN RETURN NEW; END IF;

  SELECT COALESCE(prof.name, split_part(prof.email, '@', 1), 'Noen')
    INTO v_creator
    FROM public.profiles prof
   WHERE prof.id = NEW.creator_id;

  v_venue := COALESCE(NEW.venue_name, 'et sted');

  v_today_oslo := (now()          AT TIME ZONE 'Europe/Oslo')::date;
  v_plan_date  := (NEW.planned_at AT TIME ZONE 'Europe/Oslo')::date;
  v_time_oslo  := to_char(NEW.planned_at AT TIME ZONE 'Europe/Oslo', 'HH24:MI');
  v_when := CASE
    WHEN v_plan_date = v_today_oslo     THEN 'i dag kl. '     || v_time_oslo
    WHEN v_plan_date = v_today_oslo + 1 THEN 'i morgen kl. '  || v_time_oslo
    WHEN v_plan_date = v_today_oslo - 1 THEN 'i går kl. '     || v_time_oslo
    ELSE to_char(NEW.planned_at AT TIME ZONE 'Europe/Oslo', 'DD.MM') || ' kl. ' || v_time_oslo
  END;

  -- Fire one push per non-declined invitee.
  FOR v_target_user IN
    SELECT pi.user_id FROM public.plan_invites pi
     WHERE pi.plan_id = NEW.id AND pi.status IN ('pending', 'accepted')
  LOOP
    v_payload := jsonb_build_object(
      'user_id', v_target_user,
      'payload', jsonb_build_object(
        'title', 'Shades',
        'body',  v_creator || ' kansellerte planen til ' || v_venue || ' ' || v_when,
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

DROP TRIGGER IF EXISTS notify_plan_cancelled ON public.plans;
CREATE TRIGGER notify_plan_cancelled
  AFTER UPDATE ON public.plans
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_plan_cancelled();

REVOKE EXECUTE ON FUNCTION public.notify_plan_cancelled() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
