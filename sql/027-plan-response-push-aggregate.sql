-- 027-plan-response-push-aggregate.sql — push notifications for
-- accept/decline responses now AGGREGATE via tag-based replacement.
--
-- Replaces the per-responder push from sql/011-push-triggers.sql.
-- Original: tag = social_invite_<status>_<plan_id>_<user_id> (unique
-- per responder), body "<name> said yes". Each response piled up a
-- new notification on the host's device.
--
-- New: tag = social_plan_response_<status>_<plan_id> (one per
-- plan+status). Web Push spec replaces a prior notification with the
-- same tag, so the device shows the LATEST aggregate only. Body
-- carries the newest responder's name + a "+N" tail for others —
-- consistent with the in-app inbox wording.
--
--   "Anna har godtatt invitasjonen din til Starbucks i morgen kl 12"
--   "Marit +2 har godtatt invitasjonen din til Starbucks i morgen kl 12"
--   "Erik har avslått invitasjonen din til Starbucks i morgen kl 12"
--
-- Date phrasing uses Europe/Oslo timezone, same logic as migration
-- 024 (today/tomorrow/yesterday/DD.MM). venue_name comes from the
-- denormalized plans.venue_name column also added by 024.
--
-- Skips firing when the responder IS the creator (no self-pings).
-- Skips when status didn't actually change (idempotent UPDATEs).
--
-- Idempotent.

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
  v_when         text;
  v_today_oslo   date;
  v_plan_date    date;
  v_time_oslo    text;
  v_planned_at   timestamptz;
  v_total        int;
  v_extra        int;
  v_tail         text;
  v_verb         text;
  v_body         text;
  v_payload      jsonb;
BEGIN
  IF NEW.status NOT IN ('accepted', 'declined') THEN RETURN NEW; END IF;
  IF (TG_OP = 'UPDATE') AND OLD.status = NEW.status THEN RETURN NEW; END IF;

  SELECT p.creator_id, p.planned_at, COALESCE(p.venue_name, 'et sted')
    INTO v_creator_id, v_planned_at, v_venue
    FROM public.plans p
   WHERE p.id = NEW.plan_id;

  IF v_creator_id IS NULL THEN RETURN NEW; END IF;
  IF v_creator_id = NEW.user_id THEN RETURN NEW; END IF; -- no self-pings

  SELECT COALESCE(prof.name, split_part(prof.email, '@', 1), 'Noen')
    INTO v_responder
    FROM public.profiles prof
   WHERE prof.id = NEW.user_id;

  v_today_oslo := (now()        AT TIME ZONE 'Europe/Oslo')::date;
  v_plan_date  := (v_planned_at AT TIME ZONE 'Europe/Oslo')::date;
  v_time_oslo  := to_char(v_planned_at AT TIME ZONE 'Europe/Oslo', 'HH24:MI');
  v_when := CASE
    WHEN v_plan_date = v_today_oslo     THEN 'i dag kl. '     || v_time_oslo
    WHEN v_plan_date = v_today_oslo + 1 THEN 'i morgen kl. '  || v_time_oslo
    WHEN v_plan_date = v_today_oslo - 1 THEN 'i går kl. '     || v_time_oslo
    ELSE to_char(v_planned_at AT TIME ZONE 'Europe/Oslo', 'DD.MM') || ' kl. ' || v_time_oslo
  END;

  -- Live count of responders with THIS status for THIS plan.
  SELECT COUNT(*) INTO v_total
    FROM public.plan_invites pi
   WHERE pi.plan_id = NEW.plan_id
     AND pi.status = NEW.status;
  v_extra := GREATEST(0, v_total - 1);
  v_tail := CASE WHEN v_extra > 0 THEN ' +' || v_extra::text ELSE '' END;

  v_verb := CASE NEW.status WHEN 'accepted' THEN 'har godtatt' ELSE 'har avslått' END;
  v_body := v_responder || v_tail || ' ' || v_verb || ' invitasjonen din til ' || v_venue || ' ' || v_when;

  v_payload := jsonb_build_object(
    'user_id', v_creator_id,
    'payload', jsonb_build_object(
      'title', 'Shades',
      'body',  v_body,
      'url',   '/',
      -- Tag replaces prior pushes for THIS plan+status. Anna accepting
      -- then Bjørn accepting shows ONE notification on the device,
      -- updated to reflect Bjørn + N (accepts/declines are separate
      -- tags so the host can see both threads if both happen).
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

-- Trigger reattachment is implicit: notify_invite_response is bound
-- to trg_plan_invite_response_push (sql/011). CREATE OR REPLACE on
-- the function keeps the trigger pointing at the new body.

NOTIFY pgrst, 'reload schema';
