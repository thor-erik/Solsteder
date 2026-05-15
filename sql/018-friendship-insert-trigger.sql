-- 018-friendship-insert-trigger.sql — fire the friendship-accepted
-- notification on INSERT, not just UPDATE.
--
-- The original trigger watched AFTER UPDATE for status transitions
-- from pending → accepted. That covers the classic invite flow
-- (send request → other person taps accept). It MISSES the share-link
-- flow, where the recipient clicks `#friend/<inviterId>` and the
-- client does a direct INSERT with status='accepted' — no UPDATE,
-- no notification, inviter never knows.
--
-- Idempotent.

CREATE OR REPLACE FUNCTION public.notif_on_friendship_accepted()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  acceptor_name TEXT;
BEGIN
  -- On UPDATE: only fire when status TRANSITIONS to 'accepted'.
  -- On INSERT: fire when the row lands at 'accepted' (share-link path).
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status != 'accepted' THEN RETURN NEW; END IF;
    IF OLD.status = 'accepted' THEN RETURN NEW; END IF;
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.status != 'accepted' THEN RETURN NEW; END IF;
  END IF;

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
  AFTER INSERT OR UPDATE ON public.friendships
  FOR EACH ROW
  EXECUTE FUNCTION public.notif_on_friendship_accepted();
