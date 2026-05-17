-- 028-plan-response-bell-aggregate.sql — bell-inbox notification for
-- accept/decline responses now AGGREGATES per plan (per-status) and
-- shares the same notif_id format as the client-side aggregator.
--
-- Original (sql/013): notif_id = 'plan_invite_<status>:<invite_id>'.
-- Each responder produced its own row. With the client aggregator
-- (_evalInviteAccepted) writing 'social_invite_accepted_<plan_id>',
-- the host's inbox could show three rows for the same plan when
-- three people accepted.
--
-- New: notif_id = 'social_invite_<status>_<plan_id>' (matches the
-- client). ON CONFLICT now does UPDATE — refreshes body, lead, nav,
-- and read_at so the row re-surfaces as unread when a new responder
-- joins. Body uses the same enriched form as the push from sql/027:
--   "Anna har godtatt invitasjonen din til Starbucks i morgen kl 12"
--   "Marit +2 har godtatt invitasjonen din til Starbucks i morgen kl 12"
--
-- The client's _evalInviteAccepted still writes via _bellPersist —
-- both sides target the same notif_id so the upsert is idempotent.
-- This buys us: (a) the bell row exists for offline-then-online
-- recipients (server already wrote it from the trigger), and (b) no
-- duplicates regardless of which side wrote last.
--
-- Idempotent.

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
  v_when         TEXT;
  v_today_oslo   DATE;
  v_plan_date    DATE;
  v_time_oslo    TEXT;
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
  IF p.creator_id = NEW.user_id THEN RETURN NEW; END IF; -- skip self

  v_invitee_name := public.notif_user_name(NEW.user_id);
  v_venue        := COALESCE(p.venue_name, 'et sted');

  v_today_oslo := (now()          AT TIME ZONE 'Europe/Oslo')::date;
  v_plan_date  := (p.planned_at   AT TIME ZONE 'Europe/Oslo')::date;
  v_time_oslo  := to_char(p.planned_at AT TIME ZONE 'Europe/Oslo', 'HH24:MI');
  v_when := CASE
    WHEN v_plan_date = v_today_oslo     THEN 'i dag kl. '     || v_time_oslo
    WHEN v_plan_date = v_today_oslo + 1 THEN 'i morgen kl. '  || v_time_oslo
    WHEN v_plan_date = v_today_oslo - 1 THEN 'i går kl. '     || v_time_oslo
    ELSE to_char(p.planned_at AT TIME ZONE 'Europe/Oslo', 'DD.MM') || ' kl. ' || v_time_oslo
  END;

  SELECT COUNT(*) INTO v_total
    FROM public.plan_invites pi
   WHERE pi.plan_id = NEW.plan_id
     AND pi.status = NEW.status;
  v_extra := GREATEST(0, v_total - 1);
  v_tail := CASE WHEN v_extra > 0 THEN ' +' || v_extra::text ELSE '' END;

  v_verb := CASE NEW.status WHEN 'accepted' THEN 'har godtatt' ELSE 'har avslått' END;
  v_body := '<strong>' || v_invitee_name || '</strong>' || v_tail
            || ' ' || v_verb || ' invitasjonen din til <strong>' || v_venue
            || '</strong> ' || v_when || '.';

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
    SET body    = EXCLUDED.body,
        lead    = EXCLUDED.lead,
        nav     = EXCLUDED.nav,
        -- Reset read_at so the row pops back to "unread" with a fresh
        -- dot when another responder joins. Matches the user's stated
        -- desire that the inbox dot re-triggers on each new accept.
        read_at = NULL;

  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
