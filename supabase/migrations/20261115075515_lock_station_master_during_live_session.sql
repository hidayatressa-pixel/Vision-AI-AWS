create or replace function public.vision_guard_station_master_assignment()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  revision_status text;
  latest_action text;
  latest_session_at timestamptz;
begin
  select status into revision_status
  from public.vision_master_revisions
  where master_id = new.master_id and id = new.revision_id
  for share;
  if revision_status is distinct from 'APPROVED' then
    raise exception 'Only an approved Master revision can be assigned to a production station';
  end if;

  select action, created_at into latest_action, latest_session_at
  from public.vision_sessions
  where station_id = new.station_id
  order by created_at desc
  limit 1;

  if latest_action = 'START_SESSION'
     and latest_session_at > now() - interval '16 hours' then
    raise exception 'Station Master cannot be reassigned while a Live Inspection session is active';
  end if;
  return new;
end;
$$;

create or replace function public.vision_reject_event_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'Vision events and session records are append-only';
end;
$$;

drop trigger if exists vision_events_immutable on public.vision_events;
create trigger vision_events_immutable
before update or delete on public.vision_events
for each row execute function public.vision_reject_event_mutation();

drop trigger if exists vision_sessions_immutable on public.vision_sessions;
create trigger vision_sessions_immutable
before update or delete on public.vision_sessions
for each row execute function public.vision_reject_event_mutation();

revoke update, delete on public.vision_events, public.vision_sessions from vision_backend;
grant select, insert on public.vision_events, public.vision_sessions to vision_backend;
