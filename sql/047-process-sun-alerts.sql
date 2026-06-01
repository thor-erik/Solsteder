-- 047-process-sun-alerts.sql — server-side sun-alert evaluator.
--
-- Replaces the 60-second client _evalSunAlerts loop with a pg_cron job that
-- runs every 5 min and joins the three §5a tables:
--
--   sun_alerts × venue_sun_windows(today) × weather_oslo(window-start hour)
--
-- For each enabled subscription whose venue has an upcoming raw window
-- starting within notify_minutes_before AND where weather at that hour is
-- neither rainy nor overcast, write the bell row + fire push. ON CONFLICT
-- (user_id, notif_id) DO NOTHING dedupes across cron ticks.
--
-- venue_name is denormalized onto sun_alerts (added here, NOT NULL going
-- forward) — the server has no access to venues.json so the push body
-- needs the name inlined. Zero rows in prod today so no backfill needed.
--
-- Idempotent.

-- Denormalize venue_name on sun_alerts.
ALTER TABLE public.sun_alerts ADD COLUMN IF NOT EXISTS venue_name text;

-- Process function.
CREATE OR REPLACE FUNCTION public.process_sun_alerts()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_today        date;
  sa             record;
  w_entry        jsonb;
  v_win_start_h  real;
  v_win_start_ts timestamptz;
  v_min_until    int;
  v_max_min      int;
  v_bucket       text;
  v_body         text;
  v_lead         jsonb;
  v_notif_id     text;
  v_inserted     int;
BEGIN
  v_today := (now() AT TIME ZONE 'Europe/Oslo')::date;

  FOR sa IN
    SELECT s.user_id, s.venue_id, s.venue_name, s.notify_minutes_before, vsw.windows
    FROM public.sun_alerts s
    JOIN public.venue_sun_windows vsw
      ON vsw.venue_id = s.venue_id AND vsw.for_date = v_today
    WHERE s.enabled = TRUE
      AND s.venue_name IS NOT NULL
  LOOP
    v_max_min := COALESCE(sa.notify_minutes_before, 30);

    FOR w_entry IN SELECT * FROM jsonb_array_elements(sa.windows)
    LOOP
      v_win_start_h := (w_entry->>'start')::real;
      -- Convert hour-float on Oslo today to a UTC timestamptz. Hour bucket
      -- helper gives the start-of-hour; add fractional minutes back in.
      v_win_start_ts := public.oslo_hour_bucket(v_today, v_win_start_h)
                         + ((v_win_start_h - floor(v_win_start_h))::numeric * interval '1 hour');
      v_min_until := (EXTRACT(EPOCH FROM (v_win_start_ts - now()))::int) / 60;

      -- "Incoming" window: at least 1 min out, within notify_minutes_before.
      CONTINUE WHEN v_min_until < 1 OR v_min_until > v_max_min;

      -- Weather gate — drop if rainy or overcast at the window's start hour.
      v_bucket := public.wx_bucket(v_win_start_ts);
      CONTINUE WHEN v_bucket IN ('regn', 'skyer');

      v_notif_id := 'sun_alert:' ||
                    to_char(v_today, 'YYYY-MM-DD') || ':' ||
                    sa.venue_id || ':' ||
                    round(v_win_start_h * 60)::int;

      v_body := 'Sol på <strong>' || sa.venue_name || '</strong> om ' || v_min_until || ' min.';
      v_lead := jsonb_build_object(
        'type',     'sys',
        'icon',     'sun',
        'bodyKey',  'notif_sun_alert_body',
        'bodyVars', jsonb_build_object('venue', sa.venue_name, 'minutes', v_min_until)
      );

      -- category='weather' matches the existing notifications_category_check
      -- (sql/012). Sun alerts conceptually fit 'weather' on the bell side;
      -- the toast still uses category='alert' on the client (P0 opt-in
      -- bypass-kill-switch behavior), which doesn't need to match the DB.
      INSERT INTO public.notifications (user_id, notif_id, category, body, lead, nav)
      VALUES (
        sa.user_id,
        v_notif_id,
        'weather',
        v_body,
        v_lead,
        jsonb_build_object('kind', 'venue', 'venueId', sa.venue_id)
      )
      ON CONFLICT (user_id, notif_id) DO NOTHING;

      GET DIAGNOSTICS v_inserted = ROW_COUNT;
      IF v_inserted > 0 THEN
        PERFORM public._do_send_push(sa.user_id, jsonb_build_object(
          'title', 'Shades',
          'body',  'Sol på ' || sa.venue_name || ' om ' || v_min_until || ' min.',
          'url',   '/',
          'tag',   'sun_alert_' || sa.venue_id || '_' || round(v_win_start_h * 60)::int
        ));
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.process_sun_alerts() FROM PUBLIC, anon, authenticated;

-- Schedule every 5 min, same cadence as plan-reminders.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'process-sun-alerts';
SELECT cron.schedule(
  'process-sun-alerts',
  '*/5 * * * *',
  $cmd$SELECT public.process_sun_alerts();$cmd$
);

NOTIFY pgrst, 'reload schema';
