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
  perform pg_advisory_xact_lock(hashtextextended(new.station_id, 0));
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
