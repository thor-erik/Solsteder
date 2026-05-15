-- 017-profile-state-extensions.sql — fill in the profile & user-state
-- gaps surfaced by the post-audit coverage review.
--
-- A. profiles.created_at / last_seen_at / locale — capture per-user
--    timeline + locale at signup, update last_seen_at on every auth
--    load. Backfill created_at from auth.users for existing rows.
-- B. user_preferences.state JSONB — single bag for cross-device UI
--    state (dismissed prompts, hidden friend visibility, bell-opened
--    timestamp). One column beats one-table-per-flag and the bag
--    survives schema-less expansion.
-- C. Refresh handle_new_user() so new profile rows pick up
--    created_at + locale from the auth.user row.
--
-- Idempotent.

-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║ A. Profiles columns + backfill                                         ║
-- ╚════════════════════════════════════════════════════════════════════════╝
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS created_at   timestamptz,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS locale       text;

-- Backfill created_at from auth.users for existing rows that miss it.
UPDATE public.profiles p
SET created_at = u.created_at
FROM auth.users u
WHERE p.id = u.id AND p.created_at IS NULL;

-- New rows default to now() so the trigger doesn't have to think about it
-- when locale is the only piece coming from raw_user_meta_data.
ALTER TABLE public.profiles
  ALTER COLUMN created_at SET DEFAULT now();

CREATE INDEX IF NOT EXISTS profiles_last_seen_at_idx ON public.profiles (last_seen_at);

-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║ B. user_preferences.state JSONB                                        ║
-- ║    Cross-device UI bag. Default {} so client code can ?. safely.       ║
-- ╚════════════════════════════════════════════════════════════════════════╝
ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS state jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║ C. Refresh handle_new_user() to pick up locale at signup               ║
-- ║    created_at uses the column default, so we don't set it here.        ║
-- ╚════════════════════════════════════════════════════════════════════════╝
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, name, avatar_url, locale)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name'),
    NEW.raw_user_meta_data->>'avatar_url',
    NEW.raw_user_meta_data->>'locale'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║ D. Add suggested_venues to the supabase_realtime publication so the    ║
-- ║    admin badge can subscribe to status changes without polling.        ║
-- ╚════════════════════════════════════════════════════════════════════════╝
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'suggested_venues'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.suggested_venues;
  END IF;
END $$;
