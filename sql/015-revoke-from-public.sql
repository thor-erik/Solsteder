-- 015-revoke-from-public.sql — finish what 014.B started.
--
-- Postgres grants EXECUTE on functions to PUBLIC by default. Migration
-- 014 revoked from anon+authenticated, but PUBLIC still held EXECUTE,
-- which transitively grants to every role. The advisor caught it.
--
-- After this migration, the trigger/helper functions are callable only
-- by service_role (which Supabase grants automatically) and the postgres
-- superuser — which is what we want, since they fire from triggers and
-- internal RPC, never from anon/authenticated REST calls.
--
-- _current_user_role() is intentionally left callable by authenticated
-- because RLS policies invoke it (the policy expression is evaluated as
-- the calling user, so it needs EXECUTE permission). Anon should never
-- need it.
--
-- Idempotent.

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
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated',
                   fn.proname, fn.args);
  END LOOP;
END $$;

REVOKE EXECUTE ON FUNCTION public._current_user_role() FROM PUBLIC, anon;
