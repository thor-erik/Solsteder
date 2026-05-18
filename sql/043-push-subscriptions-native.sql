-- 043-push-subscriptions-native.sql
--
-- Extend push_subscriptions to carry native iOS (APN) and Android (FCM)
-- device tokens alongside the existing web push (VAPID) endpoint+keys.
--
-- Why a unified table instead of three tables: single source of truth for
-- "where can I reach this user". The send-push edge function reads one
-- table and dispatches by platform discriminator. DB triggers don't need
-- to know about platforms; they emit one push intent and the function
-- handles the per-platform delivery.
--
-- Backfill: existing rows are all web — default the platform column to
-- 'web'. The existing UNIQUE(endpoint) constraint stays for web rows. For
-- native rows endpoint is empty and apn_token / fcm_token carry the
-- device identifier — add a partial UNIQUE on those instead so a device
-- can't end up with duplicate subscriptions.
--
-- Idempotent.

-- ── 1. Add platform discriminator + native token columns ───────────────────
ALTER TABLE public.push_subscriptions
  ADD COLUMN IF NOT EXISTS platform   text NOT NULL DEFAULT 'web'
    CHECK (platform IN ('web', 'ios', 'android')),
  ADD COLUMN IF NOT EXISTS apn_token  text,
  ADD COLUMN IF NOT EXISTS fcm_token  text;

-- ── 2. Relax the web-only NOT NULL constraints ─────────────────────────────
-- Existing endpoint/p256dh/auth columns are web-specific. Native rows
-- have empty strings here and populate apn_token or fcm_token instead.
-- Drop the NOT NULLs so native rows can be inserted; preserve them
-- logically via the CHECK constraint below.
ALTER TABLE public.push_subscriptions
  ALTER COLUMN endpoint DROP NOT NULL,
  ALTER COLUMN p256dh   DROP NOT NULL,
  ALTER COLUMN auth     DROP NOT NULL;

-- Either the row is a web subscription (endpoint + p256dh + auth all
-- present, platform='web') OR a native one (platform in ios/android,
-- the matching token field present, web fields null/empty). Catches
-- malformed inserts at the DB layer so the edge function never has to
-- second-guess what kind of row it's looking at.
ALTER TABLE public.push_subscriptions
  DROP CONSTRAINT IF EXISTS push_subscriptions_platform_fields_check;
ALTER TABLE public.push_subscriptions
  ADD CONSTRAINT push_subscriptions_platform_fields_check CHECK (
    (platform = 'web'     AND endpoint  IS NOT NULL AND p256dh IS NOT NULL AND auth IS NOT NULL)
    OR (platform = 'ios'     AND apn_token IS NOT NULL AND apn_token <> '')
    OR (platform = 'android' AND fcm_token IS NOT NULL AND fcm_token <> '')
  );

-- ── 3. Indexes for token lookups + duplicate prevention ────────────────────
-- The existing UNIQUE(endpoint) only enforces uniqueness when endpoint
-- IS NOT NULL (Postgres NULLs-distinct default), so it's still correct
-- for web rows and a no-op for native rows.
--
-- Partial UNIQUE on native tokens: one device should have at most one
-- active row per platform. Upsert key for the edge function.
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_apn_token_uniq
  ON public.push_subscriptions (apn_token)
  WHERE apn_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_fcm_token_uniq
  ON public.push_subscriptions (fcm_token)
  WHERE fcm_token IS NOT NULL;

-- Useful for the fan-out join (`SELECT ... WHERE user_id = $1`).
-- The existing push_subscriptions_user_idx already covers this.

-- ── 4. Update the helper that the DB triggers call ─────────────────────────
-- _do_send_push (from sql/037) forwards user_id + payload to the edge
-- function unchanged. The function does the per-platform dispatch by
-- reading the row's platform column. No change needed here — keeping
-- this note so future-you doesn't re-derive it.
