alter table public.vision_master_revisions
  add column if not exists submitted_by uuid references auth.users(id);

create or replace function public.vision_guard_master_revision_update()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.status = 'APPROVED' then
    raise exception 'Approved Master revisions are immutable';
  end if;
  if old.status = 'DRAFT' and new.status not in ('DRAFT','PENDING_APPROVAL') then
    raise exception 'Invalid DRAFT revision transition';
  end if;
  if old.status = 'REJECTED' and new.status not in ('REJECTED','DRAFT','PENDING_APPROVAL') then
    raise exception 'Invalid REJECTED revision transition';
  end if;
  if old.status = 'PENDING_APPROVAL' then
    if new.revision_payload is distinct from old.revision_payload
       or new.checksum is distinct from old.checksum
       or new.master_id is distinct from old.master_id
       or new.created_by is distinct from old.created_by
       or new.submitted_by is distinct from old.submitted_by then
      raise exception 'Pending approval Master revisions are locked';
    end if;
    if new.status not in ('PENDING_APPROVAL','APPROVED','REJECTED') then
      raise exception 'Invalid pending approval transition';
    end if;
    if new.status = 'APPROVED'
       and (new.approved_by is null or new.approved_by = old.submitted_by or new.approved_by = old.created_by) then
      raise exception 'Maker-checker violation: submitter cannot approve own Master revision';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.vision_guard_master_approval_insert()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare revision_submitter uuid;
begin
  select submitted_by into revision_submitter
  from public.vision_master_revisions
  where master_id = new.master_id and id = new.revision_id;
  if new.action = 'APPROVED' and revision_submitter = new.actor_id then
    raise exception 'Maker-checker violation: submitter cannot approve own Master revision';
  end if;
  return new;
end;
$$;

-- Keep approval history actions consistent with the actual revision state and actor.
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
