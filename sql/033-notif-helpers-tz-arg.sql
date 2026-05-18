-- 033-notif-helpers-tz-arg.sql — make timezone a parameter on the
-- date-phrasing helpers. Today every caller passes 'Europe/Oslo'
-- because the app is single-city, but when en/se/dk locales land or
-- the app expands beyond Oslo, the TZ can flow from a user profile
-- column without rewriting every trigger again.
--
-- Adds overloads with an explicit tz arg, keeps the zero-arg versions
-- as Oslo-default shims that just call the overload. Callers don't
-- need to change for now.
--
--   public.notif_day_label(plan_at, tz)   — bare day phrase
--   public.notif_when_label(plan_at, tz)  — day phrase + " kl. HH:MM"
--
-- Idempotent.

-- Two-arg variants — the new canonical form.

CREATE OR REPLACE FUNCTION public.notif_day_label(plan_at TIMESTAMPTZ, tz TEXT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_today      DATE;
  v_plan_date  DATE;
  v_days_out   INT;
  v_dow        INT;
BEGIN
  v_today     := (now()   AT TIME ZONE tz)::date;
  v_plan_date := (plan_at AT TIME ZONE tz)::date;
  v_days_out  := v_plan_date - v_today;

  IF v_days_out =  0 THEN RETURN 'i dag';    END IF;
  IF v_days_out =  1 THEN RETURN 'i morgen'; END IF;
  IF v_days_out = -1 THEN RETURN 'i går';    END IF;

  IF (v_days_out BETWEEN 2 AND 7)
     OR (v_days_out BETWEEN -6 AND -2) THEN
    v_dow := EXTRACT(dow FROM v_plan_date);
    RETURN CASE v_dow
      WHEN 0 THEN 'søndag'
      WHEN 1 THEN 'mandag'
      WHEN 2 THEN 'tirsdag'
      WHEN 3 THEN 'onsdag'
      WHEN 4 THEN 'torsdag'
      WHEN 5 THEN 'fredag'
      WHEN 6 THEN 'lørdag'
    END;
  END IF;

  RETURN to_char(plan_at AT TIME ZONE tz, 'DD.MM');
END;
$$;

CREATE OR REPLACE FUNCTION public.notif_when_label(plan_at TIMESTAMPTZ, tz TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT public.notif_day_label(plan_at, tz)
       || ' kl. '
       || to_char(plan_at AT TIME ZONE tz, 'HH24:MI');
$$;

-- Zero-arg shims — call the new form with the Oslo default. All
-- existing trigger code continues to work unchanged.
CREATE OR REPLACE FUNCTION public.notif_day_label(plan_at TIMESTAMPTZ)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT public.notif_day_label(plan_at, 'Europe/Oslo');
$$;

CREATE OR REPLACE FUNCTION public.notif_when_label(plan_at TIMESTAMPTZ)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT public.notif_when_label(plan_at, 'Europe/Oslo');
$$;

NOTIFY pgrst, 'reload schema';
