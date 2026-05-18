-- 031-notifications-ttl-cleanup.sql — nightly cleanup of old
-- notifications rows so the table doesn't grow forever.
--
-- The client caps its in-memory _bellHistory at 14 days, but the
-- notifications table itself keeps every row written by the SQL
-- triggers. Over months a heavy user accumulates thousands; one
-- bell-open fetches them all and the 14-day cap drops them on the
-- floor. Pure waste.
--
-- This migration adds:
--   - public.cleanup_old_notifications() — deletes rows older than
--     30 days. SECURITY DEFINER so it can DELETE for every user
--     (RLS would otherwise scope to current_user only).
--   - A pg_cron job that runs it nightly at 03:00 Europe/Oslo
--     (01:00 UTC at this time of year — close enough; we don't
--     need DST precision for a cleanup task).
--
-- Why 30 days: the client caps display at 14, so 30 leaves a 16-day
-- buffer for offline users coming back to a device. Older than that
-- and the row is dead weight even if they return.
--
-- Idempotent.

CREATE OR REPLACE FUNCTION public.cleanup_old_notifications()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_deleted int;
BEGIN
  DELETE FROM public.notifications
   WHERE created_at < now() - interval '30 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cleanup_old_notifications() FROM PUBLIC, anon, authenticated;

-- Unschedule any prior job under this name so re-applying the
-- migration replaces it cleanly.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'notifications-ttl-cleanup';
SELECT cron.schedule(
  'notifications-ttl-cleanup',
  '0 1 * * *',  -- 01:00 UTC daily (≈ 03:00 Europe/Oslo)
  $cmd$SELECT public.cleanup_old_notifications();$cmd$
);

NOTIFY pgrst, 'reload schema';
