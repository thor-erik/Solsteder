-- 048-hybrid-payload-phase-2.sql — extend hybrid bodyKey/bodyVars payload
-- to the four remaining server-side bell-row triggers:
--
--   * notif_on_friendship_accepted
--   * notif_on_plan_invite_created
--   * notif_on_plan_invite_response
--   * notif_on_plan_cancelled
--
-- Each function keeps emitting the pre-rendered NO `body` so push and
-- pre-hybrid clients still render correctly. The new `lead.bodyKey` +
-- `lead.bodyVars` give the client (auth.js _bellBodyFromDescriptor) a
-- locale-aware path: the bell + toast call t() in the user's locale.
--
-- Date/time stays out of bodyVars — the client synthesizes the locale-
-- aware `{when}` from nav.plannedAt via _renderPlannedWhen at render
-- time (avoids baking the NO `notif_when_label` into the structured
-- payload and duplicating localization logic on both sides).
--
-- The friend_request and plan-reminder push-only triggers (notify_*)
-- still ship NO push bodies; only the notif_on_* bell triggers carry
-- the structured payload. process_sun_alerts (sql/047) and
-- process_plan_reminders (sql/044) already use the hybrid pattern.
--
-- Idempotent.

-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║ 1. notif_on_friendship_accepted                                        ║
-- ╚════════════════════════════════════════════════════════════════════════╝
CREATE OR REPLACE FUNCTION public.notif_on_friendship_accepted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  acceptor_name TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status != 'accepted' THEN RETURN NEW; END IF;
    IF OLD.status = 'accepted' THEN RETURN NEW; END IF;
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.status != 'accepted' THEN RETURN NEW; END IF;
  END IF;

  acceptor_name := public.notif_user_name(NEW.friend_id);

  INSERT INTO public.notifications (user_id, notif_id, category, body, lead, nav)
  VALUES (
    NEW.user_id,
    'friend_accepted:' || NEW.id,
    'social',
    'Du og <strong>' || acceptor_name || '</strong> er nå venner.',
    jsonb_build_object(
      'type',     'avatar',
      'name',     acceptor_name,
      'count',    0,
      'bodyKey',  'notif_friendship_accepted_body',
      'bodyVars', jsonb_build_object('name', acceptor_name)
    ),
    jsonb_build_object('kind', 'friends')
  )
  ON CONFLICT (user_id, notif_id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║ 2. notif_on_plan_invite_created                                        ║
-- ╚════════════════════════════════════════════════════════════════════════╝
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
    jsonb_build_object(
      'type',     'avatar',
      'name',     v_creator_name,
      'count',    0,
      'bodyKey',  'notif_plan_invite_created_body',
      'bodyVars', jsonb_build_object('name', v_creator_name, 'venue', v_venue)
    ),
    jsonb_build_object('kind', 'plan', 'venueId', p.venue_id, 'plannedAt', p.planned_at)
  )
  ON CONFLICT (user_id, notif_id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║ 3. notif_on_plan_invite_response                                       ║
-- ╚════════════════════════════════════════════════════════════════════════╝
CREATE OR REPLACE FUNCTION public.notif_on_plan_invite_response()
RETURNS trigger
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
  v_body_key     TEXT;
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

  v_body_key := CASE NEW.status
    WHEN 'accepted' THEN 'notif_plan_invite_response_accepted_body'
    ELSE                 'notif_plan_invite_response_declined_body'
  END;

  INSERT INTO public.notifications (user_id, notif_id, category, body, lead, nav)
  VALUES (
    p.creator_id,
    'social_invite_' || NEW.status || '_' || NEW.plan_id::text,
    'social',
    v_body,
    jsonb_build_object(
      'type',     'avatar',
      'name',     v_invitee_name,
      'count',    0,
      'bodyKey',  v_body_key,
      'bodyVars', jsonb_build_object('name', v_invitee_name, 'tail', v_tail, 'venue', v_venue)
    ),
    jsonb_build_object('kind', 'plan', 'venueId', p.venue_id, 'plannedAt', p.planned_at)
  )
  ON CONFLICT (user_id, notif_id) DO UPDATE
    SET body = EXCLUDED.body, lead = EXCLUDED.lead, nav = EXCLUDED.nav, read_at = NULL;
  RETURN NEW;
END;
$$;

-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║ 4. notif_on_plan_cancelled                                             ║
-- ╚════════════════════════════════════════════════════════════════════════╝
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
    jsonb_build_object(
      'type',     'avatar',
      'name',     v_creator_name,
      'count',    0,
      'bodyKey',  'notif_plan_cancelled_body',
      'bodyVars', jsonb_build_object('name', v_creator_name, 'venue', v_venue)
    ),
    jsonb_build_object('kind', 'plan', 'venueId', NEW.venue_id, 'plannedAt', NEW.planned_at, 'cancelled', true)
  FROM public.plan_invites pi
  WHERE pi.plan_id = NEW.id AND pi.status IN ('pending', 'accepted')
  ON CONFLICT (user_id, notif_id) DO NOTHING;
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
