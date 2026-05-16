-- 023-fk-creator-user-to-profiles.sql — re-point three FKs from
-- auth.users(id) to profiles(id) so PostgREST can resolve the
-- embed `creator:profiles!plans_creator_id_fkey(...)` style queries.
--
-- Root cause: plans.creator_id, plan_invites.user_id, checkins.user_id
-- all referenced auth.users(id). PostgREST embed syntax
-- `profiles!<fk_constraint_name>(...)` needs the FK to target the
-- embedded table. Since the FKs targeted auth.users, every embed
-- returned 400 ("could not find a relationship between plans and
-- profiles in the schema cache"). The js/auth.js loadPlans (and the
-- checkins query) couldn't populate _planInvites, which silently
-- broke every receiver-side invite flow in the app.
--
-- Why profiles instead of auth.users: profiles.id is itself constrained
-- to auth.users(id) (profiles_id_fkey, ON DELETE CASCADE). The cascade
-- chain is preserved: auth.users delete → profiles delete → plans /
-- plan_invites / checkins delete. Same effective behavior, just one
-- extra hop. Pre-flight integrity check confirmed zero orphans:
--
--     SELECT COUNT(*) FROM public.plans p
--     WHERE NOT EXISTS (SELECT 1 FROM public.profiles pr
--                       WHERE pr.id = p.creator_id);
--     -- → 0 (same for plan_invites.user_id and checkins.user_id)
--
-- Idempotent: each block drops the constraint if it exists, then
-- re-creates it. Safe to re-run.

-- plans.creator_id → profiles.id
ALTER TABLE public.plans
  DROP CONSTRAINT IF EXISTS plans_creator_id_fkey;
ALTER TABLE public.plans
  ADD  CONSTRAINT plans_creator_id_fkey
       FOREIGN KEY (creator_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- plan_invites.user_id → profiles.id
ALTER TABLE public.plan_invites
  DROP CONSTRAINT IF EXISTS plan_invites_user_id_fkey;
ALTER TABLE public.plan_invites
  ADD  CONSTRAINT plan_invites_user_id_fkey
       FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- checkins.user_id → profiles.id
ALTER TABLE public.checkins
  DROP CONSTRAINT IF EXISTS checkins_user_id_fkey;
ALTER TABLE public.checkins
  ADD  CONSTRAINT checkins_user_id_fkey
       FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- Force a PostgREST schema cache refresh so the new FK targets are
-- picked up immediately. NOTIFY is the standard Supabase pattern; the
-- PostgREST container listens for it.
NOTIFY pgrst, 'reload schema';
