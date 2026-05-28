-- 044-seating-audit.sql
-- Collaborative, continuous polygon-audit backing store.
--
-- Replaces the per-browser localStorage audit workflow (solsteder_corrections_v1,
-- solsteder_audit_v1, solsteder_audit_archive_v1, solsteder_facings_v4 overrides)
-- with two Supabase tables so multiple admins can work continuously, across
-- devices, without double work. The consumer app is unaffected — users still
-- load the static data/seating-detected.json; only admins in audit mode read/
-- write these tables. A scheduled job regenerates seating-detected.json from
-- here (see scripts/sync-seating-from-supabase.mjs).
--
-- Access: editors + admins only (mirrors sql/016 suggested_venues pattern,
-- inline profiles.role EXISTS — no recursion since the policy is not on
-- profiles). Anon/regular users get nothing (RLS denies, policies are
-- TO authenticated only).
--
-- Idempotent: CREATE ... IF NOT EXISTS + DROP POLICY IF EXISTS before CREATE.

-- ── venue_audit_state ───────────────────────────────────────────────────────
-- One upserted row per venue = the shared "where are we" map (which venues are
-- reviewed / archived, by whom). This is what makes collaboration possible:
-- realtime updates grey out a card the moment another admin finishes it.
CREATE TABLE IF NOT EXISTS public.venue_audit_state (
  venue_id       text PRIMARY KEY,
  status         text NOT NULL CHECK (status IN ('reviewed', 'archived')),
  via            text CHECK (via IN ('good', 'edited')),
  archive_reason text,
  archive_note   text,
  reviewed_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.venue_audit_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit_state_editor_all" ON public.venue_audit_state;
CREATE POLICY "audit_state_editor_all" ON public.venue_audit_state
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid())
        AND p.role = ANY (ARRAY['admin', 'editor'])
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid())
        AND p.role = ANY (ARRAY['admin', 'editor'])
    )
  );

-- ── seating_corrections ─────────────────────────────────────────────────────
-- Append-only log of every edit. This is the training corpus (source:'manual'
-- few-shot examples for detect-seating), the IoU-eval history, and the audit
-- trail of who-changed-what-when. The current override for a venue = the most
-- recent row with a non-null polygon (type='correction').
CREATE TABLE IF NOT EXISTS public.seating_corrections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id    text NOT NULL,
  type        text NOT NULL CHECK (type IN ('correction', 'confirmed', 'archive', 'unarchive')),
  polygon     jsonb,        -- [[lat,lng],…] or null (cleared override)
  before      jsonb,        -- _venueEditSnapshot before
  "after"     jsonb,        -- _venueEditSnapshot after
  origin      text,         -- 'drag-edit' | 'from-scratch'
  created_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS seating_corrections_venue_idx
  ON public.seating_corrections (venue_id, created_at DESC);

ALTER TABLE public.seating_corrections ENABLE ROW LEVEL SECURITY;

-- SELECT: any editor/admin can read the whole log (shared corpus).
DROP POLICY IF EXISTS "seating_corr_editor_select" ON public.seating_corrections;
CREATE POLICY "seating_corr_editor_select" ON public.seating_corrections
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid())
        AND p.role = ANY (ARRAY['admin', 'editor'])
    )
  );

-- INSERT: editor/admin only, and created_by must be the caller (attribution).
-- No UPDATE/DELETE policies → the log is append-only (RLS denies by default).
DROP POLICY IF EXISTS "seating_corr_editor_insert" ON public.seating_corrections;
CREATE POLICY "seating_corr_editor_insert" ON public.seating_corrections
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = (select auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid())
        AND p.role = ANY (ARRAY['admin', 'editor'])
    )
  );

-- ── Realtime ────────────────────────────────────────────────────────────────
-- venue_audit_state drives live collaboration (cards grey out across admins).
-- Add to the supabase_realtime publication idempotently.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'venue_audit_state'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.venue_audit_state;
  END IF;
END $$;
