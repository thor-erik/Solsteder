-- 016-consolidate-policies.sql — eliminate overlapping permissive RLS
-- policies flagged by the performance advisor.
--
-- Each table below has multiple PERMISSIVE policies that match the same
-- (role, action). Postgres evaluates them ALL on every row, even though
-- only one needs to pass. Merging them into a single OR-combined policy
-- per action cuts the per-row work and clears the lint.
--
-- Same time: drop public._current_user_role() (SECURITY DEFINER, anon-
-- and authenticated-callable). The only two callers — both on profiles
-- — get the role check inlined, so the function disappears entirely
-- rather than being patched to SECURITY INVOKER.
--
-- All policy semantics preserved exactly. Idempotent: every DROP uses
-- IF EXISTS, every CREATE replaces a known prior version.

-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║ checkins                                                               ║
-- ║   Was: "Friends see active" (SELECT) + "Users manage own" (ALL)        ║
-- ║   Now: 1 SELECT (own OR active-friend) + 3 modify (own)                ║
-- ║                                                                        ║
-- ║   Behavioural diff: none.                                              ║
-- ║   - Own rows: still readable regardless of expiry (covered by          ║
-- ║     auth.uid() = user_id in the new SELECT, was covered by             ║
-- ║     "Users manage own" before).                                        ║
-- ║   - Friend rows: still only readable while active.                     ║
-- ╚════════════════════════════════════════════════════════════════════════╝
DROP POLICY IF EXISTS "Friends see active checkins" ON public.checkins;
DROP POLICY IF EXISTS "Users manage own checkins"   ON public.checkins;

CREATE POLICY "checkins_select" ON public.checkins
  FOR SELECT
  USING (
    ((select auth.uid()) = user_id) OR
    ((expires_at > now()) AND EXISTS (
      SELECT 1 FROM public.friendships
      WHERE friendships.status = 'accepted'
        AND ((friendships.user_id = (select auth.uid()) AND friendships.friend_id = checkins.user_id)
          OR (friendships.friend_id = (select auth.uid()) AND friendships.user_id = checkins.user_id))
    ))
  );

CREATE POLICY "checkins_insert" ON public.checkins
  FOR INSERT WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "checkins_update" ON public.checkins
  FOR UPDATE USING ((select auth.uid()) = user_id);
CREATE POLICY "checkins_delete" ON public.checkins
  FOR DELETE USING ((select auth.uid()) = user_id);

-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║ plan_invites                                                           ║
-- ║   Was: "Invitees see own" (SELECT) +                                   ║
-- ║        "Invitees update own status" (UPDATE) +                         ║
-- ║        "Plan creator manages invites" (ALL)                            ║
-- ║   Now: 1 policy per action, OR-combining the two paths where needed.   ║
-- ╚════════════════════════════════════════════════════════════════════════╝
DROP POLICY IF EXISTS "Invitees see own invites"      ON public.plan_invites;
DROP POLICY IF EXISTS "Invitees update own status"    ON public.plan_invites;
DROP POLICY IF EXISTS "Plan creator manages invites"  ON public.plan_invites;

CREATE POLICY "plan_invites_select" ON public.plan_invites
  FOR SELECT
  USING (
    ((select auth.uid()) = user_id) OR
    EXISTS (
      SELECT 1 FROM public.plans
      WHERE plans.id = plan_invites.plan_id AND plans.creator_id = (select auth.uid())
    )
  );

CREATE POLICY "plan_invites_insert" ON public.plan_invites
  FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.plans
    WHERE plans.id = plan_invites.plan_id AND plans.creator_id = (select auth.uid())
  ));

CREATE POLICY "plan_invites_update" ON public.plan_invites
  FOR UPDATE
  USING (
    ((select auth.uid()) = user_id) OR
    EXISTS (
      SELECT 1 FROM public.plans
      WHERE plans.id = plan_invites.plan_id AND plans.creator_id = (select auth.uid())
    )
  );

CREATE POLICY "plan_invites_delete" ON public.plan_invites
  FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.plans
    WHERE plans.id = plan_invites.plan_id AND plans.creator_id = (select auth.uid())
  ));

-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║ profiles                                                               ║
-- ║   Was: 4 policies — "Enable read access for all users" (anon+auth,     ║
-- ║        USING true), "Users read own", "Admins read all profiles",      ║
-- ║        "Admins update profiles".                                       ║
-- ║   Now: keep the public-read policy (load-bearing for the anon          ║
-- ║        invite-link experience — anon's restriction is enforced by      ║
-- ║        column-level grants, not RLS). Drop the two redundant SELECT    ║
-- ║        policies. Rewrite the admin UPDATE to inline the role lookup    ║
-- ║        instead of calling _current_user_role().                        ║
-- ╚════════════════════════════════════════════════════════════════════════╝
DROP POLICY IF EXISTS "Users read own profile"   ON public.profiles;
DROP POLICY IF EXISTS "Admins read all profiles" ON public.profiles;
DROP POLICY IF EXISTS "Admins update profiles"   ON public.profiles;

CREATE POLICY "Admins update profiles" ON public.profiles
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = (select auth.uid()) AND p.role = 'admin'
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = (select auth.uid()) AND p.role = 'admin'
  ));

-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║ suggested_venues                                                       ║
-- ║   Was: SELECT × 3 (Public reads approved, Users read own, Admins read  ║
-- ║        all) + UPDATE × 2 (Users withdraw own, Admins update all) +     ║
-- ║        INSERT × 1.                                                     ║
-- ║   Now: 1 SELECT, 1 UPDATE, 1 INSERT. INSERT policy unchanged.          ║
-- ╚════════════════════════════════════════════════════════════════════════╝
DROP POLICY IF EXISTS "Public reads approved" ON public.suggested_venues;
DROP POLICY IF EXISTS "Users read own"        ON public.suggested_venues;
DROP POLICY IF EXISTS "Admins read all"       ON public.suggested_venues;
DROP POLICY IF EXISTS "Users withdraw own"    ON public.suggested_venues;
DROP POLICY IF EXISTS "Admins update all"     ON public.suggested_venues;

CREATE POLICY "suggested_venues_select" ON public.suggested_venues
  FOR SELECT
  USING (
    (status = 'approved') OR
    ((select auth.uid()) = user_id) OR
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = (select auth.uid())
        AND profiles.role = ANY (ARRAY['admin', 'editor'])
    )
  );

CREATE POLICY "suggested_venues_update" ON public.suggested_venues
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = (select auth.uid())
        AND profiles.role = ANY (ARRAY['admin', 'editor'])
    )
    OR (((select auth.uid()) = user_id) AND (status = 'pending'))
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = (select auth.uid())
        AND profiles.role = ANY (ARRAY['admin', 'editor'])
    )
    OR (status = 'withdrawn')
  );

-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║ Drop _current_user_role() — no longer referenced after the profile     ║
-- ║ policy rewrite above. This also clears the last                        ║
-- ║ authenticated_security_definer_function_executable advisor warning.    ║
-- ╚════════════════════════════════════════════════════════════════════════╝
DROP FUNCTION IF EXISTS public._current_user_role();
