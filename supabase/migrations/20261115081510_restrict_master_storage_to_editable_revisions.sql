drop policy if exists vision_master_assets_insert on storage.objects;
create policy vision_master_assets_insert on storage.objects
for insert to authenticated
with check (
  bucket_id = 'vision-assets'
  and exists (
    select 1 from public.vision_user_roles u
    where u.user_id = (select auth.uid())
      and u.is_active = true and u.role in ('ENGINEER','ADMIN')
  )
  and exists (
    select 1 from public.vision_masters m
    where left(regexp_replace(m.id, '[^a-zA-Z0-9_-]', '_', 'g'), 100) = split_part(name, '/', 1)
  )
  and not exists (
    select 1 from public.vision_master_revisions r
    join public.vision_masters m on m.id = r.master_id
    where left(regexp_replace(m.id, '[^a-zA-Z0-9_-]', '_', 'g'), 100) = split_part(name, '/', 1)
      and left(regexp_replace(r.id, '[^a-zA-Z0-9_-]', '_', 'g'), 100) = split_part(name, '/', 2)
      and r.status not in ('DRAFT','REJECTED')
  )
);

drop policy if exists vision_master_assets_update on storage.objects;
create policy vision_master_assets_update on storage.objects
for update to authenticated
using (
  bucket_id = 'vision-assets'
  and exists (
    select 1 from public.vision_user_roles u
    where u.user_id = (select auth.uid())
      and u.is_active = true and u.role in ('ENGINEER','ADMIN')
  )
  and exists (
    select 1 from public.vision_master_revisions r
    join public.vision_masters m on m.id = r.master_id
    where left(regexp_replace(m.id, '[^a-zA-Z0-9_-]', '_', 'g'), 100) = split_part(name, '/', 1)
      and left(regexp_replace(r.id, '[^a-zA-Z0-9_-]', '_', 'g'), 100) = split_part(name, '/', 2)
      and r.status in ('DRAFT','REJECTED')
  )
)
with check (
  bucket_id = 'vision-assets'
  and exists (
    select 1 from public.vision_user_roles u
    where u.user_id = (select auth.uid())
      and u.is_active = true and u.role in ('ENGINEER','ADMIN')
  )
  and exists (
    select 1 from public.vision_master_revisions r
    join public.vision_masters m on m.id = r.master_id
    where left(regexp_replace(m.id, '[^a-zA-Z0-9_-]', '_', 'g'), 100) = split_part(name, '/', 1)
      and left(regexp_replace(r.id, '[^a-zA-Z0-9_-]', '_', 'g'), 100) = split_part(name, '/', 2)
      and r.status in ('DRAFT','REJECTED')
  )
);

drop policy if exists vision_master_assets_delete on storage.objects;
create policy vision_master_assets_delete on storage.objects
for delete to authenticated
using (
  bucket_id = 'vision-assets'
  and exists (
    select 1 from public.vision_user_roles u
    where u.user_id = (select auth.uid())
      and u.is_active = true and u.role = 'ADMIN'
  )
  and exists (
    select 1 from public.vision_master_revisions r
    join public.vision_masters m on m.id = r.master_id
    where left(regexp_replace(m.id, '[^a-zA-Z0-9_-]', '_', 'g'), 100) = split_part(name, '/', 1)
      and left(regexp_replace(r.id, '[^a-zA-Z0-9_-]', '_', 'g'), 100) = split_part(name, '/', 2)
      and r.status in ('DRAFT','REJECTED')
  )
);
