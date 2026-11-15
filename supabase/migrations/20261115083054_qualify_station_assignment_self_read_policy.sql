drop policy if exists vision_station_master_self_read on public.vision_station_master_assignments;
create policy vision_station_master_self_read on public.vision_station_master_assignments
for select to authenticated
using (
  exists (
    select 1 from public.vision_user_station_access ua
    where ua.user_id = (select auth.uid())
      and ua.is_active = true
      and ua.station_id = public.vision_station_master_assignments.station_id
  )
);
