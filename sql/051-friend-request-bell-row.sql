-- 051-friend-request-bell-row.sql — extend notify_friend_request to ALSO
-- write a bell row alongside its existing push call.
--
-- Pre-this: notify_friend_request was push-only. The client
-- _evalIncomingFriendRequest 60s loop polled _pendingRequests to fire an
-- in-app toast. Now the trigger writes a bell row in the hybrid bodyKey
-- shape (sql/048 pattern), Realtime delivers it, and auth.js
-- _bellRowToToast surfaces the toast — same as plan invites + sun alerts.
--
-- Notif_id format: 'friend_request:<friendship_id>'. One bell row per
-- request (instead of the client's aggregated "Anna +2 wants to be your
-- friend" toast). Per-request granularity reads more accurately when
-- multiple friend requests land — the user sees a separate toast per
-- requester instead of an aggregated count that can lag the actual queue.
--
-- Also brings the push body in line with the other social pushes (NO
-- locale) — the previous English "wants to be your friend" was an
-- inconsistency from the early send-push days.
--
-- Idempotent.

CREATE OR REPLACE FUNCTION public.notify_friend_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_requester text;
BEGIN
  IF NEW.status <> 'pending'        THEN RETURN NEW; END IF;
  IF NEW.user_id = NEW.friend_id    THEN RETURN NEW; END IF;

  v_requester := public.notif_user_name(NEW.user_id);

  -- Bell row (new in sql/051).
  INSERT INTO public.notifications (user_id, notif_id, category, body, lead, nav)
  VALUES (
    NEW.friend_id,
    'friend_request:' || NEW.id,
    'social',
    '<strong>' || v_requester || '</strong> vil bli venn med deg.',
    jsonb_build_object(
      'type',     'avatar',
      'name',     v_requester,
      'count',    0,
      'bodyKey',  'notif_friend_request_body',
      'bodyVars', jsonb_build_object('name', v_requester)
    ),
    jsonb_build_object('kind', 'friend-request', 'friendshipId', NEW.id)
  )
  ON CONFLICT (user_id, notif_id) DO NOTHING;

  -- Push (unchanged channel, body now Norwegian to match the other social pushes).
  PERFORM public._do_send_push(
    NEW.friend_id,
    jsonb_build_object(
      'title', 'Shades',
      'body',  v_requester || ' vil bli venn med deg.',
      'url',   '/',
      'tag',   'social_friend_request_' || NEW.id::text
    )
  );
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
