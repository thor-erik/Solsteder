-- 011-push-triggers.sql
--
-- Database triggers that fan out push notifications via the send-push
-- edge function. Runs AFTER the trigger row commits so the push only
-- fires for events that actually persisted.
--
-- Two triggers:
--   * plan_invites status change → 'X said yes / no to {venue}'
--   * friendships insert at status=pending → 'X wants to be your friend'
--
-- Both call the same send-push function with { user_id, payload }.
-- The function signs the push with the VAPID private key (stored as a
-- Supabase secret) and POSTs to each of the recipient's push
-- subscriptions.
--
-- Prerequisites:
--   1. The send-push edge function deployed:
--        supabase functions deploy send-push --no-verify-jwt
--   2. pg_net extension enabled (for net.http_post):
--        create extension if not exists pg_net;
--   3. Settings populated with your project's function URL + anon key:
--        alter database postgres set app.send_push_url   = 'https://<project-ref>.supabase.co/functions/v1/send-push';
--        alter database postgres set app.send_push_token = '<your project anon key>';
--      (Run those once. The token is the anon key — the function was
--       deployed --no-verify-jwt so any caller with the right shape
--       reaches it, but we still send the anon key in Authorization to
--       satisfy the Supabase gateway.)

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
  -- Only fire when the status actually transitions into accepted / declined.
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
    url     := current_setting('app.send_push_url', true),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || current_setting('app.send_push_token', true)
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
    url     := current_setting('app.send_push_url', true),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || current_setting('app.send_push_token', true)
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
