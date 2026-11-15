create table if not exists public.store_settings (
  key text primary key check (key = 'store'),
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.store_settings enable row level security;
revoke all on table public.store_settings from anon, authenticated;
grant all on table public.store_settings to service_role;
