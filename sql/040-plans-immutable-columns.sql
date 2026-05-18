-- 040-plans-immutable-columns.sql — block creator-driven UPDATEs to plan
-- columns that should be set-once at create time.
--
-- The "Creator updates own plan" RLS policy from sql/026 grants the creator
-- unrestricted UPDATE access to the row. That was added so plan_cancellation
-- could set cancelled_at via a normal client UPDATE, but the policy can't
-- restrict to a column list (Postgres RLS doesn't support column-level
-- WITH CHECK). Consequence: the creator can change creator_id, venue_id,
-- venue_name, planned_at on a plan that's already been responded to —
-- including planting attacker-controlled venue_name HTML into bodies the
-- bell-trigger will write into invitees' notifications inboxes (the
-- companion XSS hole from C3/C4).
--
-- This migration adds a BEFORE UPDATE trigger that rejects writes to
-- those columns. Allowed mutations: cancelled_at, reminder_sent_at, message.
-- All other columns are immutable post-insert.
--
-- The trigger fires regardless of caller role so process_plan_reminders
-- (which runs as SECURITY DEFINER and sets reminder_sent_at) is unaffected
-- — that column stays mutable. cron.schedule runs as postgres, which would
-- bypass RLS but NOT triggers; the allowlisted-column approach explicitly
-- permits its update.
--
-- Idempotent.

CREATE OR REPLACE FUNCTION public.plans_block_immutable_changes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.id          IS DISTINCT FROM OLD.id          THEN RAISE EXCEPTION 'plans.id is immutable'; END IF;
  IF NEW.creator_id  IS DISTINCT FROM OLD.creator_id  THEN RAISE EXCEPTION 'plans.creator_id is immutable'; END IF;
  IF NEW.venue_id    IS DISTINCT FROM OLD.venue_id    THEN RAISE EXCEPTION 'plans.venue_id is immutable'; END IF;
  IF NEW.venue_name  IS DISTINCT FROM OLD.venue_name  THEN RAISE EXCEPTION 'plans.venue_name is immutable'; END IF;
  IF NEW.planned_at  IS DISTINCT FROM OLD.planned_at  THEN RAISE EXCEPTION 'plans.planned_at is immutable'; END IF;
  IF NEW.created_at  IS DISTINCT FROM OLD.created_at  THEN RAISE EXCEPTION 'plans.created_at is immutable'; END IF;
  -- Allowed-to-change columns (not enumerated here, just not rejected):
  --   cancelled_at      — set by cancelPlan via creator UPDATE
  --   reminder_sent_at  — set by process_plan_reminders (cron)
  --   message           — currently never edited, but harmless if it ever is
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS plans_block_immutable_changes ON public.plans;
CREATE TRIGGER plans_block_immutable_changes
  BEFORE UPDATE ON public.plans
  FOR EACH ROW
  EXECUTE FUNCTION public.plans_block_immutable_changes();

REVOKE EXECUTE ON FUNCTION public.plans_block_immutable_changes() FROM PUBLIC, anon, authenticated;
