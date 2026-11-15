-- Dedicated least-privilege role for the FastAPI service.
-- The role is intentionally NOLOGIN until a password is set by the project owner.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'vision_backend') then
    create role vision_backend nologin;
  end if;
end
$$;

grant connect on database postgres to vision_backend;
grant usage on schema public to vision_backend;
grant select, insert, update, delete on table
  public.inspection_history,
  public.vision_events,
  public.vision_sessions,
  public.vision_configurations
to vision_backend;

create policy vision_backend_access on public.inspection_history
  for all to vision_backend using (true) with check (true);
create policy vision_backend_access on public.vision_events
  for all to vision_backend using (true) with check (true);
create policy vision_backend_access on public.vision_sessions
  for all to vision_backend using (true) with check (true);
create policy vision_backend_access on public.vision_configurations
  for all to vision_backend using (true) with check (true);
