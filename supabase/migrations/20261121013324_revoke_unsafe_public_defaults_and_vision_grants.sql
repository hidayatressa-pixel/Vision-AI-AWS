-- Lock down future public-schema objects created by the PostgreSQL migration owner.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

-- Governance data is backend-managed. Browser clients may only read their own
-- role/station/assignment rows through the existing authenticated RLS policies.
REVOKE ALL PRIVILEGES ON TABLE
  public.vision_user_role_audit_logs,
  public.vision_user_station_audit_logs,
  public.vision_user_roles,
  public.vision_user_station_access,
  public.vision_station_master_assignments
FROM anon, authenticated;

GRANT SELECT ON TABLE
  public.vision_user_roles,
  public.vision_user_station_access,
  public.vision_station_master_assignments
TO authenticated;
