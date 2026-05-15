-- 022-plan-invite-insert-triggers.sql — fire the initial-invite
-- notifications when a plan_invites row is INSERTed at status='pending'.
--
-- The existing triggers only handle the response side (accepted/
-- declined). Initial invites had no trigger → invitee got no push and
-- no inbox entry; only saw it via Realtime if the app was open.
--
-- Two triggers added:
--   * Bell / inbox: insert a notifications row for NEW.user_id
--   * Push: call send-push edge function targeting NEW.user_id
--
-- Idempotent.

-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║ Bell notification (in-app inbox)                                       ║
-- ╚════════════════════════════════════════════════════════════════════════╝
CREATE OR REPLACE FUNCTION public.notif_on_plan_invite_created()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  p RECORD;
  creator_name TEXT;
BEGIN
  IF NEW.status != 'pending' THEN RETURN NEW; END IF;

  SELECT * INTO p FROM public.plans WHERE id = NEW.plan_id;
  IF p IS NULL THEN RETURN NEW; END IF;

  creator_name := public.notif_user_name(p.creator_id);

  INSERT INTO public.notifications (user_id, notif_id, category, body, lead, nav)
  VALUES (
    NEW.user_id,
    'plan_invite_pending:' || NEW.id,
    'social',
    '<strong>' || creator_name || '</strong> har invitert deg til en plan.',
    jsonb_build_object('type', 'avatar', 'name', creator_name, 'count', 0),
    jsonb_build_object('kind', 'plan', 'venueId', p.venue_id, 'plannedAt', p.planned_at)
  )
  ON CONFLICT (user_id, notif_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notif_on_plan_invite_created ON public.plan_invites;
CREATE TRIGGER notif_on_plan_invite_created
  AFTER INSERT ON public.plan_invites
  FOR EACH ROW
  EXECUTE FUNCTION public.notif_on_plan_invite_created();

REVOKE EXECUTE ON FUNCTION public.notif_on_plan_invite_created() FROM PUBLIC, anon, authenticated;

-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║ Push notification                                                      ║
-- ╚════════════════════════════════════════════════════════════════════════╝
CREATE OR REPLACE FUNCTION public.notify_plan_invite_created()
RETURNS trigger AS $$
DECLARE
  v_creator   text;
  v_payload   jsonb;
BEGIN
  IF NEW.status != 'pending' THEN RETURN NEW; END IF;

  SELECT COALESCE(prof.name, split_part(prof.email, '@', 1), 'Someone')
    INTO v_creator
    FROM public.profiles prof
    JOIN public.plans p ON p.creator_id = prof.id
   WHERE p.id = NEW.plan_id;

  v_payload := jsonb_build_object(
    'user_id', NEW.user_id,
    'payload', jsonb_build_object(
      'title', 'Shades',
      'body',  v_creator || ' har invitert deg til en plan',
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
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS trg_plan_invite_created_push ON public.plan_invites;
CREATE TRIGGER trg_plan_invite_created_push
  AFTER INSERT ON public.plan_invites
  FOR EACH ROW EXECUTE FUNCTION public.notify_plan_invite_created();

REVOKE EXECUTE ON FUNCTION public.notify_plan_invite_created() FROM PUBLIC, anon, authenticated;
