-- Vision-AI-AWS foundation. Additive only: does not alter legacy tables or buckets.
create table if not exists public.inspection_history (
  id text primary key,
  "timestamp" timestamptz not null,
  product_id text not null,
  product_code text not null,
  product_name text not null,
  master_id text not null,
  master_revision_id text not null,
  master_revision_code text not null,
  judgement text not null check (judgement in ('OK','NG','INVALID','ERROR')),
  expected_count integer not null check (expected_count >= 0),
  detected_count integer not null check (detected_count >= 0),
  defects jsonb not null default '[]'::jsonb,
  primary_reason text not null default '',
  metrics jsonb not null default '{}'::jsonb,
  alignment jsonb not null default '{}'::jsonb,
  roi_results jsonb not null default '[]'::jsonb,
  extra_objects jsonb not null default '[]'::jsonb,
  thumbnail_base64 text,
  device_id text not null,
  operator_id text,
  sequence_number bigint,
  plc_interlock_state text,
  plc_comm_latency_ms numeric,
  plc_timeline jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_inspection_history_timestamp
  on public.inspection_history ("timestamp" desc);
create index if not exists idx_inspection_history_device_timestamp
  on public.inspection_history (device_id, "timestamp" desc);
create index if not exists idx_inspection_history_product_timestamp
  on public.inspection_history (product_code, "timestamp" desc);
create index if not exists idx_inspection_history_judgement_timestamp
  on public.inspection_history (judgement, "timestamp" desc);

create table if not exists public.vision_events (
  id uuid primary key default gen_random_uuid(),
  status text not null check (status in ('OK','NG','INVALID','ERROR','STANDBY')),
  confidence numeric(5,4) not null default 0 check (confidence >= 0 and confidence <= 1),
  mode text not null default 'CONTINUOUS',
  jig text not null,
  inspection_id text,
  event_timestamp timestamptz not null,
  product_code text,
  revision_code text,
  detected_count integer,
  expected_count integer,
  reason text,
  received_at timestamptz not null default now()
);
create index if not exists idx_vision_events_jig_received
  on public.vision_events (jig, received_at desc);
create index if not exists idx_vision_events_inspection
  on public.vision_events (inspection_id);

create table if not exists public.vision_sessions (
  id uuid primary key default gen_random_uuid(),
  station_id text not null,
  action text not null check (action in ('START_SESSION','END_SESSION')),
  product_code text,
  revision_code text,
  context jsonb not null default '{}'::jsonb,
  event_timestamp timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_vision_sessions_station_created
  on public.vision_sessions (station_id, created_at desc);

create table if not exists public.vision_configurations (
  station_id text primary key,
  setup_step integer not null default 0,
  camera jsonb not null default '{}'::jsonb,
  master jsonb not null default '{}'::jsonb,
  revision jsonb not null default '{}'::jsonb,
  saved_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Keep all Vision-AI tables inaccessible to browser roles.
alter table public.inspection_history enable row level security;
alter table public.vision_events enable row level security;
alter table public.vision_sessions enable row level security;
alter table public.vision_configurations enable row level security;

revoke all on table public.inspection_history, public.vision_events,
  public.vision_sessions, public.vision_configurations from public, anon, authenticated;
grant all on table public.inspection_history, public.vision_events,
  public.vision_sessions, public.vision_configurations to service_role;

-- Private storage for Vision-AI assets; preserve the existing customer-files bucket.
insert into storage.buckets (id, name, public, file_size_limit)
values ('vision-assets', 'vision-assets', false, 26214400)
on conflict (id) do nothing;
