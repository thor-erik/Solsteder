-- 009-plan-invite-arrival-time.sql
--
-- Per-invitee arrival time. NULL means "same as the plan's planned_at".
-- Lets a friend say "I'll come, but at 14:00 instead of 13:00".
--
-- The column is read by:
--   - js/auth.js loadPlans() (already SELECT * so the field rides along)
--   - js/auth.js respondToPlanInvite(inviteId, status, arrivalTime?)
--   - js/ui-plan-preview.js (Accept-with-time-picker, attendee chips)
--   - js/ui-detail.js (per-invitee chips on the plan card)
--   - js/notifications.js (_evalInviteAccepted toast body)
--
-- No RLS change — existing "Invitees update own status" policy already covers
-- writes to plan_invites for the row owner.

ALTER TABLE plan_invites
  ADD COLUMN IF NOT EXISTS arrival_time timestamptz;
