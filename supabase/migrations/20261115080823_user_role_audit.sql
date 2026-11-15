create table if not exists public.vision_user_role_audit_logs (
  id uuid primary key default gen_random_uuid(),
  target_user_id uuid not null references auth.users(id) on delete restrict,
  target_email text not null,
  previous_role text,
  new_role text not null check (new_role in ('OPERATOR','ENGINEER','APPROVER','ADMIN')),
  is_active boolean not null,
  actor_id uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.vision_user_role_audit_logs enable row level security;
drop policy if exists vision_backend_access on public.vision_user_role_audit_logs;
create policy vision_backend_access on public.vision_user_role_audit_logs
  for all to vision_backend using (true) with check (true);
grant select, insert on public.vision_user_role_audit_logs to vision_backend;

drop trigger if exists vision_user_role_audit_immutable on public.vision_user_role_audit_logs;
create trigger vision_user_role_audit_immutable
before update or delete on public.vision_user_role_audit_logs
for each row execute function public.vision_reject_immutable_history();
