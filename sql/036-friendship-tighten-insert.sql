-- 036-friendship-tighten-insert.sql — close the "claim friendship at
-- status='accepted' with no inviter consent" RLS gap on public.friendships.
--
-- Prior policy (sql/014):
--   CREATE POLICY "Users create friend requests" ON public.friendships
--     FOR INSERT
--     WITH CHECK (auth.uid() = user_id OR auth.uid() = friend_id);
--
-- Attack: any signed-in user could POST
--   { user_id: <victim_uuid>, friend_id: <me_uuid>, status: 'accepted' }
-- directly via the REST API. The policy passed because auth.uid() = friend_id.
-- Consequences chained off the resulting accepted-state row:
--   * notif_on_friendship_accepted (sql/018) writes a notification to victim
--   * notify_friend_accepted       (sql/019) fires a push to victim
--   * checkins_select               (sql/016) starts matching victim ↔ me,
--                                   leaking every active checkin victim posts
--   * profile embeds become readable in either direction
--
-- New policy: split the OR into two semantic cases.
--   * Inviter requesting friendship (auth.uid() = user_id): always allowed.
--   * Recipient inserting their side (auth.uid() = friend_id): only at
--     status='pending'. To accept, the recipient updates the existing
--     inviter-side row to 'accepted' (already covered by the
--     "Users update own friendships" UPDATE policy).
--
-- Also guards against self-friendship (user_id = friend_id), which was
-- structurally meaningless but silently allowed.
--
-- ── Client impact ──────────────────────────────────────────────────────────
-- The share-link cold-call flow in js/auth.js:3269-3273 currently inserts at
-- status='accepted' when no prior row exists. After this migration that
-- INSERT will be rejected. The recipient flow becomes:
--   1. Look up existing rows in either direction (already in the code).
--   2. If a pending row exists from the inviter → UPDATE to 'accepted'
--      (already in the code).
--   3. If NO row exists → INSERT at status='pending' (was 'accepted').
--      The inviter then sees a pending request and accepts the normal way.
--
-- Until the client is updated, share-link clicks from a recipient who has
-- never interacted with the inviter will fail. That's intentional — those
-- inserts are the exact attack vector the policy is closing. The inviter-side
-- flow (sendFriendRequest, js/auth.js:2749-2766) is unaffected because
-- auth.uid() = user_id always passes.
--
-- Idempotent.

DROP POLICY IF EXISTS "Users create friend requests" ON public.friendships;
CREATE POLICY "Users create friend requests" ON public.friendships
  FOR INSERT
  WITH CHECK (
    -- No self-friend rows. Structural; nothing in the app uses them but the
    -- old policy didn't reject them.
    (user_id <> friend_id)
    AND
    (
      -- Inviter requesting friendship: always allowed. status default is
      -- 'pending' (table default) but accepted/blocked also pass here since
      -- the inviter is the actor in either direction.
      ((select auth.uid()) = user_id)
      OR
      -- Recipient inserting their side: only at status='pending'. Accepting
      -- an existing invite uses UPDATE, not INSERT — that path runs through
      -- "Users update own friendships" which already covers it.
      (((select auth.uid()) = friend_id) AND (status = 'pending'))
    )
  );
