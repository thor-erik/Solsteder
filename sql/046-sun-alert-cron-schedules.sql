-- 046-sun-alert-cron-schedules.sql — pg_cron schedules that drive the
-- two §5a support edge functions.
--
--   * fetch-weather    — every 30 min. Hits met.no, populates weather_oslo.
--   * sync-sun-windows — daily at 03:30 UTC (~04:30/05:30 Oslo). Pulls
--                        https://findshades.app/data/sun-windows.json
--                        (committed by the update-sun-windows GH Action
--                        at 02:30 UTC) into venue_sun_windows.
--
-- Both functions gate on PUSH_TRIGGER_SECRET (same secret as send-push from
-- sql/037 — reused so we don't multiply trigger secrets). The cron's
-- net.http_post pulls the URL+secret from _app_settings, then layers in the
-- function-specific suffix.
--
-- The process_sun_alerts cron (every 5 min) is scheduled separately in
-- sql/047 once the function exists.
--
-- Idempotent.

-- Add edge function URLs to _app_settings so we don't hardcode in cron rows.
INSERT INTO public._app_settings (key, value) VALUES
  ('fetch_weather_url',    'https://wxalqodaeqgzahwlovnw.supabase.co/functions/v1/fetch-weather'),
  ('sync_sun_windows_url', 'https://wxalqodaeqgzahwlovnw.supabase.co/functions/v1/sync-sun-windows')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║ Helper: invoke a §5a edge function with the shared trigger secret.     ║
-- ╚════════════════════════════════════════════════════════════════════════╝
CREATE OR REPLACE FUNCTION public._call_edge(p_url_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_url    text;
  v_bearer text;
  v_secret text;
BEGIN
  SELECT value INTO v_url    FROM public._app_settings WHERE key = p_url_key;
  SELECT value INTO v_bearer FROM public._app_settings WHERE key = 'send_push_bearer';
  SELECT value INTO v_secret FROM public._app_settings WHERE key = 'send_push_secret';

  IF v_url IS NULL OR v_bearer IS NULL OR v_secret IS NULL THEN
    RAISE EXCEPTION '_call_edge: missing _app_settings (% / bearer / secret)', p_url_key;
  END IF;

  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type',    'application/json',
      'Authorization',   'Bearer ' || v_bearer,
      'X-Push-Secret',   v_secret
    ),
    body    := '{}'::jsonb
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public._call_edge(text) FROM PUBLIC, anon, authenticated;

-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║ Schedules                                                               ║
-- ╚════════════════════════════════════════════════════════════════════════╝

-- fetch-weather every 30 min.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'fetch-weather';
SELECT cron.schedule(
  'fetch-weather',
  '*/30 * * * *',
  $cmd$SELECT public._call_edge('fetch_weather_url');$cmd$
);

-- sync-sun-windows daily at 03:30 UTC (1h after the GH Action's 02:30 commit).
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'sync-sun-windows';
SELECT cron.schedule(
  'sync-sun-windows',
  '30 3 * * *',
  $cmd$SELECT public._call_edge('sync_sun_windows_url');$cmd$
);

NOTIFY pgrst, 'reload schema';
