# Vision-AI-AWS FastAPI Backend

This service replaces the AWS Lambda/API Gateway persistence adapter. It does **not** replace the browser-side production inspection decision engine. Alignment, ROI inspection, Rule Engine, and Eight-Point OK/NG/INVALID judgement remain in the frontend until a separately tested parity migration is approved.

## Runtime

- Python 3.12
- FastAPI + Uvicorn
- OpenCV 5 preprocessing diagnostics
- Supabase PostgreSQL via a dedicated database role
- Supabase Auth user verification on protected endpoints

## Required environment variables

- `DATABASE_URL`: Supabase PostgreSQL connection string for the dedicated `vision_backend` role. Prefer the Supabase pooler connection details suitable for a long-running Render service. Keep this secret.
- `SUPABASE_URL`: `https://<project-ref>.supabase.co`.
- `SUPABASE_PUBLISHABLE_KEY`: Supabase publishable key; it is not a service-role key.
- `VISION_ALLOWED_USER_EMAILS`: comma-separated list of operator/admin emails permitted to use the API. The service fails closed if this is empty.
- `VISION_ADMIN_EMAILS`: comma-separated list allowed to clear inspection history.
- `CORS_ORIGINS`: comma-separated allowed browser origins. Defaults to the GitHub Pages origin and local Vite origin.
- `MAX_IMAGE_BYTES`: optional image payload limit; defaults to 8 MiB.
- `PORT`: supplied by the hosting platform; defaults to 10000.

Never put a database password, Supabase secret key, or service-role key in Vite `VITE_*` variables or browser code.

## One-time database role activation

The migrations create `vision_backend` as a restricted `NOLOGIN` role. Before deploying the service, the project owner must set a strong password for this role in the Supabase SQL Editor:

```sql
alter role vision_backend with login password 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD';
```

Use that role name and password in the PostgreSQL connection string. Do not use the `postgres` superuser connection for the running application. The role is not a superuser and does not have `BYPASSRLS`; its RLS access is limited to the four Vision-AI tables through dedicated policies.

## Local run

From the repository root:

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r backend/requirements.txt
uvicorn app.main:app --app-dir backend --reload --port 10000
```

## Endpoints

- `GET /health` — database readiness check.
- `POST /v1/events` — authenticated lifecycle/inspection events.
- `POST /v1/sessions` — authenticated station session events.
- `POST /v1/configurations` and `GET /v1/configurations/{station_id}` — authenticated configuration persistence.
- `POST/GET/DELETE /v1/inspection-history` — authenticated history; delete is admin-only.
- `POST /v1/analyze` — authenticated OpenCV preprocessing diagnostics only. It never returns a product OK/NG judgement.

All `/v1/*` routes require a valid Supabase Auth access token and an email in `VISION_ALLOWED_USER_EMAILS`. Configure the allowed users in Supabase Auth before connecting the frontend.
