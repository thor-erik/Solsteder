-- 032-push-deeplink-urls.sql — push notifications now carry a URL
-- that deeplinks to the matching plan-preview instead of just
-- opening '/'.
--
-- URL format: '/?nav=plan&v=<venue_id>&t=<planned_at_iso>&cancelled=<0|1>'
--
-- The SW (sw.js notificationclick handler) already routes the click
-- to wherever notification.data.url points. The client-side
-- _maybeHandlePushDeeplink in auth.js (fires after the first
-- loadPlans on auth-ready) parses these params, opens the matching
-- plan-preview, and cleans the URL so a refresh doesn't replay.
--
-- Rewrites the three push-firing functions to set 'url' to the
-- deeplinked path. The in-app notifications-table writes already
-- carry nav={kind,venueId,plannedAt} so the bell-row CTA was
-- already correct; this aligns the OS-level push with that.
--
-- Idempotent.

CREATE OR REPLACE FUNCTION public.notify_plan_invite_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  p              public.plans%ROWTYPE;
  v_creator      TEXT;
  v_venue        TEXT;
  v_deeplink     TEXT;
  v_payload      jsonb;
BEGIN
  IF NEW.status != 'pending' THEN RETURN NEW; END IF;
  SELECT * INTO p FROM public.plans WHERE id = NEW.plan_id;
  IF p IS NULL THEN RETURN NEW; END IF;

  SELECT COALESCE(prof.name, split_part(prof.email, '@', 1), 'Noen')
    INTO v_creator FROM public.profiles prof WHERE prof.id = p.creator_id;
  v_venue := COALESCE(p.venue_name, 'et sted');

  v_deeplink := '/?nav=plan&v=' || p.venue_id
              || '&t=' || to_char(p.planned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

  v_payload := jsonb_build_object(
    'user_id', NEW.user_id,
    'payload', jsonb_build_object(
      'title', 'Shades',
      'body',  v_creator || ' har invitert deg til ' || v_venue || ' ' || public.notif_when_label(p.planned_at),
      'url',   v_deeplink,
      'tag',   'social_plan_invite_' || NEW.id::text
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
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_invite_response()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_creator_id   uuid;
  v_responder    text;
  v_venue        text;
  v_venue_id     text;
  v_planned_at   timestamptz;
  v_total        int;
  v_extra        int;
  v_tail         text;
  v_verb         text;
  v_body         text;
  v_deeplink     text;
  v_payload      jsonb;
BEGIN
  IF NEW.status NOT IN ('accepted', 'declined') THEN RETURN NEW; END IF;
  IF (TG_OP = 'UPDATE') AND OLD.status = NEW.status THEN RETURN NEW; END IF;

  SELECT p.creator_id, p.venue_id, p.planned_at, COALESCE(p.venue_name, 'et sted')
    INTO v_creator_id, v_venue_id, v_planned_at, v_venue
    FROM public.plans p WHERE p.id = NEW.plan_id;

  IF v_creator_id IS NULL THEN RETURN NEW; END IF;
  IF v_creator_id = NEW.user_id THEN RETURN NEW; END IF;

  SELECT COALESCE(prof.name, split_part(prof.email, '@', 1), 'Noen')
    INTO v_responder FROM public.profiles prof WHERE prof.id = NEW.user_id;

  SELECT COUNT(*) INTO v_total
    FROM public.plan_invites pi
   WHERE pi.plan_id = NEW.plan_id AND pi.status = NEW.status;
  v_extra := GREATEST(0, v_total - 1);
  v_tail  := CASE WHEN v_extra > 0 THEN ' +' || v_extra::text ELSE '' END;
  v_verb  := CASE NEW.status WHEN 'accepted' THEN 'har godtatt' ELSE 'har avslått' END;
  v_body  := v_responder || v_tail || ' ' || v_verb || ' invitasjonen din til ' || v_venue || ' ' || public.notif_when_label(v_planned_at);

  v_deeplink := '/?nav=plan&v=' || v_venue_id
              || '&t=' || to_char(v_planned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

  v_payload := jsonb_build_object(
    'user_id', v_creator_id,
    'payload', jsonb_build_object(
      'title', 'Shades',
      'body',  v_body,
      'url',   v_deeplink,
      'tag',   'social_plan_response_' || NEW.status || '_' || NEW.plan_id::text
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
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_plan_cancelled()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_creator      TEXT;
  v_venue        TEXT;
  v_target_user  uuid;
  v_deeplink     TEXT;
  v_payload      jsonb;
BEGIN
  IF (OLD.cancelled_at IS NOT NULL) THEN RETURN NEW; END IF;
  IF (NEW.cancelled_at IS NULL)     THEN RETURN NEW; END IF;

  SELECT COALESCE(prof.name, split_part(prof.email, '@', 1), 'Noen')
    INTO v_creator FROM public.profiles prof WHERE prof.id = NEW.creator_id;
  v_venue := COALESCE(NEW.venue_name, 'et sted');

  v_deeplink := '/?nav=plan&v=' || NEW.venue_id
              || '&t=' || to_char(NEW.planned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
              || '&cancelled=1';

  FOR v_target_user IN
    SELECT pi.user_id FROM public.plan_invites pi
     WHERE pi.plan_id = NEW.id AND pi.status IN ('pending', 'accepted')
  LOOP
    v_payload := jsonb_build_object(
      'user_id', v_target_user,
      'payload', jsonb_build_object(
        'title', 'Shades',
        'body',  v_creator || ' kansellerte planen til ' || v_venue || ' ' || public.notif_when_label(NEW.planned_at),
        'url',   v_deeplink,
        'tag',   'social_plan_cancelled_' || NEW.id::text
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
  RETURN NEW;
END;
$$;

-- Plan reminders too — same deeplink pattern.
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
    v_deeplink := '/?nav=plan&v=' || p.venue_id
                || '&t=' || to_char(p.planned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

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
        'url',   v_deeplink,
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

      v_payload := jsonb_build_object(
        'user_id', v_recip_id,
        'payload', jsonb_build_object(
          'title', 'Shades',
          'body',  v_lead_body,
          'url',   v_deeplink,
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

    UPDATE public.plans SET reminder_sent_at = now() WHERE id = p.id;
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
