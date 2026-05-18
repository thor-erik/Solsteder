-- 042-plan-reminders-skip-orphans.sql — stop the pg_cron plan-reminders
-- job from firing "Planen din på et sted starter om 30 min" for orphan
-- placeholder plans.
--
-- Background. ui-detail.js's invite sheet used to eagerly INSERT a
-- placeholder plan (no venue_name, no invitees) when the sheet opened,
-- so the URL shortener could embed a plan_id in the share-link token.
-- createPlan() then INSERTed a SECOND real plan when the user clicked
-- Send, leaving the placeholder orphaned. process_plan_reminders walks
-- ALL non-cancelled future plans within 25–35 min and fires reminders;
-- orphan placeholders look identical to real plans except their
-- venue_name is NULL → reminder body falls back to "et sted" ("a place").
--
-- The client-side bug is fixed in the same change that ships this
-- migration (ui-detail.js drops the eager insert), so no NEW orphans
-- get created. This server-side guard hardens against the remaining
-- orphans already in the table and any future regression — only plans
-- with a venue_name AND at least one non-declined invitee are eligible
-- for reminders.
--
-- Solo creator plans (venue_name set, no invitees) still get reminders.
-- That's intentional — a host saved a plan for themselves, the 30-min
-- nudge is useful even without invitees.
--
-- Idempotent.

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
  v_deeplink     text;
BEGIN
  FOR p IN
    SELECT *
    FROM public.plans
    WHERE cancelled_at IS NULL
      AND reminder_sent_at IS NULL
      AND planned_at > now() + interval '25 minutes'
      AND planned_at < now() + interval '35 minutes'
      -- Orphan guard: skip plans that were never finalized by the
      -- client. venue_name IS NULL means the row was an eager-insert
      -- placeholder that the user never actually sent — no need to
      -- nudge anyone about "a place" they don't recognize.
      AND venue_name IS NOT NULL
  LOOP
    v_creator_name := public.notif_user_name(p.creator_id);
    v_venue        := COALESCE(p.venue_name, 'et sted');
    v_deeplink := '/?nav=plan&v=' || p.venue_id
                || '&t=' || to_char(p.planned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

    -- Creator inbox row
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

    PERFORM public._do_send_push(
      p.creator_id,
      jsonb_build_object(
        'title', 'Shades',
        'body',  'Planen din på ' || v_venue || ' starter om 30 min.',
        'url',   v_deeplink,
        'tag',   'plan_reminder_creator_' || p.id::text
      )
    );

    FOR v_recip_id, v_status IN
      SELECT pi.user_id, pi.status
      FROM public.plan_invites pi
      WHERE pi.plan_id = p.id AND pi.status IN ('accepted', 'pending')
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

      PERFORM public._do_send_push(
        v_recip_id,
        jsonb_build_object(
          'title', 'Shades',
          'body',  v_lead_body,
          'url',   v_deeplink,
          'tag',   'plan_reminder_invitee_' || p.id::text
        )
      );
    END LOOP;

    UPDATE public.plans SET reminder_sent_at = now() WHERE id = p.id;
  END LOOP;
END;
$$;
