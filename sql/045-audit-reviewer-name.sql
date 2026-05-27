-- 045-audit-reviewer-name.sql
-- Denormalize the reviewer's display name onto venue_audit_state so the audit
-- card can show "last reviewed/edited by X" without a profiles join (and so the
-- name rides along in realtime payloads). Additive + nullable — zero impact on
-- the live app, which doesn't read this column yet.
ALTER TABLE public.venue_audit_state
  ADD COLUMN IF NOT EXISTS reviewed_by_name text;
