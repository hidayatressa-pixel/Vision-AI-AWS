do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.vision_master_approvals'::regclass
      and conname = 'vision_master_approvals_revision_owner_fk'
  ) then
    alter table public.vision_master_approvals
      add constraint vision_master_approvals_revision_owner_fk
      foreign key (master_id, revision_id)
      references public.vision_master_revisions(master_id, id)
      on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.vision_master_audit_logs'::regclass
      and conname = 'vision_master_audit_revision_owner_fk'
  ) then
    alter table public.vision_master_audit_logs
      add constraint vision_master_audit_revision_owner_fk
      foreign key (master_id, revision_id)
      references public.vision_master_revisions(master_id, id)
      on delete restrict;
  end if;
end
$$;
