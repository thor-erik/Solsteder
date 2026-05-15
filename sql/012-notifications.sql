-- 012-notifications.sql — per-user notifications inbox table backing the
-- bell dropdown in the top strip. Each row is one captured notification.
-- Idempotent: safe to re-run.
--
-- Schema:
--   id          UUID, primary key
--   user_id     UUID, FK auth.users.id, the recipient (CASCADE on user delete)
--   notif_id    TEXT, the in-app notification rule id (e.g. 'social_friends_at',
--               'social_invite_accepted_<plan>_<user>'). UNIQUE per user so the
--               same event firing twice updates the existing row instead of
--               duplicating it.
--   category    TEXT, one of 'weather' | 'social' | 'suggestion' | 'login' | 'system'
--   body        TEXT, rendered HTML body (with <strong>-wrapped names/venues)
--   lead        JSONB, descriptor for the row's leading element. Either
--                 { type: 'avatar', name: '<First>', count: N }
--               or
--                 { type: 'sys',    icon: 'sun'|'rain'|'bulb'|'wind' }
--   nav         JSONB, serializable click descriptor. Examples:
--                 { kind: 'venue', venueId: 123 }
--                 { kind: 'plan',  venueId: 123, plannedAt: '2026-05-16T17:00:00Z' }
--                 { kind: 'friends' }                -- opens friends modal
--                 { kind: 'friend-request', friendshipId: '...' }
--                 { kind: 'none' }                   -- close-only (no nav)
--   created_at  TIMESTAMPTZ, when the notification fired
--   read_at     TIMESTAMPTZ NULLABLE, when the user opened the bell + saw it
--
-- RLS: users can read / write only their own rows.

CREATE TABLE IF NOT EXISTS public.notifications (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  notif_id    TEXT         NOT NULL,
  category    TEXT         NOT NULL CHECK (category IN ('weather','social','suggestion','login','system')),
  body        TEXT         NOT NULL,
  lead        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  nav         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  read_at     TIMESTAMPTZ
);

-- Dedupe: one row per (user, notif_id). Re-firing UPDATEs (via upsert)
-- rather than inserting a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_user_notif_idx
  ON public.notifications (user_id, notif_id);

-- Primary lookup: recent notifications for a user, newest first.
CREATE INDEX IF NOT EXISTS notifications_user_created_idx
  ON public.notifications (user_id, created_at DESC);

-- ── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_select_own" ON public.notifications;
CREATE POLICY "user_select_own"
  ON public.notifications FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_insert_own" ON public.notifications;
CREATE POLICY "user_insert_own"
  ON public.notifications FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_update_own" ON public.notifications;
CREATE POLICY "user_update_own"
  ON public.notifications FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_delete_own" ON public.notifications;
CREATE POLICY "user_delete_own"
  ON public.notifications FOR DELETE
  USING (auth.uid() = user_id);

-- ── Realtime ───────────────────────────────────────────────────────────────
-- Add to the supabase_realtime publication so the client can subscribe for
-- cross-device sync ("a notification fires on phone, my laptop sees it too").
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
  END IF;
END $$;
