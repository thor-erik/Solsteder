-- 013-notification-triggers.sql — server-side notification fan-out for the
-- two cross-device-critical events: plan-invite responses and friendship
-- acceptance. Both write to public.notifications when the row updates,
-- so a user opening their inbox on a different device sees the event
-- regardless of whether their client-side eval rules ever fired.
--
-- Triggers run as SECURITY DEFINER so they can INSERT into
-- public.notifications for ANOTHER user without tripping RLS.
--
-- Idempotent: safe to re-run.

-- ── Helper: resolve a profile's display name ───────────────────────────────
CREATE OR REPLACE FUNCTION public.notif_user_name(uid UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n TEXT;
BEGIN
  SELECT COALESCE(name, split_part(email, '@', 1), 'Noen') INTO n
  FROM public.profiles WHERE id = uid;
  RETURN COALESCE(n, 'Noen');
END;
$$;

-- ── Trigger 1: plan_invites status change → notify plan creator ────────────
-- Fires when an invitee's status moves to 'accepted' or 'declined'. The
-- creator gets a notification regardless of whether they were online.
CREATE OR REPLACE FUNCTION public.notif_on_plan_invite_response()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p RECORD;
  invitee_name TEXT;
BEGIN
  IF NEW.status NOT IN ('accepted', 'declined') THEN RETURN NEW; END IF;
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;

  SELECT * INTO p FROM public.plans WHERE id = NEW.plan_id;
  IF p IS NULL THEN RETURN NEW; END IF;

  invitee_name := notif_user_name(NEW.user_id);

  INSERT INTO public.notifications (user_id, notif_id, category, body, lead, nav)
  VALUES (
    p.creator_id,
    'plan_invite_' || NEW.status || ':' || NEW.id,
    'social',
    '<strong>' || invitee_name || '</strong> sa ' ||
      CASE NEW.status WHEN 'accepted' THEN 'ja' ELSE 'nei' END ||
      ' til planen din.',
    jsonb_build_object('type', 'avatar', 'name', invitee_name, 'count', 0),
    jsonb_build_object('kind', 'plan', 'venueId', p.venue_id, 'plannedAt', p.planned_at)
  )
  ON CONFLICT (user_id, notif_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notif_on_plan_invite_response ON public.plan_invites;
CREATE TRIGGER notif_on_plan_invite_response
  AFTER UPDATE ON public.plan_invites
  FOR EACH ROW
  EXECUTE FUNCTION public.notif_on_plan_invite_response();

-- ── Trigger 2: friendship accepted → notify the original requester ─────────
-- Row direction (per schema): user_id requested friendship with friend_id.
-- When friend_id accepts (status moves to 'accepted'), notify user_id.
-- There's no client-side eval rule for this — the trigger fills a real
-- gap (currently the requester only learns via re-fetching friends).
CREATE OR REPLACE FUNCTION public.notif_on_friendship_accepted()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  acceptor_name TEXT;
BEGIN
  IF NEW.status != 'accepted' THEN RETURN NEW; END IF;
  IF OLD.status = 'accepted' THEN RETURN NEW; END IF;

  acceptor_name := notif_user_name(NEW.friend_id);

  INSERT INTO public.notifications (user_id, notif_id, category, body, lead, nav)
  VALUES (
    NEW.user_id,
    'friend_accepted:' || NEW.id,
    'social',
    'Du og <strong>' || acceptor_name || '</strong> er nå venner.',
    jsonb_build_object('type', 'avatar', 'name', acceptor_name, 'count', 0),
    jsonb_build_object('kind', 'friends')
  )
  ON CONFLICT (user_id, notif_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notif_on_friendship_accepted ON public.friendships;
CREATE TRIGGER notif_on_friendship_accepted
  AFTER UPDATE ON public.friendships
  FOR EACH ROW
  EXECUTE FUNCTION public.notif_on_friendship_accepted();
