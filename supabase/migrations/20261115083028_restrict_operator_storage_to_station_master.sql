grant select on public.vision_station_master_assignments to authenticated;

drop policy if exists vision_station_master_self_read on public.vision_station_master_assignments;
create policy vision_station_master_self_read on public.vision_station_master_assignments
for select to authenticated
using (
  exists (
    select 1 from public.vision_user_station_access ua
    where ua.user_id = (select auth.uid())
      and ua.is_active = true
      and ua.station_id = station_id
  )
);

drop policy if exists vision_master_assets_read on storage.objects;
create policy vision_master_assets_read on storage.objects
for select to authenticated
using (
  bucket_id = 'vision-assets'
  and (
    exists (
      select 1 from public.vision_user_roles u
      where u.user_id = (select auth.uid())
        and u.is_active = true
        and u.role in ('ENGINEER','APPROVER','ADMIN')
    )
    or exists (
      select 1
      from public.vision_user_station_access ua
      join public.vision_station_master_assignments a on a.station_id = ua.station_id
      where ua.user_id = (select auth.uid())
        and ua.is_active = true
        and left(regexp_replace(a.master_id, '[^a-zA-Z0-9_-]', '_', 'g'), 100) = split_part(name, '/', 1)
        and left(regexp_replace(a.revision_id, '[^a-zA-Z0-9_-]', '_', 'g'), 100) = split_part(name, '/', 2)
    )
  )
);
