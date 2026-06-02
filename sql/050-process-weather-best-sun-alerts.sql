-- 050-process-weather-best-sun-alerts.sql — server-side "today's best sun window" alert.
--
-- Replaces the client _evalBestSunWindow with a pg_cron job that runs every
-- 30 min from late morning. Same gates as the client:
--   * Only today, only if now < 18:00 Oslo.
--   * Find the hour with most sunny venues in [now, 21].
--   * Require best count >= 15 venues.
--   * Suppress when peak hour is rainy/overcast via weather_oslo.
--   * Peak must be meaningfully better than right now (1.3× count, or +5).
--   * Block extension: contiguous hours with count >= 70% of best.
--   * Skip if the block ends before now.
--
-- Bell-only (no push) — matches the client's `bellOnly: true`. The peak
-- hour is already visible in the slider + arc; the bell row gives users
-- a tappable "jump to peak" inbox entry without pinging the device.
--
-- Dedupes via bell UNIQUE — once per (user, day) with notif_id
-- 'weather_best_sun:<date>'.
--
-- Idempotent.

CREATE OR REPLACE FUNCTION public.process_weather_best_sun_alerts()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_today        date;
  v_now_hour     real;
  v_start_h      int;
  v_h            int;
  v_cnt          int;
  v_best_h       int := -1;
  v_best_cnt    int := 0;
  v_now_cnt     int := 0;
  v_bucket       text;
  v_block_start int;
  v_block_end   int;
  v_threshold    real;
  v_notif_id     text;
  v_from_str    text;
  v_to_str      text;
  v_body         text;
BEGIN
  v_today := (now() AT TIME ZONE 'Europe/Oslo')::date;
  v_now_hour := EXTRACT(hour FROM (now() AT TIME ZONE 'Europe/Oslo'))::real
              + (EXTRACT(minute FROM (now() AT TIME ZONE 'Europe/Oslo'))::real / 60.0);

  -- Too late for a peak to be actionable.
  IF v_now_hour >= 18 THEN RETURN; END IF;

  v_start_h := GREATEST(6, ceil(v_now_hour)::int);

  -- "Now" count for the 1.3× / +5 meaningful-better check.
  SELECT COUNT(*) INTO v_now_cnt
  FROM public.venue_sun_windows vsw
  WHERE vsw.for_date = v_today
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(vsw.windows) AS w
      WHERE (w->>'start')::real <= v_start_h AND (w->>'end')::real >= v_start_h
    );

  -- Find best hour in [start, 21].
  FOR v_h IN v_start_h .. 21 LOOP
    SELECT COUNT(*) INTO v_cnt
    FROM public.venue_sun_windows vsw
    WHERE vsw.for_date = v_today
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(vsw.windows) AS w
        WHERE (w->>'start')::real <= v_h AND (w->>'end')::real >= v_h
      );
    IF v_cnt > v_best_cnt THEN
      v_best_cnt := v_cnt;
      v_best_h := v_h;
    END IF;
  END LOOP;

  IF v_best_h < 0 OR v_best_cnt < 15 THEN RETURN; END IF;

  -- Weather gate at peak hour.
  v_bucket := public.wx_bucket(public.oslo_hour_bucket(v_today, v_best_h::real));
  IF v_bucket IN ('regn', 'skyer') THEN RETURN; END IF;

  -- Peak must be meaningfully better than right now.
  IF v_best_cnt < v_now_cnt * 1.3 AND v_best_cnt - v_now_cnt < 5 THEN RETURN; END IF;

  v_threshold := v_best_cnt::real * 0.7;

  -- Block expansion: walk backward from best_h.
  v_block_start := v_best_h;
  FOR v_h IN REVERSE v_best_h-1 .. v_start_h LOOP
    SELECT COUNT(*) INTO v_cnt
    FROM public.venue_sun_windows vsw
    WHERE vsw.for_date = v_today
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(vsw.windows) AS w
        WHERE (w->>'start')::real <= v_h AND (w->>'end')::real >= v_h
      );
    IF v_cnt::real >= v_threshold THEN v_block_start := v_h; ELSE EXIT; END IF;
  END LOOP;

  -- Block expansion: walk forward.
  v_block_end := v_best_h;
  FOR v_h IN v_best_h+1 .. 21 LOOP
    SELECT COUNT(*) INTO v_cnt
    FROM public.venue_sun_windows vsw
    WHERE vsw.for_date = v_today
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(vsw.windows) AS w
        WHERE (w->>'start')::real <= v_h AND (w->>'end')::real >= v_h
      );
    IF v_cnt::real >= v_threshold THEN v_block_end := v_h; ELSE EXIT; END IF;
  END LOOP;

  -- Block ends in the past?
  IF v_block_end::real <= v_now_hour THEN RETURN; END IF;

  v_notif_id := 'weather_best_sun:' || to_char(v_today, 'YYYY-MM-DD');
  v_from_str := LPAD(v_block_start::text, 2, '0') || ':00';
  v_to_str   := LPAD(v_block_end::text, 2, '0') || ':00';
  v_body := 'Mest sol i dag er mellom ' || v_from_str || ' og ' || v_to_str || '.';

  -- Fan out to active users with weather notifs enabled.
  INSERT INTO public.notifications (user_id, notif_id, category, body, lead, nav)
  SELECT
    p.id,
    v_notif_id,
    'weather',
    v_body,
    jsonb_build_object(
      'type',     'sys',
      'icon',     'sun',
      'bodyKey',  'notif_best_sun_body',
      'bodyVars', jsonb_build_object('from', v_from_str, 'to', v_to_str, 'hour', v_from_str)
    ),
    jsonb_build_object('kind', 'calendar', 'peakHour', v_block_start)
  FROM public.profiles p
  LEFT JOIN public.user_preferences up ON up.user_id = p.id
  WHERE COALESCE((up.notif_prefs->>'weather')::boolean, true) = true
    AND COALESCE(p.last_seen_at, p.created_at) > now() - interval '90 days'
  ON CONFLICT (user_id, notif_id) DO NOTHING;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.process_weather_best_sun_alerts() FROM PUBLIC, anon, authenticated;

-- Every 30 min. Internal 18:00 Oslo guard skips the late-day ticks; the
-- early-morning ticks won't find a useful peak yet but they're cheap.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'process-weather-best-sun-alerts';
SELECT cron.schedule(
  'process-weather-best-sun-alerts',
  '*/30 * * * *',
  $cmd$SELECT public.process_weather_best_sun_alerts();$cmd$
);

NOTIFY pgrst, 'reload schema';
