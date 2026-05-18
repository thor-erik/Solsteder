-- 039-revoke-profile-email-HOLD.sql
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ ⚠ HOLD — DO NOT APPLY UNTIL THE CLIENT FRIEND-ADD FLOW IS SWITCHED      ║
-- ║   TO THE request_friend_by_email() RPC FROM sql/038.                     ║
-- ║                                                                          ║
-- ║   File suffix '-HOLD' is intentional so this doesn't get swept into a   ║
-- ║   bulk migration apply. Rename to drop '-HOLD' once the client has      ║
-- ║   shipped the RPC switch in js/auth.js sendFriendRequest() (~line 2749). ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- What this does. Postgres tables grant SELECT on the entire table by
-- default. The "public read" RLS on profiles is intentional (anon needs to
-- read inviter name for the invite-link landing page), but the email column
-- has no business being readable by REST callers — only by the SECURITY
-- DEFINER helpers (which bypass RLS and grants).
--
-- After this migration:
--   * anon and authenticated lose direct SELECT access to profiles.email.
--   * They retain SELECT on (id, name, avatar_url, locale) which the app's
--     legitimate read paths use.
--   * The SECURITY DEFINER triggers and request_friend_by_email() continue
--     to work because SECURITY DEFINER functions run as the function owner
--     (postgres), which still has full access.
--
-- What breaks if applied early:
--   * js/auth.js:2749-2766 sendFriendRequest() does
--       SELECT id FROM profiles WHERE email = $1
--     which uses SELECT(email) implicitly in the WHERE clause. After REVOKE
--     this returns zero rows for every email, silently breaking add-friend
--     by email. (No error — PostgREST treats the missing column as "no
--     match".) Switch the client to the RPC FIRST, ship, then apply this.
--
-- Idempotent. The grant column list mirrors what the app's read paths
-- actually need; if a future read path needs additional columns, add them
-- to the GRANT below rather than reverting the REVOKE.

REVOKE SELECT ON public.profiles FROM anon, authenticated;

GRANT SELECT (id, name, avatar_url, role, locale, created_at, last_seen_at)
  ON public.profiles TO anon, authenticated;

-- The 'email' column is intentionally omitted from the GRANT list.
-- Only SECURITY DEFINER functions (handle_new_user, notif_user_name,
-- request_friend_by_email, the push-trigger functions) can read it now,
-- which is sufficient for every legitimate path.

NOTIFY pgrst, 'reload schema';
