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
      raise exception 'Maker-checker violation: creator and submitter cannot approve own Master revision';
    end if;
  end if;
  return new;
end;
$$;
