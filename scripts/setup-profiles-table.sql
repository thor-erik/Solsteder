-- setup-profiles-table.sql
-- Run FIRST in the Supabase SQL editor, before setup-suggested-venues.sql.
-- Creates the profiles table, RLS policies, and auto-population trigger.
--
-- After running:
--   1. Find your row in the profiles table (Table Editor → profiles).
--   2. Set your role column to 'admin' directly in the dashboard.
--   3. Sign out and back in — authLoadRole() will pick it up.

-- ── Table ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS profiles (
  id     UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email  TEXT,
  name   TEXT,
  role   TEXT DEFAULT 'user'
           CHECK (role IN ('user', 'editor', 'admin'))
);

-- ── Auto-populate on sign-up ──────────────────────────────────────────────────
-- Creates a profile row whenever a new user signs in for the first time.

CREATE OR REPLACE FUNCTION _handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO profiles (id, email, name, role)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'name',
    'user'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION _handle_new_user();

-- ── Backfill existing users ───────────────────────────────────────────────────
-- Anyone who signed in before this table existed won't have triggered the above.
-- This inserts a row for every existing auth user (safe to re-run — uses ON CONFLICT).

INSERT INTO profiles (id, email, name, role)
SELECT
  id,
  email,
  raw_user_meta_data->>'name',
  'user'
FROM auth.users
ON CONFLICT (id) DO NOTHING;

-- ── Row Level Security ────────────────────────────────────────────────────────

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Helper function: returns the current user's role without triggering RLS recursion.
-- SECURITY DEFINER lets it bypass RLS on profiles when called from a policy.
CREATE OR REPLACE FUNCTION _current_user_role()
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT role FROM profiles WHERE id = auth.uid();
$$;

-- Every authenticated user can read their own row (needed by authLoadRole).
CREATE POLICY "Users read own profile"
  ON profiles FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

-- Admins and editors can read all rows (needed by the role manager panel).
CREATE POLICY "Admins read all profiles"
  ON profiles FOR SELECT
  TO authenticated
  USING (_current_user_role() IN ('admin', 'editor'));

-- Only admins can update roles (used by authSetUserRole / role manager).
CREATE POLICY "Admins update profiles"
  ON profiles FOR UPDATE
  TO authenticated
  USING  (_current_user_role() = 'admin')
  WITH CHECK (_current_user_role() = 'admin');
