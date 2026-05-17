-- 029-plan-reminders.sql — scheduled reminder push + in-app notif for
-- plans whose meet time is approaching. Reminds three audiences:
--
--   * Creator        — "Planen din på <venue> starter om 30 min."
--   * Accepted invitee — "Du skal til <venue> om 30 min."
--   * Pending invitee  — "<creator>s plan på <venue> starter om 30 min."
--
-- Implementation: pg_cron schedules public.process_plan_reminders()
-- every 5 minutes. The function finds plans starting in 25–35 min
-- (matches the 5-min cron interval — wider window = drift tolerance)
-- that haven't fired a reminder yet, writes notification rows + push
-- payloads, then stamps plans.reminder_sent_at so re-runs skip it.
--
-- Declined invitees: skipped. The user is opting out; a "starts soon"
-- ping reads as pressure.
-- Cancelled plans: skipped (cancelled_at IS NOT NULL).
--
-- Idempotent.

-- ─── Enable pg_cron ─────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;

-- ─── Reminder fan-out function ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.process_plan_reminders()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  p              public.plans%ROWTYPE;
  v_creator_name TEXT;
  v_venue        TEXT;
  v_recip_id     uuid;
  v_status       text;
  v_body         text;
  v_lead_body    text;
  v_payload      jsonb;
BEGIN
  FOR p IN
    SELECT *
    FROM public.plans
    WHERE cancelled_at IS NULL
      AND reminder_sent_at IS NULL
      AND planned_at > now() + interval '25 minutes'
      AND planned_at < now() + interval '35 minutes'
  LOOP
    v_creator_name := public.notif_user_name(p.creator_id);
    v_venue        := COALESCE(p.venue_name, 'et sted');

    -- ── Creator reminder ─────────────────────────────────────────────
    v_body := 'Planen din på <strong>' || v_venue || '</strong> starter om 30 min.';
    INSERT INTO public.notifications (user_id, notif_id, category, body, lead, nav)
    VALUES (
      p.creator_id,
      'plan_reminder_creator:' || p.id,
      'social',
      v_body,
      jsonb_build_object('type', 'glyph', 'icon', '⏰'),
      jsonb_build_object('kind', 'plan', 'venueId', p.venue_id, 'plannedAt', p.planned_at)
    )
    ON CONFLICT (user_id, notif_id) DO NOTHING;

    v_payload := jsonb_build_object(
      'user_id', p.creator_id,
      'payload', jsonb_build_object(
        'title', 'Shades',
        'body',  'Planen din på ' || v_venue || ' starter om 30 min.',
        'url',   '/',
        'tag',   'plan_reminder_creator_' || p.id::text
      )
    );
    PERFORM net.http_post(
      url     := 'https://wxalqodaeqgzahwlovnw.supabase.co/functions/v1/send-push',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind4YWxxb2RhZXFnemFod2xvdm53Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxODcyNDYsImV4cCI6MjA5MTc2MzI0Nn0.RzP2Fsft1yqTt7Hg-u2t1UnGLE7FvFBoG88mKstUJgo'
      ),
      body    := v_payload
    );

    -- ── Invitee reminders (status-aware copy) ───────────────────────
    FOR v_recip_id, v_status IN
      SELECT pi.user_id, pi.status
      FROM public.plan_invites pi
      WHERE pi.plan_id = p.id
        AND pi.status IN ('accepted', 'pending')
    LOOP
      IF v_status = 'accepted' THEN
        v_body := 'Du skal til <strong>' || v_venue || '</strong> om 30 min.';
        v_lead_body := 'Du skal til ' || v_venue || ' om 30 min.';
      ELSE
        v_body := '<strong>' || v_creator_name || '</strong>s plan på <strong>' || v_venue || '</strong> starter om 30 min.';
        v_lead_body := v_creator_name || 's plan på ' || v_venue || ' starter om 30 min.';
      END IF;

      INSERT INTO public.notifications (user_id, notif_id, category, body, lead, nav)
      VALUES (
        v_recip_id,
        'plan_reminder_invitee:' || p.id,
        'social',
        v_body,
        jsonb_build_object('type', 'glyph', 'icon', '⏰'),
        jsonb_build_object('kind', 'plan', 'venueId', p.venue_id, 'plannedAt', p.planned_at)
      )
      ON CONFLICT (user_id, notif_id) DO NOTHING;

      v_payload := jsonb_build_object(
        'user_id', v_recip_id,
        'payload', jsonb_build_object(
          'title', 'Shades',
          'body',  v_lead_body,
          'url',   '/',
          'tag',   'plan_reminder_invitee_' || p.id::text
        )
      );
      PERFORM net.http_post(
        url     := 'https://wxalqodaeqgzahwlovnw.supabase.co/functions/v1/send-push',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind4YWxxb2RhZXFnemFod2xvdm53Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxODcyNDYsImV4cCI6MjA5MTc2MzI0Nn0.RzP2Fsft1yqTt7Hg-u2t1UnGLE7FvFBoG88mKstUJgo'
        ),
        body    := v_payload
      );
    END LOOP;

    -- Stamp so the next cron tick skips this plan.
    UPDATE public.plans SET reminder_sent_at = now() WHERE id = p.id;
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.process_plan_reminders() FROM PUBLIC, anon, authenticated;

-- ─── Schedule via pg_cron ───────────────────────────────────────────
-- Every 5 minutes. Idempotent: drop any prior job with the same name
-- first so re-running this migration replaces the schedule cleanly.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'plan-reminders';
SELECT cron.schedule(
  'plan-reminders',
  '*/5 * * * *',
  $cmd$SELECT public.process_plan_reminders();$cmd$
);

NOTIFY pgrst, 'reload schema';
