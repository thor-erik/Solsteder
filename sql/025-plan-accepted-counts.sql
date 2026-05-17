-- 025-plan-accepted-counts.sql — SECURITY DEFINER helper that returns
-- the accepted-invitee count per plan. Lets a user (who's only an
-- invitee, not the creator) see how many OTHER people have already
-- said yes — needed for the bell-inbox row wording on a plan you've
-- accepted: "Du skal til Starbucks i morgen kl 12 med Malene +2".
--
-- Why SECURITY DEFINER: plan_invites RLS lets you SELECT only your own
-- invite row (plan_invites_select_own_invite). Counting OTHER invitees'
-- statuses would require either looser RLS (privacy regression: any
-- invitee can see every other invitee's identity AND status) or this
-- helper, which returns a single aggregate per plan without leaking
-- identities.
--
-- Authorization: the helper restricts results to plans the caller is
-- either the creator of OR an invitee on. Anyone calling it for a plan
-- they have no relationship with gets nothing (filtered out).
--
-- Idempotent.

CREATE OR REPLACE FUNCTION public.plan_accepted_counts(plan_ids uuid[])
RETURNS TABLE (plan_id uuid, count int)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
STABLE
AS $$
  WITH visible AS (
    SELECT p.id
    FROM public.plans p
    WHERE p.id = ANY(plan_ids)
      AND (
        p.creator_id = (SELECT auth.uid())
        OR EXISTS (
          SELECT 1 FROM public.plan_invites pi
          WHERE pi.plan_id = p.id
            AND pi.user_id = (SELECT auth.uid())
        )
      )
  )
  SELECT pi.plan_id, COUNT(*)::int
  FROM public.plan_invites pi
  JOIN visible v ON v.id = pi.plan_id
  WHERE pi.status = 'accepted'
  GROUP BY pi.plan_id;
$$;

REVOKE EXECUTE ON FUNCTION public.plan_accepted_counts(uuid[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.plan_accepted_counts(uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
