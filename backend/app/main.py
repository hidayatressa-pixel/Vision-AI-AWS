from __future__ import annotations

import base64
import hashlib
import json
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from .analyzer import PayloadTooLargeError, analyze_image

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
DATABASE_URL = os.getenv("DATABASE_URL", "")
MAX_IMAGE_BYTES = int(os.getenv("MAX_IMAGE_BYTES", str(8 * 1024 * 1024)))
ALLOWED_EMAILS = {
    value.strip().lower()
    for value in os.getenv("VISION_ALLOWED_USER_EMAILS", "").split(",")
    if value.strip()
}
ADMIN_EMAILS = {
    value.strip().lower()
    for value in os.getenv("VISION_ADMIN_EMAILS", "").split(",")
    if value.strip()
}
CORS_ORIGINS = [
    value.strip()
    for value in os.getenv(
        "CORS_ORIGINS",
        "https://hidayatressa-pixel.github.io,http://localhost:5173,http://localhost:3000",
    ).split(",")
    if value.strip()
]

pool: ConnectionPool | None = None
bearer = HTTPBearer(auto_error=False)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global pool
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is required")
    pool = ConnectionPool(
        conninfo=DATABASE_URL,
        min_size=1,
        max_size=5,
        kwargs={"row_factory": dict_row, "prepare_threshold": None},
        open=False,
    )
    pool.open(wait=True)
    yield
    pool.close()
    pool = None


app = FastAPI(
    title="Vision-AI-AWS Backend",
    version="1.0.0",
    description=(
        "Backend persistence and OpenCV preprocessing. Product judgement remains "
        "owned by the frontend Eight-Point inspection pipeline."
    ),
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


def get_pool() -> ConnectionPool:
    if pool is None:
        raise HTTPException(status_code=503, detail="Database pool is not ready")
    return pool


async def require_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
) -> dict[str, Any]:
    if not credentials or credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="Supabase sign-in required")
    if not SUPABASE_URL or not SUPABASE_PUBLISHABLE_KEY:
        raise HTTPException(status_code=503, detail="Supabase Auth is not configured")
    if not ALLOWED_EMAILS and not ADMIN_EMAILS:
        raise HTTPException(status_code=503, detail="Backend user allowlist is not configured")

    async with httpx.AsyncClient(timeout=8.0) as client:
        response = await client.get(
            f"{SUPABASE_URL}/auth/v1/user",
            headers={
                "apikey": SUPABASE_PUBLISHABLE_KEY,
                "Authorization": f"Bearer {credentials.credentials}",
            },
        )

    if response.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid or expired Supabase session")

    user = response.json()
    email = str(user.get("email") or "").strip().lower()
    if not email or (email not in ALLOWED_EMAILS and email not in ADMIN_EMAILS):
        raise HTTPException(status_code=403, detail="User is not authorized for Vision-AI")
    return user


def resolve_user_role(user: dict[str, Any], db: ConnectionPool) -> str:
    user_id = str(user.get("id") or "")
    email = str(user.get("email") or "").strip().lower()
    with db.connection() as connection:
        if email and email in ADMIN_EMAILS:
            connection.execute(
                """
                insert into public.vision_user_roles (user_id, email, role, is_active)
                values (%s, %s, 'ADMIN', true)
                on conflict (user_id) do update
                  set email = excluded.email, role = 'ADMIN', is_active = true, updated_at = now()
                """,
                (user_id, email),
            )
            return "ADMIN"
        row = connection.execute(
            "select role from public.vision_user_roles where user_id = %s and is_active = true",
            (user_id,),
        ).fetchone()
    return str(row["role"]) if row else "OPERATOR"


def require_roles(*allowed_roles: str):
    def dependency(
        user: dict[str, Any] = Depends(require_user),
        db: ConnectionPool = Depends(get_pool),
    ) -> dict[str, Any]:
        role = resolve_user_role(user, db)
        if role not in allowed_roles:
            raise HTTPException(status_code=403, detail="Insufficient Vision-AI role")
        return {**user, "vision_role": role}
    return dependency


require_engineer = require_roles("ENGINEER", "ADMIN")
require_approver = require_roles("APPROVER", "ADMIN")


async def require_admin(
    user: dict[str, Any] = Depends(require_user),
    db: ConnectionPool = Depends(get_pool),
) -> dict[str, Any]:
    role = resolve_user_role(user, db)
    if role != "ADMIN":
        raise HTTPException(status_code=403, detail="Administrator access required")
    return {**user, "vision_role": role}


class FlexibleModel(BaseModel):
    model_config = ConfigDict(extra="allow")


class VisionEvent(FlexibleModel):
    status: str
    confidence: float = Field(ge=0, le=1)
    mode: str = "CONTINUOUS"
    jig: str
    inspectionId: str | None = None
    timestamp: datetime
    productCode: str | None = None
    revisionCode: str | None = None
    detectedCount: int | None = None
    expectedCount: int | None = None
    reason: str | None = None


class SessionRequest(FlexibleModel):
    action: str
    context: dict[str, Any] = Field(default_factory=dict)
    timestamp: datetime | None = None


class ConfigurationRequest(FlexibleModel):
    action: str = "SAVE_CONFIGURATION"
    configuration: dict[str, Any]


class InspectionHistoryRecord(FlexibleModel):
    id: str
    timestamp: datetime
    product_id: str
    product_code: str
    product_name: str
    master_id: str
    master_revision_id: str
    master_revision_code: str
    judgement: str
    expected_count: int
    detected_count: int
    defects: list[Any] = Field(default_factory=list)
    primary_reason: str = ""
    metrics: dict[str, Any] = Field(default_factory=dict)
    alignment: dict[str, Any] = Field(default_factory=dict)
    roi_results: list[Any] = Field(default_factory=list)
    extra_objects: list[Any] = Field(default_factory=list)
    thumbnail_base64: str | None = None
    device_id: str
    operator_id: str | None = None
    sequence_number: int | None = None
    plc_interlock_state: str | None = None
    plc_comm_latency_ms: float | None = None
    plc_timeline: list[Any] | None = None


class AnalyzeRequest(BaseModel):
    image_base64: str


class MasterSaveRequest(BaseModel):
    master: dict[str, Any]
    revision: dict[str, Any]


class RoleAssignmentRequest(BaseModel):
    email: str
    role: str
    is_active: bool = True


class RevisionDecisionRequest(BaseModel):
    reason: str = ""


class StationAssignmentRequest(BaseModel):
    station_id: str = Field(min_length=1, max_length=120)


@app.get("/health")
def health():
    database_ready = False
    if pool is not None:
        try:
            with pool.connection() as connection:
                connection.execute("select 1")
            database_ready = True
        except Exception:
            database_ready = False
    return {
        "status": "healthy" if database_ready else "degraded",
        "database": "connected" if database_ready else "unavailable",
        "service": "vision-ai-aws-backend",
    }


@app.post("/v1/events", status_code=status.HTTP_202_ACCEPTED)
def create_event(
    payload: VisionEvent,
    user: dict[str, Any] = Depends(require_user),
    db: ConnectionPool = Depends(get_pool),
):
    allowed_statuses = {"OK", "NG", "INVALID", "ERROR", "STANDBY"}
    if payload.status not in allowed_statuses:
        raise HTTPException(status_code=422, detail="Unsupported event status")

    with db.connection() as connection:
        row = connection.execute(
            """
            insert into public.vision_events
              (status, confidence, mode, jig, inspection_id, event_timestamp,
               product_code, revision_code, detected_count, expected_count, reason)
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            returning id
            """,
            (
                payload.status, payload.confidence, payload.mode, payload.jig,
                payload.inspectionId, payload.timestamp, payload.productCode,
                payload.revisionCode, payload.detectedCount, payload.expectedCount,
                payload.reason,
            ),
        ).fetchone()
    return {"accepted": True, "id": str(row["id"])}


@app.post("/v1/sessions", status_code=status.HTTP_202_ACCEPTED)
def create_session(
    payload: SessionRequest,
    user: dict[str, Any] = Depends(require_user),
    db: ConnectionPool = Depends(get_pool),
):
    if payload.action not in {"START_SESSION", "END_SESSION"}:
        raise HTTPException(status_code=422, detail="Unsupported session action")

    context = payload.context
    station_id = str(context.get("stationId") or "VISION-AI-AWS")
    with db.connection() as connection:
        row = connection.execute(
            """
            insert into public.vision_sessions
              (station_id, action, product_code, revision_code, context, event_timestamp)
            values (%s, %s, %s, %s, %s, %s)
            returning id
            """,
            (
                station_id, payload.action, context.get("productCode"),
                context.get("revisionCode"), Jsonb(context),
                payload.timestamp or datetime.now(timezone.utc),
            ),
        ).fetchone()
    return {"accepted": True, "success": True, "action": payload.action, "id": str(row["id"])}


@app.post("/v1/configurations")
def save_configuration(
    payload: ConfigurationRequest,
    user: dict[str, Any] = Depends(require_user),
    db: ConnectionPool = Depends(get_pool),
):
    if payload.action != "SAVE_CONFIGURATION":
        raise HTTPException(status_code=422, detail="Unsupported configuration action")
    serialized = json.dumps(payload.configuration, separators=(",", ":"), ensure_ascii=False)
    if len(serialized.encode("utf-8")) > 2 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Configuration exceeds the 2 MiB limit")

    configuration = payload.configuration
    camera = configuration.get("camera") or {}
    master = configuration.get("master") or {}
    revision = configuration.get("revision") or {}
    station_id = str(configuration.get("stationId") or "VISION-AI-AWS")
    with db.connection() as connection:
        connection.execute(
            """
            insert into public.vision_configurations
              (station_id, setup_step, camera, master, revision, saved_at, updated_at)
            values (%s, %s, %s, %s, %s, %s, now())
            on conflict (station_id) do update set
              setup_step = excluded.setup_step,
              camera = excluded.camera,
              master = excluded.master,
              revision = excluded.revision,
              saved_at = excluded.saved_at,
              updated_at = now()
            """,
            (
                station_id, int(configuration.get("setupStep") or 0),
                Jsonb(camera), Jsonb(master), Jsonb(revision),
                configuration.get("savedAt") or datetime.now(timezone.utc),
            ),
        )
    return {"saved": True, "success": True, "stationId": station_id}


@app.get("/v1/configurations/{station_id}")
def get_configuration(
    station_id: str,
    user: dict[str, Any] = Depends(require_user),
    db: ConnectionPool = Depends(get_pool),
):
    with db.connection() as connection:
        row = connection.execute(
            "select * from public.vision_configurations where station_id = %s",
            (station_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Configuration not found")
    return row


@app.post("/v1/inspection-history", status_code=status.HTTP_201_CREATED)
def save_inspection_history(
    payload: InspectionHistoryRecord,
    user: dict[str, Any] = Depends(require_user),
    db: ConnectionPool = Depends(get_pool),
):
    data = payload.model_dump()
    json_columns = {"defects", "metrics", "alignment", "roi_results", "extra_objects", "plc_timeline"}
    for column in json_columns:
        if data.get(column) is not None:
            data[column] = Jsonb(data[column])

    columns = [
        "id", "timestamp", "product_id", "product_code", "product_name",
        "master_id", "master_revision_id", "master_revision_code", "judgement",
        "expected_count", "detected_count", "defects", "primary_reason", "metrics",
        "alignment", "roi_results", "extra_objects", "thumbnail_base64", "device_id",
        "operator_id", "sequence_number", "plc_interlock_state", "plc_comm_latency_ms",
        "plc_timeline",
    ]
    values = [data.get(column) for column in columns]
    placeholders = ", ".join(["%s"] * len(columns))
    updates = ", ".join(
        f"{column} = excluded.{column}" for column in columns if column != "id"
    )

    with db.connection() as connection:
        connection.execute(
            f"""
            insert into public.inspection_history ({", ".join(columns)})
            values ({placeholders})
            on conflict (id) do update set {updates}
            """,
            values,
        )
    return {"saved": True, "id": payload.id}


@app.get("/v1/inspection-history")
def get_inspection_history(
    limit: int = Query(default=500, ge=1, le=5000),
    user: dict[str, Any] = Depends(require_user),
    db: ConnectionPool = Depends(get_pool),
):
    with db.connection() as connection:
        rows = connection.execute(
            'select * from public.inspection_history order by "timestamp" desc limit %s',
            (limit,),
        ).fetchall()
    return rows


@app.delete("/v1/inspection-history")
def clear_inspection_history(
    user: dict[str, Any] = Depends(require_admin),
    db: ConnectionPool = Depends(get_pool),
):
    with db.connection() as connection:
        result = connection.execute("delete from public.inspection_history")
    return {"deleted": result.rowcount}


@app.post("/v1/analyze")
def analyze(
    payload: AnalyzeRequest,
    user: dict[str, Any] = Depends(require_user),
):
    try:
        raw = base64.b64decode(payload.image_base64, validate=True)
        return analyze_image(raw, MAX_IMAGE_BYTES)
    except PayloadTooLargeError:
        raise HTTPException(status_code=413, detail="Image payload exceeds configured limit")
    except (ValueError, base64.binascii.Error):
        raise HTTPException(status_code=400, detail="Invalid image payload")
