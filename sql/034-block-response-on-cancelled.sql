-- 034-block-response-on-cancelled.sql — reject plan_invites status
-- changes (accept/decline) when the parent plan has been cancelled.
--
-- Race: host calls cancelPlan() at the exact moment an invitee taps
-- "Jeg blir med". Before this guard, both writes succeeded
-- independently — invitee ended up registered as 'accepted' against
-- a cancelled plan, and the inviter got a "+1 har godtatt" push for
-- a plan that no longer exists.
--
-- Trigger approach (not RLS WITH CHECK) so both UPDATE policies
-- (creator + invitee) get the same gate without duplicating logic.
-- Fires BEFORE the UPDATE so the row never moves to the new status.
--
-- Skips the check when status isn't actually changing (idempotent
-- UPDATE) and when the new status is 'pending' (you can always
-- un-do — though no code path does that today).
--
-- Idempotent.

CREATE OR REPLACE FUNCTION public.block_response_on_cancelled_plan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_cancelled timestamptz;
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NEW.status NOT IN ('accepted', 'declined') THEN RETURN NEW; END IF;

  SELECT cancelled_at INTO v_cancelled
    FROM public.plans WHERE id = NEW.plan_id;

  IF v_cancelled IS NOT NULL THEN
    -- Don't raise — silently keep OLD.status. Callers see no error;
    -- the next loadPlans will reveal the cancellation row and the
    -- panel will render in cancelled state. Throwing would surface
    -- as a generic Supabase error in the client which reads worse.
    NEW.status := OLD.status;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS block_response_on_cancelled_plan ON public.plan_invites;
CREATE TRIGGER block_response_on_cancelled_plan
  BEFORE UPDATE ON public.plan_invites
  FOR EACH ROW
  EXECUTE FUNCTION public.block_response_on_cancelled_plan();

REVOKE EXECUTE ON FUNCTION public.block_response_on_cancelled_plan() FROM PUBLIC, anon, authenticated;
