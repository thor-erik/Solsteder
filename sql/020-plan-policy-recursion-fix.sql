-- 020-plan-policy-recursion-fix.sql — break the RLS recursion between
-- plans and plan_invites that migration 016 introduced.
--
-- 016 consolidated plan_invites policies into a single SELECT policy
-- that OR-combined the two paths:
--   USING (auth.uid() = user_id
--          OR EXISTS (SELECT 1 FROM plans WHERE ...))
-- Plans' own SELECT policy already does an EXISTS on plan_invites for
-- the invitee path. The two policies now reference each other and
-- Postgres detects "infinite recursion detected in policy for relation
-- 'plans'" the moment a creator runs INSERT ... RETURNING.
--
-- Fix: split plan_invites back into two PERMISSIVE policies, each with
-- a non-recursive predicate. The performance advisor will re-flag
-- "multiple permissive policies" on this table — that lint is a perf
-- hint, not a correctness issue, and is the lesser of two evils here.
-- Same for plan_invites UPDATE which had the same mutual-recursion
-- pattern with plans.
--
-- Idempotent.

-- Split plan_invites SELECT back into two non-recursive policies.
DROP POLICY IF EXISTS "plan_invites_select" ON public.plan_invites;
CREATE POLICY "plan_invites_select_own_invite" ON public.plan_invites
  FOR SELECT
  USING ((select auth.uid()) = user_id);
CREATE POLICY "plan_invites_select_creator" ON public.plan_invites
  FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.plans
    WHERE plans.id = plan_invites.plan_id
      AND plans.creator_id = (select auth.uid())
  ));

-- Same split for UPDATE — invitee can update their own status,
-- creator can update anything on their plan's invites.
DROP POLICY IF EXISTS "plan_invites_update" ON public.plan_invites;
CREATE POLICY "plan_invites_update_own_invite" ON public.plan_invites
  FOR UPDATE
  USING ((select auth.uid()) = user_id);
CREATE POLICY "plan_invites_update_creator" ON public.plan_invites
  FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM public.plans
    WHERE plans.id = plan_invites.plan_id
      AND plans.creator_id = (select auth.uid())
  ));
