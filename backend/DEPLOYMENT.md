# FastAPI deployment checklist

Deploy this service from the repository branch `migration/supabase-fastapi-backend` using Docker:
- Dockerfile: `backend/Dockerfile`
- Docker build context: repository root
- Health check path: `/health`
- Service port: Render supplies `PORT` (default 10000)

## Required runtime environment variables

| Variable | Value |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string using the dedicated `vision_backend` role, not the postgres superuser |
| `SUPABASE_URL` | `https://xobhecaqgihobropcers.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key |
| `VISION_ALLOWED_USER_EMAILS` | `hidayatressa@gmail.com` (comma-separated exact operator emails) |
| `VISION_ADMIN_EMAILS` | `hidayatressa@gmail.com` (comma-separated admin emails) |
| `CORS_ORIGINS` | `https://hidayatressa-pixel.github.io,http://localhost:5173,http://localhost:3000` |
| `MAX_IMAGE_BYTES` | Optional; default 8388608 |

Do not commit any real database password or secret key. Set secrets in Render's Environment settings.

## Supabase database role

The SQL migration creates `vision_backend` as a non-login role. In Supabase SQL Editor, the project owner must set a long random password:

```sql
alter role vision_backend with login password 'PASTE_A_LONG_RANDOM_PASSWORD_HERE';
```

Use the connection details for `vision_backend` in Render's `DATABASE_URL`. If using Supavisor transaction pooling, disable server-side prepared statements (the FastAPI connection pool already sets `prepare_threshold=None`).

## Supabase Auth users

Initial administrator/operator email: `hidayatressa@gmail.com`.

Create this account in Supabase Dashboard → Authentication → Users → Add user → Send invite. The user completes the email invitation and sets their own password. This app intentionally has no public sign-up flow. The backend allowlists this email in both `VISION_ALLOWED_USER_EMAILS` and `VISION_ADMIN_EMAILS`; add additional exact emails only after provisioning them in Supabase Auth.

## Frontend build variables

Set these as GitHub Actions repository variables/secrets for the Pages workflow, or in the frontend hosting build environment:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_VISION_API_URL` (base URL only, no route suffix)

The publishable key is designed for browser use. Never expose the PostgreSQL password, Supabase secret key, or service-role key in any `VITE_*` variable.

## Cutover safety

Keep the existing AWS implementation and main branch unchanged. Do not merge this branch or switch the production frontend until the FastAPI health check, authenticated event/session/configuration/history tests, and inspection-result parity tests have passed.
