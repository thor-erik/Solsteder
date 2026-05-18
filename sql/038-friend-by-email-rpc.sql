-- 038-friend-by-email-rpc.sql — SECURITY DEFINER RPC for "add a friend by
-- email" that replaces the current direct SELECT on public.profiles.
--
-- The current client flow (js/auth.js:2749-2766 sendFriendRequest()):
--   1. SELECT id FROM profiles WHERE email = $1
--   2. If found, INSERT into friendships (user_id, friend_id) at the
--      default 'pending' status.
--
-- Two problems with that:
--   (a) It requires anon/authenticated to have SELECT access to
--       profiles.email — which CLAUDE.md claims is "grant-revoked" but no
--       migration actually does that. The grant state is whatever was
--       applied manually via the Supabase Studio UI (drift).
--   (b) Even with the grant intact, the lookup is an email-existence oracle
--       to any authenticated user: pass any email, learn whether an account
--       exists for it. This RPC doesn't fix (b) (it preserves the existing
--       error shape so the UX doesn't regress), but it MAKES IT POSSIBLE to
--       eventually revoke SELECT(email) without breaking the friend-add
--       flow — which is what sql/039 does.
--
-- Switch the client at js/auth.js:2749-2766 to call this RPC instead of the
-- direct SELECT. Once that ships AND the REVOKE in sql/039 is applied, the
-- email column is no longer readable by REST callers at all — only this
-- RPC can resolve an email.
--
-- ── Errors returned ────────────────────────────────────────────────────────
--   { ok: true }                              — pending friendship row created
--   { ok: false, error: 'not_authenticated' } — auth.uid() was null
--   { ok: false, error: 'invalid_email'     } — null or empty input
--   { ok: false, error: 'not_found'         } — no profile matches the email
--   { ok: false, error: 'self'              } — caller emailed their own address
--   { ok: false, error: 'already_exists'    } — row in either direction exists
--
-- The error names match what the current client surfaces, so the receiving
-- code (js/auth.js sendFriendRequest result handling) doesn't need branch
-- rewrites — just route 'ok:false' to the existing error display.
--
-- Idempotent.

CREATE OR REPLACE FUNCTION public.request_friend_by_email(p_email TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_caller uuid;
  v_target uuid;
  v_email  text;
  v_exists boolean;
BEGIN
  v_caller := (SELECT auth.uid());
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  IF p_email IS NULL OR length(trim(p_email)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_email');
  END IF;

  v_email := lower(trim(p_email));

  -- Profiles.email is mirrored from auth.users at signup via handle_new_user
  -- (sql/017). Supabase normalizes to lowercase but match defensively.
  SELECT id INTO v_target
    FROM public.profiles
   WHERE lower(email) = v_email
   LIMIT 1;

  IF v_target IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF v_target = v_caller THEN
    RETURN jsonb_build_object('ok', false, 'error', 'self');
  END IF;

  -- Block re-issuing a request when ANY row exists in either direction —
  -- including 'blocked'. The caller's UI can offer "update existing"
  -- through the regular friendships UPDATE flow (covered by the existing
  -- RLS update policy for the user_id side).
  SELECT EXISTS (
    SELECT 1 FROM public.friendships
    WHERE (user_id = v_caller AND friend_id = v_target)
       OR (user_id = v_target AND friend_id = v_caller)
  ) INTO v_exists;

  IF v_exists THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_exists');
  END IF;

  INSERT INTO public.friendships (user_id, friend_id, status)
  VALUES (v_caller, v_target, 'pending');

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.request_friend_by_email(TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.request_friend_by_email(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
