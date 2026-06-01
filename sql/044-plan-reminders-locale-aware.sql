-- 044-plan-reminders-locale-aware.sql — extend process_plan_reminders to
-- emit structured lead.bodyKey + lead.bodyVars so the client can render
-- bell + toast in the user's locale via i18n.js templates.
--
-- Pre-rendered Norwegian `body` is kept so:
--   * push (the edge function dispatches the body string before any client
--     is in the loop)
--   * any client without the bodyKey-aware render path (older deploys,
--     non-web surfaces)
-- still get a usable string.
--
-- This is the Phase 1 of the hybrid payload pattern. Friend / invite /
-- response / cancel triggers stay pre-rendered-NO until each migrates to
-- the same shape.
--
-- Composes the prior changes: sql/037 (_do_send_push helper), sql/032
-- (deep-link tag + URL), sql/042 (skip-orphans filter on venue_name).
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
  v_lead         jsonb;
  v_payload      jsonb;
  v_nav          jsonb;
BEGIN
  FOR p IN
    SELECT *
    FROM public.plans
    WHERE cancelled_at IS NULL
      AND reminder_sent_at IS NULL
      AND planned_at > now() + interval '25 minutes'
      AND planned_at < now() + interval '35 minutes'
      AND venue_name IS NOT NULL  -- sql/042 — skip orphan plans
  LOOP
    v_creator_name := public.notif_user_name(p.creator_id);
    v_venue        := COALESCE(p.venue_name, 'et sted');
    v_nav          := jsonb_build_object(
      'kind', 'plan',
      'venueId', p.venue_id,
      'plannedAt', p.planned_at
    );

    -- ── Creator reminder ─────────────────────────────────────────────
    v_body := 'Planen din på <strong>' || v_venue || '</strong> starter om 30 min.';
    v_lead := jsonb_build_object(
      'type',     'glyph',
      'icon',     '⏰',
      'bodyKey',  'notif_plan_reminder_creator_body',
      'bodyVars', jsonb_build_object('venue', v_venue, 'minutes', 30)
    );
    INSERT INTO public.notifications (user_id, notif_id, category, body, lead, nav)
    VALUES (
      p.creator_id,
      'plan_reminder_creator:' || p.id,
      'social',
      v_body,
      v_lead,
      v_nav
    )
    ON CONFLICT (user_id, notif_id) DO NOTHING;

    PERFORM public._do_send_push(p.creator_id, jsonb_build_object(
      'title', 'Shades',
      'body',  'Planen din på ' || v_venue || ' starter om 30 min.',
      'url',   '/?nav=plan&v=' || p.venue_id::text || '&t=' || extract(epoch from p.planned_at)::bigint::text,
      'tag',   'plan_reminder_creator_' || p.id::text
    ));

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
        v_lead := jsonb_build_object(
          'type',     'glyph',
          'icon',     '⏰',
          'bodyKey',  'notif_plan_reminder_invitee_accepted_body',
          'bodyVars', jsonb_build_object('venue', v_venue, 'minutes', 30)
        );
      ELSE
        v_body := '<strong>' || v_creator_name || '</strong>s plan på <strong>' || v_venue || '</strong> starter om 30 min.';
        v_lead_body := v_creator_name || 's plan på ' || v_venue || ' starter om 30 min.';
        v_lead := jsonb_build_object(
          'type',     'glyph',
          'icon',     '⏰',
          'bodyKey',  'notif_plan_reminder_invitee_pending_body',
          'bodyVars', jsonb_build_object('creator', v_creator_name, 'venue', v_venue, 'minutes', 30)
        );
      END IF;

      INSERT INTO public.notifications (user_id, notif_id, category, body, lead, nav)
      VALUES (
        v_recip_id,
        'plan_reminder_invitee:' || p.id,
        'social',
        v_body,
        v_lead,
        v_nav
      )
      ON CONFLICT (user_id, notif_id) DO NOTHING;

      PERFORM public._do_send_push(v_recip_id, jsonb_build_object(
        'title', 'Shades',
        'body',  v_lead_body,
        'url',   '/?nav=plan&v=' || p.venue_id::text || '&t=' || extract(epoch from p.planned_at)::bigint::text,
        'tag',   'plan_reminder_invitee_' || p.id::text
      ));
    END LOOP;

    -- Stamp so the next cron tick skips this plan.
    UPDATE public.plans SET reminder_sent_at = now() WHERE id = p.id;
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.process_plan_reminders() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
