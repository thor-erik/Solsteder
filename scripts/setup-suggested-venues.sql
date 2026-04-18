-- setup-suggested-venues.sql
-- Run in the Supabase SQL editor to create the suggested_venues table.
-- After running, enable RLS and add policies as described in the comments.

CREATE TABLE IF NOT EXISTS suggested_venues (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  user_email   TEXT,
  user_name    TEXT,
  osm_id       TEXT,                       -- OSM node/way ID if sourced from candidates
  name         TEXT NOT NULL,
  address      TEXT DEFAULT '',
  lat          DOUBLE PRECISION NOT NULL,
  lng          DOUBLE PRECISION NOT NULL,
  outdoor      BOOLEAN DEFAULT true,
  notes        TEXT DEFAULT '',
  status       TEXT DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  created_at   TIMESTAMPTZ DEFAULT now(),
  reviewed_at  TIMESTAMPTZ,
  reviewed_by  UUID REFERENCES auth.users(id)
);

-- ── Row Level Security ────────────────────────────────────────────────────────

ALTER TABLE suggested_venues ENABLE ROW LEVEL SECURITY;

-- Anyone (incl. anonymous) can read approved venues so they appear in the app
CREATE POLICY "Public reads approved"
  ON suggested_venues FOR SELECT
  TO anon, authenticated
  USING (status = 'approved');

-- Logged-in users can read their own rows regardless of status
CREATE POLICY "Users read own"
  ON suggested_venues FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Admins and editors can read all rows
CREATE POLICY "Admins read all"
  ON suggested_venues FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('admin', 'editor')
    )
  );

-- Authenticated users can submit their own suggestions
CREATE POLICY "Users insert own"
  ON suggested_venues FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Users can withdraw their own pending suggestions
CREATE POLICY "Users withdraw own"
  ON suggested_venues FOR UPDATE
  TO authenticated
  USING  (auth.uid() = user_id AND status = 'pending')
  WITH CHECK (status = 'withdrawn');

-- Admins and editors can update status (approve / reject)
CREATE POLICY "Admins update all"
  ON suggested_venues FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('admin', 'editor')
    )
  );
