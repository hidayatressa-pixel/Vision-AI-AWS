revoke delete on public.vision_user_roles,
  public.vision_masters,
  public.vision_master_revisions,
  public.vision_station_master_assignments
from vision_backend;

grant select, insert, update on public.vision_user_roles to vision_backend;
grant select, insert, update on public.vision_masters to vision_backend;
grant select, insert, update on public.vision_master_revisions to vision_backend;
grant select, insert, update on public.vision_station_master_assignments to vision_backend;
