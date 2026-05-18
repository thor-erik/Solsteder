-- 041-friend-invite-tokens.sql — restore the one-click "open link → friends"
-- UX without re-opening the C2 enumeration vector.
--
-- Context. sql/036 closed the gap where a recipient-side INSERT at
-- status='accepted' let anyone with a victim's UUID force-friendship
-- themselves into the victim's graph. Post-036, share-link clicks fall back
-- to a "pending request" model — secure but awkward (the recipient appears
-- to be the requester even though they're responding to a link the sender
-- shared). User feedback: "really strange flow".
--
-- This migration adds the missing piece: explicit, verifiable proof of the
-- sender's consent in the form of a one-shot token row the sender creates
-- when they copy the invite link. The recipient's click consumes the token
-- via a SECURITY DEFINER RPC that bypasses RLS and writes the friendship at
-- status='accepted' directly.
--
-- Security model:
--   * A token row IS proof of the sender's consent (only auth.uid()=sender
--     can create it via the RPC). Without a matching token, no instant
--     accept — the request falls back to the pending-request flow.
--   * Tokens are uuid v4 (gen_random_uuid) — 122 bits of entropy, not
--     enumerable. An attacker can't fabricate a valid token; they can only
--     guess, and a guess is computationally infeasible per attempt.
--   * Single-use: marked used_at on first consume; subsequent consumes 401.
--   * 30-day TTL: limits the window where a leaked token can be used.
--   * Self-consume is rejected (sender clicks their own link → no-op).
--   * Race-safe: the consume RPC's UPDATE has WHERE used_at IS NULL, so two
--     concurrent clicks can't both succeed (the second's UPDATE returns 0 rows).
--
-- RLS: deny-all from anon/authenticated. The two RPCs (create + consume) are
-- the only access paths, both SECURITY DEFINER.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.friend_invite_tokens (
  token       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inviter_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  used_at     timestamptz,
  used_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS friend_invite_tokens_inviter_idx
  ON public.friend_invite_tokens (inviter_id);
-- For the periodic cleanup query (delete expired+used).
CREATE INDEX IF NOT EXISTS friend_invite_tokens_expires_at_idx
  ON public.friend_invite_tokens (expires_at);

ALTER TABLE public.friend_invite_tokens ENABLE ROW LEVEL SECURITY;
-- No RLS policies. RLS-on + empty policy set = deny-all to anon/authenticated.
-- The RPCs below are SECURITY DEFINER so they bypass RLS and are the only
-- legitimate access path.

REVOKE ALL ON TABLE public.friend_invite_tokens FROM PUBLIC, anon, authenticated;

-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║ create_friend_invite_token() — sender mints a token when they copy    ║
-- ║ the link. Returns { ok, token, expires_at }. The client embeds token  ║
-- ║ in the URL: '#friend/<sender_id>/<token>'.                            ║
-- ╚════════════════════════════════════════════════════════════════════════╝
CREATE OR REPLACE FUNCTION public.create_friend_invite_token()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_caller  uuid;
  v_token   uuid;
  v_expires timestamptz;
BEGIN
  v_caller := (SELECT auth.uid());
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  INSERT INTO public.friend_invite_tokens (inviter_id)
  VALUES (v_caller)
  RETURNING token, expires_at INTO v_token, v_expires;

  RETURN jsonb_build_object('ok', true, 'token', v_token, 'expires_at', v_expires);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_friend_invite_token() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.create_friend_invite_token() TO authenticated;

-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║ consume_friend_invite_token(p_token uuid) — recipient consumes a      ║
-- ║ token after clicking the link. Marks the token used and creates the   ║
-- ║ friendship at status='accepted' directly (RLS bypass via SECURITY     ║
-- ║ DEFINER). Race-safe: the UPDATE WHERE used_at IS NULL means only one  ║
-- ║ caller wins if two click the same link simultaneously.                ║
-- ║                                                                       ║
-- ║ Returns one of:                                                       ║
-- ║   { ok: true,  inviter_id: <uuid> }                                   ║
-- ║   { ok: false, error: 'not_authenticated' }                           ║
-- ║   { ok: false, error: 'invalid_token' }     — no row matches          ║
-- ║   { ok: false, error: 'token_used' }        — used_at is not null     ║
-- ║   { ok: false, error: 'token_expired' }     — past expires_at         ║
-- ║   { ok: false, error: 'self' }              — caller is the sender    ║
-- ╚════════════════════════════════════════════════════════════════════════╝
CREATE OR REPLACE FUNCTION public.consume_friend_invite_token(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_caller  uuid;
  v_inviter uuid;
  v_used    timestamptz;
  v_expires timestamptz;
  v_claimed int;
BEGIN
  v_caller := (SELECT auth.uid());
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;
  IF p_token IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  SELECT inviter_id, used_at, expires_at
    INTO v_inviter, v_used, v_expires
    FROM public.friend_invite_tokens
   WHERE token = p_token;

  IF v_inviter IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END IF;
  IF v_used IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'token_used');
  END IF;
  IF v_expires < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'token_expired');
  END IF;
  IF v_inviter = v_caller THEN
    -- Sender opened their own link. Don't consume the token; just no-op.
    RETURN jsonb_build_object('ok', false, 'error', 'self');
  END IF;

  -- Atomically claim the token. If two recipients click the same link at
  -- the same moment, the loser's UPDATE returns 0 rows (used_at no longer
  -- IS NULL by the time their statement runs). Single-use semantics.
  UPDATE public.friend_invite_tokens
     SET used_at = now(), used_by = v_caller
   WHERE token = p_token AND used_at IS NULL;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'token_used');
  END IF;

  -- Create or upgrade the friendship to accepted in the inviter→caller
  -- direction. If a row already exists in that direction (e.g. inviter
  -- previously sent a pending request that the recipient is now accepting
  -- via the link), upgrade it.
  INSERT INTO public.friendships (user_id, friend_id, status)
  VALUES (v_inviter, v_caller, 'accepted')
  ON CONFLICT (user_id, friend_id) DO UPDATE SET status = 'accepted';

  -- And flip any reverse-direction pending row (e.g. caller had previously
  -- sent a request to the inviter that hadn't been accepted yet).
  UPDATE public.friendships
     SET status = 'accepted'
   WHERE user_id = v_caller AND friend_id = v_inviter AND status != 'accepted';

  RETURN jsonb_build_object('ok', true, 'inviter_id', v_inviter);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.consume_friend_invite_token(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.consume_friend_invite_token(uuid) TO authenticated;

-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║ Nightly cleanup of expired/used tokens. Used rows can stick around as ║
-- ║ audit trail for a window, then go away. Same pg_cron pattern as       ║
-- ║ notifications-ttl-cleanup (sql/031).                                  ║
-- ╚════════════════════════════════════════════════════════════════════════╝
CREATE OR REPLACE FUNCTION public.cleanup_friend_invite_tokens()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_deleted int;
BEGIN
  DELETE FROM public.friend_invite_tokens
   WHERE expires_at < now() - interval '7 days'
      OR (used_at IS NOT NULL AND used_at < now() - interval '7 days');
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cleanup_friend_invite_tokens() FROM PUBLIC, anon, authenticated;

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'friend-invite-tokens-cleanup';
SELECT cron.schedule(
  'friend-invite-tokens-cleanup',
  '15 1 * * *',  -- 01:15 UTC daily (offset from notifications-ttl-cleanup)
  $cmd$SELECT public.cleanup_friend_invite_tokens();$cmd$
);

NOTIFY pgrst, 'reload schema';
