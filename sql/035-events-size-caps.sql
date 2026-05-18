-- 035-events-size-caps.sql — bound the size of anon-writeable analytics rows.
--
-- The events table (sql/create-events-table.sql) has an anon-insert policy
-- with no size or shape constraints:
--   create policy "anon_insert" on events for insert with check (true);
--
-- That's by design for analytics, but it leaves the table open to a billing /
-- log-poisoning DOS: an attacker can post events with multi-megabyte
-- `properties` JSON, or a flood of distinct event names, and the table grows
-- without bound at storage-cost expense.
--
-- This migration adds two NOT VALID CHECK constraints — they apply to new
-- INSERTs/UPDATEs only, so existing rows (if any are over-limit) don't need
-- to be backfilled or rejected:
--
--   events_event_length      — event name 1..64 chars (matches typical
--                               analytics naming; way past anything the app
--                               legitimately sends).
--   events_properties_size   — properties JSON ≤ 4096 bytes serialized.
--                               The app's biggest legitimate properties blob
--                               is ~30 fields × short values, well under 1KB;
--                               4KB leaves headroom for ad-hoc debugging
--                               metadata.
--
-- Rate-limiting per IP and protocol-level abuse mitigation are a Cloudflare /
-- Supabase edge concern, not something we can enforce in Postgres. This
-- migration just closes the unbounded-payload vector.
--
-- Idempotent.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'events_event_length' AND conrelid = 'public.events'::regclass
  ) THEN
    ALTER TABLE public.events
      ADD CONSTRAINT events_event_length
      CHECK (length(event) BETWEEN 1 AND 64) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'events_properties_size' AND conrelid = 'public.events'::regclass
  ) THEN
    ALTER TABLE public.events
      ADD CONSTRAINT events_properties_size
      CHECK (length(properties::text) <= 4096) NOT VALID;
  END IF;
END $$;
