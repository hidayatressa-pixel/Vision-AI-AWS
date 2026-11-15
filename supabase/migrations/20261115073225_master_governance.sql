-- Central Master governance for Vision-AI-AWS.
-- Existing AWS resources, legacy customer tables, and customer-files bucket are untouched.

create table if not exists public.vision_user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null check (role in ('OPERATOR','ENGINEER','APPROVER','ADMIN')),
  is_active boolean not null default true,
  assigned_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.vision_masters (
  id text primary key,
  product_code text not null unique,
  product_name text not null,
  description text not null default '',
  is_active boolean not null default true,
  created_by uuid not null references auth.users(id),
  updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.vision_master_revisions (
  id text primary key,
  master_id text not null references public.vision_masters(id) on delete restrict,
  revision_code text not null,
  revision_note text not null default '',
  status text not null default 'DRAFT'
    check (status in ('DRAFT','PENDING_APPROVAL','REJECTED','APPROVED')),
  revision_payload jsonb not null check (jsonb_typeof(revision_payload) = 'object'),
  checksum text not null,
  created_by uuid not null references auth.users(id),
  approved_by uuid references auth.users(id),
  submitted_at timestamptz,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (master_id, id),
  unique (master_id, revision_code)
);

create table if not exists public.vision_master_approvals (
  id uuid primary key default gen_random_uuid(),
  master_id text not null references public.vision_masters(id) on delete restrict,
  revision_id text not null references public.vision_master_revisions(id) on delete restrict,
  action text not null check (action in ('SUBMITTED','APPROVED','REJECTED')),
  actor_id uuid not null references auth.users(id),
  reason text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.vision_master_audit_logs (
  id uuid primary key default gen_random_uuid(),
  master_id text not null references public.vision_masters(id) on delete restrict,
  revision_id text references public.vision_master_revisions(id) on delete restrict,
  station_id text,
  actor_id uuid not null references auth.users(id),
  action text not null,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default now()
);

create table if not exists public.vision_station_master_assignments (
  station_id text primary key,
  master_id text not null,
  revision_id text not null,
  activated_by uuid not null references auth.users(id),
  activated_at timestamptz not null default now(),
  constraint vision_station_assignment_revision_fk
    foreign key (master_id, revision_id)
    references public.vision_master_revisions(master_id, id)
    on delete restrict
);

create index if not exists vision_master_revisions_master_status_idx
  on public.vision_master_revisions(master_id, status, updated_at desc);
create index if not exists vision_master_approvals_revision_idx
  on public.vision_master_approvals(master_id, revision_id, created_at desc);
create index if not exists vision_master_audit_master_idx
  on public.vision_master_audit_logs(master_id, created_at desc);
create index if not exists vision_master_audit_revision_idx
  on public.vision_master_audit_logs(revision_id, created_at desc);

alter table public.vision_user_roles enable row level security;
alter table public.vision_masters enable row level security;
alter table public.vision_master_revisions enable row level security;
alter table public.vision_master_approvals enable row level security;
alter table public.vision_master_audit_logs enable row level security;
alter table public.vision_station_master_assignments enable row level security;

drop policy if exists vision_backend_access on public.vision_user_roles;
create policy vision_backend_access on public.vision_user_roles
  for all to vision_backend using (true) with check (true);
drop policy if exists vision_user_role_self_read on public.vision_user_roles;
create policy vision_user_role_self_read on public.vision_user_roles
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists vision_backend_access on public.vision_masters;
create policy vision_backend_access on public.vision_masters
  for all to vision_backend using (true) with check (true);
drop policy if exists vision_backend_access on public.vision_master_revisions;
create policy vision_backend_access on public.vision_master_revisions
  for all to vision_backend using (true) with check (true);
drop policy if exists vision_backend_access on public.vision_master_approvals;
create policy vision_backend_access on public.vision_master_approvals
  for all to vision_backend using (true) with check (true);
drop policy if exists vision_backend_access on public.vision_master_audit_logs;
create policy vision_backend_access on public.vision_master_audit_logs
  for all to vision_backend using (true) with check (true);
drop policy if exists vision_backend_access on public.vision_station_master_assignments;
create policy vision_backend_access on public.vision_station_master_assignments
  for all to vision_backend using (true) with check (true);

grant select on public.vision_user_roles to authenticated;
grant select, insert, update, delete on public.vision_user_roles to vision_backend;
grant select, insert, update, delete on public.vision_masters to vision_backend;
grant select, insert, update, delete on public.vision_master_revisions to vision_backend;
grant select, insert on public.vision_master_approvals to vision_backend;
grant select, insert on public.vision_master_audit_logs to vision_backend;
grant select, insert, update, delete on public.vision_station_master_assignments to vision_backend;

create or replace function public.vision_guard_master_revision_update()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.status = 'APPROVED' then
    raise exception 'Approved Master revisions are immutable';
  end if;
  if old.status = 'PENDING_APPROVAL'
     and (new.revision_payload is distinct from old.revision_payload
          or new.checksum is distinct from old.checksum
          or new.master_id is distinct from old.master_id
          or new.created_by is distinct from old.created_by) then
    raise exception 'Pending approval Master revisions are locked';
  end if;
  if old.status = 'PENDING_APPROVAL' and new.status not in ('PENDING_APPROVAL','APPROVED','REJECTED') then
    raise exception 'Invalid pending approval transition';
  end if;
  return new;
end;
$$;

drop trigger if exists vision_guard_master_revision_update on public.vision_master_revisions;
create trigger vision_guard_master_revision_update
before update on public.vision_master_revisions
for each row execute function public.vision_guard_master_revision_update();

create or replace function public.vision_guard_station_master_assignment()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare revision_status text;
begin
  select status into revision_status
  from public.vision_master_revisions
  where master_id = new.master_id and id = new.revision_id
  for share;
  if revision_status is distinct from 'APPROVED' then
    raise exception 'Only an approved Master revision can be assigned to a production station';
  end if;
  return new;
end;
$$;

drop trigger if exists vision_guard_station_master_assignment on public.vision_station_master_assignments;
create trigger vision_guard_station_master_assignment
before insert or update on public.vision_station_master_assignments
for each row execute function public.vision_guard_station_master_assignment();

create or replace function public.vision_reject_immutable_history()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'Master approval and audit records are append-only';
end;
$$;

drop trigger if exists vision_master_approvals_immutable on public.vision_master_approvals;
create trigger vision_master_approvals_immutable
before update or delete on public.vision_master_approvals
for each row execute function public.vision_reject_immutable_history();

drop trigger if exists vision_master_audit_immutable on public.vision_master_audit_logs;
create trigger vision_master_audit_immutable
before update or delete on public.vision_master_audit_logs
for each row execute function public.vision_reject_immutable_history();

-- Station identity is explicit on immutable inspection records.
alter table public.inspection_history
  add column if not exists station_id text not null default 'VISION-AI-AWS';

-- The Master asset bucket remains private. The legacy customer-files bucket is untouched.
update storage.buckets
set public = false,
    file_size_limit = 26214400,
    allowed_mime_types = array['image/jpeg','image/png','image/webp']
where id = 'vision-assets';

drop policy if exists vision_master_assets_read on storage.objects;
create policy vision_master_assets_read on storage.objects
for select to authenticated
using (
  bucket_id = 'vision-assets'
  and exists (
    select 1 from public.vision_user_roles r
    where r.user_id = (select auth.uid())
      and r.is_active = true
      and r.role in ('OPERATOR','ENGINEER','APPROVER','ADMIN')
  )
);

drop policy if exists vision_master_assets_insert on storage.objects;
create policy vision_master_assets_insert on storage.objects
for insert to authenticated
with check (
  bucket_id = 'vision-assets'
  and exists (
    select 1 from public.vision_user_roles r
    where r.user_id = (select auth.uid())
      and r.is_active = true
      and r.role in ('ENGINEER','ADMIN')
  )
);

drop policy if exists vision_master_assets_update on storage.objects;
create policy vision_master_assets_update on storage.objects
for update to authenticated
using (
  bucket_id = 'vision-assets'
  and exists (
    select 1 from public.vision_user_roles r
    where r.user_id = (select auth.uid())
      and r.is_active = true
      and r.role in ('ENGINEER','ADMIN')
  )
)
with check (
  bucket_id = 'vision-assets'
  and exists (
    select 1 from public.vision_user_roles r
    where r.user_id = (select auth.uid())
      and r.is_active = true
      and r.role in ('ENGINEER','ADMIN')
  )
);

drop policy if exists vision_master_assets_delete on storage.objects;
create policy vision_master_assets_delete on storage.objects
for delete to authenticated
using (
  bucket_id = 'vision-assets'
  and exists (
    select 1 from public.vision_user_roles r
    where r.user_id = (select auth.uid())
      and r.is_active = true
      and r.role = 'ADMIN'
  )
);

revoke all on public.vision_masters, public.vision_master_revisions,
  public.vision_master_approvals, public.vision_master_audit_logs,
  public.vision_station_master_assignments from anon, authenticated;
revoke insert, update, delete on public.vision_user_roles from anon, authenticated;
