-- 019-friendship-accepted-push.sql — push notification for the
-- friendship-accepted event (share-link flow + classic accept).
--
-- The existing notify_friend_request trigger only fires when a
-- friendship row lands at status='pending' (the classic invite flow).
-- The share-link flow inserts at status='accepted' directly — no
-- pending row, no push notification to the inviter. This migration
-- adds the missing trigger so the inviter (NEW.user_id) gets a push
-- whenever the row transitions to or lands at 'accepted'.
--
-- Idempotent.

CREATE OR REPLACE FUNCTION public.notify_friend_accepted()
RETURNS trigger AS $$
DECLARE
  v_acceptor text;
  v_payload  jsonb;
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

  v_payload := jsonb_build_object(
    'user_id', NEW.user_id,
    'payload', jsonb_build_object(
      'title', 'Shades',
      'body',  'Du og ' || v_acceptor || ' er nå venner.',
      'url',   '/',
      'tag',   'social_friend_accepted_' || NEW.id::text
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

DROP TRIGGER IF EXISTS trg_friendship_accepted_push ON public.friendships;
CREATE TRIGGER trg_friendship_accepted_push
  AFTER INSERT OR UPDATE ON public.friendships
  FOR EACH ROW EXECUTE FUNCTION public.notify_friend_accepted();

-- Lock down the new function — only triggers should call it, not the
-- REST RPC surface.
REVOKE EXECUTE ON FUNCTION public.notify_friend_accepted() FROM PUBLIC, anon, authenticated;
