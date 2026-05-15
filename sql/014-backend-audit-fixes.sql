-- 014-backend-audit-fixes.sql — security + performance fixes from the
-- backend audit. Four independent groups; idempotent; safe to re-run.
--
-- B. Revoke EXECUTE on SECURITY DEFINER triggers/helpers from anon+auth
-- C. Pin search_path on legacy SECURITY DEFINER functions
-- D. Add covering indexes for unindexed foreign keys
-- E. Rewrite RLS policies to wrap auth.uid() in (select) so the planner
--    evaluates it once per query instead of once per row
--
-- (A. Move pg_net out of public — removed: pg_net does not support
--  ALTER EXTENSION ... SET SCHEMA on hosted Supabase. The advisor warning
--  is acknowledged but unfixable from SQL; would need a manual reinstall
--  into a different schema, which Supabase support has to do for us.)

-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║ B. Revoke EXECUTE on internal SECURITY DEFINER functions               ║
-- ║    They're called from triggers, not by user-issued RPC.               ║
-- ║    _current_user_role() stays callable by authenticated because RLS    ║
-- ║    policies invoke it; only anon loses access.                         ║
-- ╚════════════════════════════════════════════════════════════════════════╝
DO $$
DECLARE
  fn RECORD;
BEGIN
  FOR fn IN
    SELECT proname, oidvectortypes(proargtypes) AS args
    FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'handle_new_user', '_handle_new_user',
        'notify_friend_request', 'notify_invite_response',
        'notif_on_friendship_accepted', 'notif_on_plan_invite_response',
        'notif_user_name'
      )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM anon, authenticated',
                   fn.proname, fn.args);
  END LOOP;
END $$;

REVOKE EXECUTE ON FUNCTION public._current_user_role() FROM anon;

-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║ C. Pin search_path on legacy SECURITY DEFINER functions                ║
-- ║    Prevents shadowed-function attacks where a malicious schema in the  ║
-- ║    caller's search_path could intercept lookups inside the function.   ║
-- ╚════════════════════════════════════════════════════════════════════════╝
DO $$
DECLARE
  fn TEXT;
  fns TEXT[] := ARRAY[
    '_current_user_role()',
    'handle_new_user()',
    'notify_friend_request()',
    'notify_invite_response()'
  ];
BEGIN
  FOREACH fn IN ARRAY fns LOOP
    BEGIN
      EXECUTE format('ALTER FUNCTION public.%s SET search_path = public, pg_catalog', fn);
    EXCEPTION WHEN undefined_function THEN
      RAISE NOTICE 'skipped %: not found', fn;
    END;
  END LOOP;
END $$;

-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║ D. Covering indexes for foreign keys                                   ║
-- ║    Without these, ON DELETE CASCADE / FK-join queries do a seqscan.    ║
-- ╚════════════════════════════════════════════════════════════════════════╝
CREATE INDEX IF NOT EXISTS checkins_user_id_idx          ON public.checkins (user_id);
CREATE INDEX IF NOT EXISTS events_user_id_idx            ON public.events (user_id);
CREATE INDEX IF NOT EXISTS friendships_friend_id_idx     ON public.friendships (friend_id);
CREATE INDEX IF NOT EXISTS plan_invites_user_id_idx      ON public.plan_invites (user_id);
CREATE INDEX IF NOT EXISTS plans_creator_id_idx          ON public.plans (creator_id);
CREATE INDEX IF NOT EXISTS suggested_venues_reviewed_by_idx ON public.suggested_venues (reviewed_by);
CREATE INDEX IF NOT EXISTS suggested_venues_user_id_idx  ON public.suggested_venues (user_id);

-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║ E. Rewrite RLS policies: auth.uid() → (select auth.uid())              ║
-- ║    With the SELECT wrapper, Postgres caches the value across the       ║
-- ║    query instead of re-invoking the auth function per row.             ║
-- ║    Policy bodies preserved exactly; only auth.uid() calls wrapped.     ║
-- ╚════════════════════════════════════════════════════════════════════════╝

-- ── checkins ──
DROP POLICY IF EXISTS "Friends see active checkins" ON public.checkins;
CREATE POLICY "Friends see active checkins" ON public.checkins
  FOR SELECT
  USING ((expires_at > now()) AND
         (((select auth.uid()) = user_id) OR
          (EXISTS (
            SELECT 1 FROM friendships
            WHERE friendships.status = 'accepted'
              AND ((friendships.user_id = (select auth.uid()) AND friendships.friend_id = checkins.user_id)
                OR (friendships.friend_id = (select auth.uid()) AND friendships.user_id = checkins.user_id))
          ))));

DROP POLICY IF EXISTS "Users manage own checkins" ON public.checkins;
CREATE POLICY "Users manage own checkins" ON public.checkins
  FOR ALL USING ((select auth.uid()) = user_id);

-- ── favorites ──
DROP POLICY IF EXISTS "Users manage own favorites" ON public.favorites;
CREATE POLICY "Users manage own favorites" ON public.favorites
  FOR ALL USING ((select auth.uid()) = user_id);

-- ── friendships ──
DROP POLICY IF EXISTS "Users create friend requests" ON public.friendships;
CREATE POLICY "Users create friend requests" ON public.friendships
  FOR INSERT
  WITH CHECK (((select auth.uid()) = user_id) OR ((select auth.uid()) = friend_id));

DROP POLICY IF EXISTS "Users delete own friendships" ON public.friendships;
CREATE POLICY "Users delete own friendships" ON public.friendships
  FOR DELETE
  USING (((select auth.uid()) = user_id) OR ((select auth.uid()) = friend_id));

DROP POLICY IF EXISTS "Users see own friendships" ON public.friendships;
CREATE POLICY "Users see own friendships" ON public.friendships
  FOR SELECT
  USING (((select auth.uid()) = user_id) OR ((select auth.uid()) = friend_id));

DROP POLICY IF EXISTS "Users update own friendships" ON public.friendships;
CREATE POLICY "Users update own friendships" ON public.friendships
  FOR UPDATE
  USING (((select auth.uid()) = user_id) OR ((select auth.uid()) = friend_id));

-- ── notifications ──
DROP POLICY IF EXISTS "user_select_own" ON public.notifications;
CREATE POLICY "user_select_own" ON public.notifications
  FOR SELECT USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "user_insert_own" ON public.notifications;
CREATE POLICY "user_insert_own" ON public.notifications
  FOR INSERT WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "user_update_own" ON public.notifications;
CREATE POLICY "user_update_own" ON public.notifications
  FOR UPDATE USING ((select auth.uid()) = user_id)
             WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "user_delete_own" ON public.notifications;
CREATE POLICY "user_delete_own" ON public.notifications
  FOR DELETE USING ((select auth.uid()) = user_id);

-- ── plan_invites ──
DROP POLICY IF EXISTS "Invitees see own invites" ON public.plan_invites;
CREATE POLICY "Invitees see own invites" ON public.plan_invites
  FOR SELECT USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Invitees update own status" ON public.plan_invites;
CREATE POLICY "Invitees update own status" ON public.plan_invites
  FOR UPDATE USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Plan creator manages invites" ON public.plan_invites;
CREATE POLICY "Plan creator manages invites" ON public.plan_invites
  FOR ALL USING (EXISTS (
    SELECT 1 FROM plans
    WHERE plans.id = plan_invites.plan_id AND plans.creator_id = (select auth.uid())
  ));

-- ── plans ──
DROP POLICY IF EXISTS "Creator and invitees see plans" ON public.plans;
CREATE POLICY "Creator and invitees see plans" ON public.plans
  FOR SELECT USING (
    ((select auth.uid()) = creator_id) OR
    (EXISTS (
      SELECT 1 FROM plan_invites
      WHERE plan_invites.plan_id = plans.id AND plan_invites.user_id = (select auth.uid())
    ))
  );

DROP POLICY IF EXISTS "Users create plans" ON public.plans;
CREATE POLICY "Users create plans" ON public.plans
  FOR INSERT WITH CHECK ((select auth.uid()) = creator_id);

-- ── profiles ──
DROP POLICY IF EXISTS "Users read own profile" ON public.profiles;
CREATE POLICY "Users read own profile" ON public.profiles
  FOR SELECT TO authenticated USING ((select auth.uid()) = id);
-- "Admins read all profiles" uses _current_user_role() (not auth.uid()) so
-- it's not flagged by the init-plan lint; left alone.

-- ── push_subscriptions ──
DROP POLICY IF EXISTS "Users manage own push subscriptions" ON public.push_subscriptions;
CREATE POLICY "Users manage own push subscriptions" ON public.push_subscriptions
  FOR ALL USING ((select auth.uid()) = user_id);

-- ── suggested_venues ──
DROP POLICY IF EXISTS "Users insert own" ON public.suggested_venues;
CREATE POLICY "Users insert own" ON public.suggested_venues
  FOR INSERT TO authenticated WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users read own" ON public.suggested_venues;
CREATE POLICY "Users read own" ON public.suggested_venues
  FOR SELECT TO authenticated USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users withdraw own" ON public.suggested_venues;
CREATE POLICY "Users withdraw own" ON public.suggested_venues
  FOR UPDATE TO authenticated
  USING (((select auth.uid()) = user_id) AND (status = 'pending'))
  WITH CHECK (status = 'withdrawn');

DROP POLICY IF EXISTS "Admins read all" ON public.suggested_venues;
CREATE POLICY "Admins read all" ON public.suggested_venues
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.id = (select auth.uid())
      AND profiles.role = ANY (ARRAY['admin', 'editor'])
  ));

DROP POLICY IF EXISTS "Admins update all" ON public.suggested_venues;
CREATE POLICY "Admins update all" ON public.suggested_venues
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.id = (select auth.uid())
      AND profiles.role = ANY (ARRAY['admin', 'editor'])
  ));

-- ── sun_alerts ──
DROP POLICY IF EXISTS "Users manage own alerts" ON public.sun_alerts;
CREATE POLICY "Users manage own alerts" ON public.sun_alerts
  FOR ALL USING ((select auth.uid()) = user_id);

-- ── user_preferences ──
DROP POLICY IF EXISTS "Users manage own preferences" ON public.user_preferences;
CREATE POLICY "Users manage own preferences" ON public.user_preferences
  FOR ALL USING ((select auth.uid()) = user_id);
