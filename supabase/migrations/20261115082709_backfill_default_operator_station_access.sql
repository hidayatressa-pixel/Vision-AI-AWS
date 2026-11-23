insert into public.vision_user_station_access (user_id, station_id, is_active, assigned_by)
select user_id, 'VISION-AI-AWS', true, assigned_by
from public.vision_user_roles
where role = 'OPERATOR' and is_active = true
on conflict (user_id, station_id) do nothing;
