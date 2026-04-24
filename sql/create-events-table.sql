-- Analytics events table
-- Run this in Supabase Dashboard → SQL Editor

create table events (
  id          bigint generated always as identity primary key,
  session_id  uuid not null,
  user_id     uuid references auth.users(id),
  event       text not null,
  properties  jsonb default '{}',
  created_at  timestamptz default now(),
  device      jsonb default '{}'
);

-- Query by event type + time range (aggregation)
create index idx_events_event_created on events (event, created_at);

-- Query by venue (sellable per-venue analytics)
create index idx_events_venue on events ((properties->>'venue_id'), created_at);

-- RLS: anyone can insert, only service_role can read
alter table events enable row level security;
create policy "anon_insert" on events for insert with check (true);
