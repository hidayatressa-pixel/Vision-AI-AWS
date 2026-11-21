alter table public.vision_events
  add column if not exists station_id text,
  add column if not exists master_id text,
  add column if not exists master_revision_id text;

alter table public.vision_sessions
  add column if not exists master_id text,
  add column if not exists master_revision_id text;

create index if not exists vision_events_station_revision_idx
  on public.vision_events(station_id, master_id, master_revision_id, event_timestamp desc);
create index if not exists vision_sessions_station_revision_idx
  on public.vision_sessions(station_id, master_id, master_revision_id, created_at desc);
