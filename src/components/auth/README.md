# Vision-AI Auth

The browser uses Supabase Auth email/password sessions. Self-registration is intentionally not exposed in the UI. Project administrators must create or invite operator accounts in Supabase Dashboard → Authentication → Users.

Configure frontend build variables:
- `VITE_SUPABASE_URL=https://xobhecaqgihobropcers.supabase.co`
- `VITE_SUPABASE_PUBLISHABLE_KEY=<publishable key>`
- `VITE_VISION_API_URL=<deployed FastAPI base URL>`

The API validates the bearer token with Supabase Auth and checks the email against `VISION_ALLOWED_USER_EMAILS`. The frontend publishable key is not a secret. Never expose a Supabase secret/service-role key or PostgreSQL password in Vite variables.
