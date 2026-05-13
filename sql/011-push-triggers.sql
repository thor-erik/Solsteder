-- 011-push-triggers.sql
--
-- Database triggers that fan out push notifications via the send-push
-- edge function. Runs AFTER the trigger row commits so the push only
-- fires for events that actually persisted.
--
-- Two triggers:
--   * plan_invites status change → 'X said yes / no'
--   * friendships insert at status=pending → 'X wants to be your friend'
--
-- Prerequisites:
--   1. The send-push edge function deployed:
--        supabase functions deploy send-push --no-verify-jwt
--      (or via the Supabase Studio Functions UI with Verify JWT off)
--   2. pg_net extension (this script enables it).
--
-- Note: the function URL and Bearer token are inlined into each trigger
-- below. We tried `alter database postgres set app.send_push_url = ...`
-- but the SQL editor's role lacks permission on hosted Supabase. Inlining
-- is fine: both values are already public (the anon key is in the JS
-- bundle, the function URL is the same one the client hits). If you
-- rotate the anon key, update both occurrences below + js/auth.js.

CREATE EXTENSION IF NOT EXISTS pg_net;

-- ─── plan_invites: notify the plan creator when an invitee responds ───────

CREATE OR REPLACE FUNCTION public.notify_invite_response()
RETURNS trigger AS $$
DECLARE
  v_creator_id    uuid;
  v_responder     text;
  v_venue_id      text;
  v_body          text;
  v_payload       jsonb;
BEGIN
  IF NEW.status NOT IN ('accepted', 'declined') THEN RETURN NEW; END IF;
  IF (TG_OP = 'UPDATE') AND OLD.status = NEW.status THEN RETURN NEW; END IF;

  SELECT p.creator_id, p.venue_id
    INTO v_creator_id, v_venue_id
    FROM public.plans p
   WHERE p.id = NEW.plan_id;
  IF v_creator_id IS NULL OR v_creator_id = NEW.user_id THEN RETURN NEW; END IF;

  SELECT COALESCE(prof.name, split_part(prof.email, '@', 1), 'Someone')
    INTO v_responder
    FROM public.profiles prof
   WHERE prof.id = NEW.user_id;

  IF NEW.status = 'accepted' THEN
    v_body := v_responder || ' said yes';
  ELSE
    v_body := v_responder || ' can''t make it';
  END IF;

  v_payload := jsonb_build_object(
    'user_id', v_creator_id,
    'payload', jsonb_build_object(
      'title', 'Shades',
      'body',  v_body,
      'url',   '/',
      'tag',   'social_invite_' || NEW.status || '_' || NEW.plan_id::text || '_' || NEW.user_id::text
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_plan_invite_response_push ON public.plan_invites;
CREATE TRIGGER trg_plan_invite_response_push
  AFTER INSERT OR UPDATE ON public.plan_invites
  FOR EACH ROW EXECUTE FUNCTION public.notify_invite_response();

-- ─── friendships: notify the recipient when someone wants to be friends ───

CREATE OR REPLACE FUNCTION public.notify_friend_request()
RETURNS trigger AS $$
DECLARE
  v_requester text;
  v_payload   jsonb;
BEGIN
  IF NEW.status <> 'pending' THEN RETURN NEW; END IF;
  IF NEW.user_id = NEW.friend_id THEN RETURN NEW; END IF;

  SELECT COALESCE(prof.name, split_part(prof.email, '@', 1), 'Someone')
    INTO v_requester
    FROM public.profiles prof
   WHERE prof.id = NEW.user_id;

  v_payload := jsonb_build_object(
    'user_id', NEW.friend_id,
    'payload', jsonb_build_object(
      'title', 'Shades',
      'body',  v_requester || ' wants to be your friend',
      'url',   '/',
      'tag',   'social_friend_request_' || NEW.id::text
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_friendship_request_push ON public.friendships;
CREATE TRIGGER trg_friendship_request_push
  AFTER INSERT ON public.friendships
  FOR EACH ROW EXECUTE FUNCTION public.notify_friend_request();
