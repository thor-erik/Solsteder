-- 021-is-plan-creator.sql — SECURITY DEFINER helper to break the
-- plans ⇄ plan_invites RLS recursion that 020's split couldn't fix.
--
-- Postgres's recursion detector is structural: even with plan_invites
-- SELECT split into two permissive policies, the creator policy still
-- references plans (which references plan_invites), and Postgres flags
-- the chain at plan time without giving short-circuit evaluation a
-- chance.
--
-- Fix: route the creator check through a SECURITY DEFINER function.
-- The function bypasses RLS on its inner SELECT (runs as owner =
-- postgres), so plan_invites policies no longer reference plans at
-- the RLS layer.
--
-- Locked down: EXECUTE granted only to authenticated (RLS needs to
-- call it). anon and PUBLIC are revoked.
--
-- Idempotent.

CREATE OR REPLACE FUNCTION public.is_plan_creator(p uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.plans
    WHERE id = p AND creator_id = (SELECT auth.uid())
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_plan_creator(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.is_plan_creator(uuid) TO authenticated;

-- Rewrite the four plan_invites policies to use the helper instead of
-- an inline EXISTS on plans.
DROP POLICY IF EXISTS "plan_invites_select_creator" ON public.plan_invites;
CREATE POLICY "plan_invites_select_creator" ON public.plan_invites
  FOR SELECT USING (public.is_plan_creator(plan_id));

DROP POLICY IF EXISTS "plan_invites_update_creator" ON public.plan_invites;
CREATE POLICY "plan_invites_update_creator" ON public.plan_invites
  FOR UPDATE USING (public.is_plan_creator(plan_id));

DROP POLICY IF EXISTS "plan_invites_insert" ON public.plan_invites;
CREATE POLICY "plan_invites_insert" ON public.plan_invites
  FOR INSERT WITH CHECK (public.is_plan_creator(plan_id));

DROP POLICY IF EXISTS "plan_invites_delete" ON public.plan_invites;
CREATE POLICY "plan_invites_delete" ON public.plan_invites
  FOR DELETE USING (public.is_plan_creator(plan_id));
