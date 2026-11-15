-- Private backend hardening for the existing Supabase schema.
-- This migration intentionally creates no public/anonymous access policies.
-- The Edge Function uses the service role on the server side only.

alter table if exists public.print_requests enable row level security;
alter table if exists public.request_files enable row level security;
revoke all on table public.print_requests from anon, authenticated;
revoke all on table public.request_files from anon, authenticated;
grant all on table public.print_requests to service_role;
grant all on table public.request_files to service_role;

-- Ensure the customer-files bucket remains private.
insert into storage.buckets (id, name, public, file_size_limit)
values ('customer-files', 'customer-files', false, 31457280)
on conflict (id) do update set public = false, file_size_limit = 31457280;

-- Do not create storage.objects policies for anon/authenticated.
-- Upload/download access is mediated by short-lived signed URLs issued by app-api.
