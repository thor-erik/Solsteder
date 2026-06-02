-- 049-process-weather-no-sun-alerts.sql — server-side "no more sun today" alert.
--
-- Replaces the client _evalNoSunToday loop with a pg_cron job that:
--   * Checks once every 30 min from noon Oslo onwards.
--   * If NO venue in venue_sun_windows has a window ending after now-hour
--     (city-wide: sun is done for the day), writes a bell row for every
--     active user whose notif_prefs.weather isn't explicitly false.
--   * Dedupes via the bell UNIQUE constraint — once per (user, day).
--
-- This is bell-only (no push) — matches the client's `bellOnly: true`
-- behavior. The empty venue list already shows "no sun" visually, so a
-- push would be redundant noise. The bell row gives users an inbox entry
-- so they know what happened if they check.
--
-- Side fix: ALTER user_preferences ADD COLUMN notif_prefs JSONB. The
-- client (notifications.js:118) has been calling
-- saveUserPreference('notif_prefs', settings) for months, silently
-- failing because the column didn't exist. This migration adds it so
-- the client persistence finally works; previously-toggled settings
-- (only in localStorage) won't migrate, but most users never toggle.
--
-- Idempotent.

-- Side fix: add the column the client has been trying to write to.
ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS notif_prefs JSONB DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION public.process_weather_no_sun_alerts()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_today    date;
  v_now_hour real;
  v_any_sun  boolean;
  v_notif_id text;
BEGIN
  v_today := (now() AT TIME ZONE 'Europe/Oslo')::date;
  v_now_hour := EXTRACT(hour FROM (now() AT TIME ZONE 'Europe/Oslo'))::real
              + (EXTRACT(minute FROM (now() AT TIME ZONE 'Europe/Oslo'))::real / 60.0);

  -- Skip the morning — "no sun today" before noon is just sunrise.
  IF v_now_hour < 12 THEN RETURN; END IF;

  -- City-wide: does ANY venue still have a window ending after now-hour?
  SELECT EXISTS (
    SELECT 1
    FROM public.venue_sun_windows vsw,
         jsonb_array_elements(vsw.windows) AS w
    WHERE vsw.for_date = v_today
      AND (w->>'end')::real > v_now_hour
  ) INTO v_any_sun;

  IF v_any_sun THEN RETURN; END IF;

  v_notif_id := 'weather_no_sun:' || to_char(v_today, 'YYYY-MM-DD');

  -- Fan out to active users with weather notifs enabled (default true if
  -- no row in user_preferences yet — matches the client default).
  INSERT INTO public.notifications (user_id, notif_id, category, body, lead, nav)
  SELECT
    p.id,
    v_notif_id,
    'weather',
    'Ikke mer sol i Oslo i dag. Prøv en annen dag?',
    jsonb_build_object(
      'type',     'sys',
      'icon',     'rain',
      'bodyKey',  'notif_no_sun_body',
      'bodyVars', '{}'::jsonb
    ),
    jsonb_build_object('kind', 'calendar')
  FROM public.profiles p
  LEFT JOIN public.user_preferences up ON up.user_id = p.id
  WHERE COALESCE((up.notif_prefs->>'weather')::boolean, true) = true
    -- Active within last 90 days — avoid bell pollution for dormant accounts.
    -- last_seen_at is bumped via sql/017's on_auth_user_load trigger.
    AND COALESCE(p.last_seen_at, p.created_at) > now() - interval '90 days'
  ON CONFLICT (user_id, notif_id) DO NOTHING;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.process_weather_no_sun_alerts() FROM PUBLIC, anon, authenticated;

-- Every 30 min — internal noon-Oslo guard skips the morning ticks.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'process-weather-no-sun-alerts';
SELECT cron.schedule(
  'process-weather-no-sun-alerts',
  '*/30 * * * *',
  $cmd$SELECT public.process_weather_no_sun_alerts();$cmd$
);

NOTIFY pgrst, 'reload schema';
