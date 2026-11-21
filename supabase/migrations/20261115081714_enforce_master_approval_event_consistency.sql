create or replace function public.vision_guard_master_approval_insert()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  revision_creator uuid;
  revision_submitter uuid;
  revision_status text;
  revision_approver uuid;
begin
  select created_by, submitted_by, status, approved_by
    into revision_creator, revision_submitter, revision_status, revision_approver
  from public.vision_master_revisions
  where master_id = new.master_id and id = new.revision_id;
  if not found then
    raise exception 'Approval event references an unknown Master revision';
  end if;
  if new.action = 'SUBMITTED'
     and (revision_status <> 'PENDING_APPROVAL' or revision_submitter is distinct from new.actor_id) then
    raise exception 'SUBMITTED event must match the revision submitter and pending state';
  end if;
  if new.action = 'APPROVED'
     and (revision_status <> 'APPROVED' or revision_approver is distinct from new.actor_id
          or revision_submitter is null or revision_submitter = new.actor_id
          or revision_creator = new.actor_id) then
    raise exception 'APPROVED event must match an independent revision approver';
  end if;
  if new.action = 'REJECTED'
     and (revision_status <> 'REJECTED' or revision_submitter is null or revision_submitter = new.actor_id
          or revision_creator = new.actor_id) then
    raise exception 'REJECTED event must match an independent revision reviewer';
  end if;
  return new;
end;
$$;
