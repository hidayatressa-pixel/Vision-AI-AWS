create table if not exists public.vision_user_station_access (
  user_id uuid not null references auth.users(id) on delete cascade,
  station_id text not null check (length(station_id) between 1 and 120),
  is_active boolean not null default true,
  assigned_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, station_id)
);

create table if not exists public.vision_user_station_audit_logs (
  id uuid primary key default gen_random_uuid(),
  target_user_id uuid not null references auth.users(id) on delete restrict,
  station_id text not null,
  previous_active boolean,
  new_active boolean not null,
  actor_id uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.vision_user_station_access enable row level security;
alter table public.vision_user_station_audit_logs enable row level security;

drop policy if exists vision_backend_access on public.vision_user_station_access;
create policy vision_backend_access on public.vision_user_station_access
  for all to vision_backend using (true) with check (true);
drop policy if exists vision_user_station_self_read on public.vision_user_station_access;
create policy vision_user_station_self_read on public.vision_user_station_access
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists vision_backend_access on public.vision_user_station_audit_logs;
create policy vision_backend_access on public.vision_user_station_audit_logs
  for all to vision_backend using (true) with check (true);

grant select on public.vision_user_station_access to authenticated;
grant select, insert, update on public.vision_user_station_access to vision_backend;
grant select, insert on public.vision_user_station_audit_logs to vision_backend;

drop trigger if exists vision_user_station_audit_immutable on public.vision_user_station_audit_logs;
create trigger vision_user_station_audit_immutable
before update or delete on public.vision_user_station_audit_logs
for each row execute function public.vision_reject_immutable_history();
