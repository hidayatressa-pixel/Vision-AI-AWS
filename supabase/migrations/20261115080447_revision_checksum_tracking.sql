alter table public.inspection_history
  add column if not exists master_revision_checksum text;

alter table public.vision_events
  add column if not exists master_revision_checksum text;

alter table public.vision_sessions
  add column if not exists master_revision_checksum text;

create index if not exists inspection_history_station_revision_checksum_idx
  on public.inspection_history(station_id, master_id, master_revision_id, master_revision_checksum);
