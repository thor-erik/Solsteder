-- 043-events-bind-user-id.sql — bind events.user_id to auth.uid().
--
-- The "anon_insert" RLS policy from sql/create-events-table.sql lets any
-- session INSERT with any user_id value:
--
--   create policy "anon_insert" on events for insert with check (true);
--
-- That leaves analytics attribution forgeable: an anonymous client can
-- claim user_id = '<some-other-uuid>' and the row is recorded as theirs.
-- sql/035-events-size-caps caps row size, but does nothing about identity.
--
-- This migration adds a BEFORE INSERT trigger that overwrites NEW.user_id
-- with auth.uid(). For honest clients (anon → NULL, signed-in → own uid)
-- this is a no-op — the value they were sending equals the override. For
-- forged inserts the trigger silently corrects the attribution.
--
-- We keep the existing "anon_insert" RLS policy as-is so the analytics
-- flow (anonymous page-load tracking + signed-in event tracking) keeps
-- working. The trigger is the identity gate; RLS still gates whether the
-- INSERT happens at all.
--
-- Idempotent.

CREATE OR REPLACE FUNCTION public._events_force_uid()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.user_id := auth.uid();
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public._events_force_uid() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS events_force_uid_trg ON public.events;
CREATE TRIGGER events_force_uid_trg
  BEFORE INSERT ON public.events
  FOR EACH ROW
  EXECUTE FUNCTION public._events_force_uid();

NOTIFY pgrst, 'reload schema';
