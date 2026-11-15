from __future__ import annotations

import base64
import hashlib
import json
import math
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
        connection.execute(
            """
            insert into public.vision_user_roles (user_id, email, role, is_active)
            values (%s, %s, 'OPERATOR', true)
            on conflict (user_id) do nothing
            """,
            (user_id, email),
        )
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
    stationId: str = "VISION-AI-AWS"
    masterId: str | None = None
    masterRevisionId: str | None = None
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
    station_id: str = "VISION-AI-AWS"
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


class MasterMetadataRequest(BaseModel):
    product_code: str = Field(min_length=1, max_length=120)
    product_name: str = Field(min_length=1, max_length=240)
    description: str = ""


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



def _audit(connection, master_id: str, revision_id: str | None, actor_id: str, action: str,
           details: dict[str, Any] | None = None, station_id: str | None = None) -> None:
    connection.execute(
        """
        insert into public.vision_master_audit_logs
          (master_id, revision_id, station_id, actor_id, action, details)
        values (%s, %s, %s, %s, %s, %s)
        """,
        (master_id, revision_id, station_id, actor_id, action, Jsonb(details or {})),
    )


def _canonical_checksum(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _validate_master_revision(payload: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if not payload.get("masterImagePath"):
        errors.append("Master image must be stored in the private vision-assets bucket")
    width, height = payload.get("masterWidth"), payload.get("masterHeight")
    if not isinstance(width, (int, float)) or not isinstance(height, (int, float)) or not math.isfinite(width) or not math.isfinite(height) or width <= 0 or height <= 0:
        errors.append("Master image dimensions must be positive")

    detection_zone = payload.get("detectionZone")
    if not isinstance(detection_zone, dict):
        errors.append("Detection zone is required")
    else:
        try:
            dx, dy = float(detection_zone["x"]), float(detection_zone["y"])
            dw, dh = float(detection_zone["width"]), float(detection_zone["height"])
            if not all(math.isfinite(v) for v in (dx, dy, dw, dh)) or dx < 0 or dy < 0 or dw <= 0 or dh <= 0 or dx + dw > 1 or dy + dh > 1:
                errors.append("Detection zone must be a valid normalized rectangle")
        except (KeyError, TypeError, ValueError):
            errors.append("Detection zone geometry is invalid")

    tolerance = payload.get("tolerance")
    if not isinstance(tolerance, dict):
        errors.append("Master tolerance configuration is required")
    else:
        bounded = ("minAlignmentConfidence", "minScrewConfidence", "stabilizationMotionThreshold",
                   "partRemovalThreshold", "detectionZonePresenceThreshold")
        for key in bounded:
            value = tolerance.get(key)
            if not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0 or value > 1:
                errors.append(f"Tolerance {key} must be between 0 and 1")
        positive = ("maxPositionOffsetMm", "maxPositionOffsetPx", "maxRotationToleranceDeg")
        for key in positive:
            value = tolerance.get(key)
            if not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                errors.append(f"Tolerance {key} must be positive")
        delay = tolerance.get("stabilizationDelayMs")
        if not isinstance(delay, (int, float)) or not math.isfinite(delay) or delay < 0:
            errors.append("Stabilization delay must be zero or greater")

    if payload.get("roiBoundaryPolicy", "WARNING") not in ("STRICT", "WARNING", "DISABLED"):
        errors.append("ROI boundary policy is invalid")

    rois = payload.get("inspectionROIs")
    if not isinstance(rois, list) or not rois:
        errors.append("At least one inspection ROI is required")
        rois = []
    roi_ids: set[str] = set()
    for roi in rois:
        if not isinstance(roi, dict):
            errors.append("Every ROI must be an object")
            continue
        roi_id = str(roi.get("id") or "")
        if not roi_id or roi_id in roi_ids:
            errors.append("ROI identifiers must be present and unique")
        roi_ids.add(roi_id)
        try:
            x, y = float(roi["x"]), float(roi["y"])
            w = float(roi.get("width") or float(roi["radius"]) * 2)
            h = float(roi.get("height") or float(roi["radius"]) * 2)
            if not all(math.isfinite(v) for v in (x, y, w, h)) or x - w / 2 < 0 or y - h / 2 < 0 or x + w / 2 > 1 or y + h / 2 > 1:
                errors.append(f"ROI {roi_id or '?'} is outside normalized image bounds")
            confidence = roi.get("minConfidence", 0.75)
            color_threshold = roi.get("minColorSimilarity", 0.55)
            color_weight = roi.get("colorWeight", 0.15)
            class_margin = roi.get("minClassMargin", 0.06)
            if not isinstance(confidence, (int, float)) or not 0.5 <= confidence <= 0.98:
                errors.append(f"ROI {roi_id or '?'} similarity threshold must be between 0.5 and 0.98")
            if not isinstance(color_threshold, (int, float)) or not 0.4 <= color_threshold <= 0.98:
                errors.append(f"ROI {roi_id or '?'} color threshold must be between 0.4 and 0.98")
            if not isinstance(color_weight, (int, float)) or not 0.05 <= color_weight <= 0.4:
                errors.append(f"ROI {roi_id or '?'} color weight must be between 0.05 and 0.4")
            if not isinstance(class_margin, (int, float)) or not 0.02 <= class_margin <= 0.3:
                errors.append(f"ROI {roi_id or '?'} class margin must be between 0.02 and 0.3")
        except (KeyError, TypeError, ValueError):
            errors.append(f"ROI {roi_id or '?'} has invalid geometry")

    anchors = payload.get("anchors") or []
    if not isinstance(anchors, list):
        errors.append("Anchors must be a list")
        anchors = []
    if anchors and len(anchors) < 3:
        errors.append("Alignment requires either zero anchors or at least three anchors")
    if len(anchors) >= 3:
        try:
            points = [(float(a["x"]), float(a["y"])) for a in anchors]
            ids = [str(a["id"]) for a in anchors]
            if len(set(ids)) != len(ids) or any(not (0 <= x <= 1 and 0 <= y <= 1) for x, y in points):
                errors.append("Alignment anchors must have unique IDs and normalized coordinates")
            else:
                non_collinear = any(
                    abs((points[j][0]-points[i][0])*(points[k][1]-points[i][1]) -
                        (points[k][0]-points[i][0])*(points[j][1]-points[i][1])) > 1e-6
                    for i in range(len(points)) for j in range(i+1, len(points)) for k in range(j+1, len(points))
                )
                if not non_collinear:
                    errors.append("Alignment anchors must include three non-collinear points")
        except (KeyError, TypeError, ValueError):
            errors.append("Every alignment anchor needs valid coordinates and an ID")

    references = payload.get("referenceImages")
    if not isinstance(references, list):
        references = []
    valid_refs = []
    seen_paths: set[str] = set()
    for ref in references:
        if not isinstance(ref, dict):
            continue
        path = str(ref.get("storagePath") or "")
        if not path or path.startswith("/") or ".." in path.split("/") or path in seen_paths:
            errors.append(f"Reference image {ref.get('id') or '?'} has a missing, duplicate, or unsafe Storage path")
            continue
        seen_paths.add(path)
        if (ref.get("kind") or "OK") not in ("OK", "NG"):
            errors.append(f"Reference image {ref.get('id') or '?'} has an unsupported class")
            continue
        valid_refs.append(ref)
    if not any((ref.get("kind") or "OK") == "OK" for ref in valid_refs):
        errors.append("At least one uploaded positive OK reference is required")
    if not any(ref.get("kind") == "NG" for ref in valid_refs):
        errors.append("At least one uploaded negative NG reference is required")

    screw_rois = [roi for roi in rois if isinstance(roi, dict) and roi.get("objectType") == "screw" and roi.get("expectedObjectPresence") is not False]
    if len(screw_rois) == 8:
        ordered_y = sorted(float(roi["y"]) for roi in screw_rois if isinstance(roi.get("y"), (int, float)))
        rows: list[list[float]] = []
        for center_y in ordered_y:
            if not rows or abs(center_y - sum(rows[-1]) / len(rows[-1])) > 0.08:
                rows.append([center_y])
            else:
                rows[-1].append(center_y)
        if [len(row) for row in rows] != [4, 2, 2]:
            errors.append("Eight-point screw Master must preserve the 4-2-2 row layout")
        for index, first in enumerate(screw_rois):
            for second in screw_rois[index + 1:]:
                fw, fh = float(first.get("width") or float(first["radius"]) * 2), float(first.get("height") or float(first["radius"]) * 2)
                sw, sh = float(second.get("width") or float(second["radius"]) * 2), float(second.get("height") or float(second["radius"]) * 2)
                if abs(float(first["x"]) - float(second["x"])) * 2 < fw + sw and abs(float(first["y"]) - float(second["y"])) * 2 < fh + sh:
                    errors.append("Eight-point screw ROIs must not overlap")
                    break

    for roi_id in roi_ids:
        for kind in ("OK", "NG"):
            matched = [
                ref for ref in valid_refs
                if (ref.get("kind") or "OK") == kind
                and isinstance(ref.get("roiLayouts"), dict)
                and roi_id in ref["roiLayouts"]
            ]
            if not matched:
                errors.append(f"ROI {roi_id} is missing a {kind} reference crop")
            for ref in matched:
                layout = ref["roiLayouts"].get(roi_id) or {}
                try:
                    x, y = float(layout["x"]), float(layout["y"])
                    w, h = float(layout["width"]), float(layout["height"])
                    if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > 1 or y + h > 1:
                        errors.append(f"Reference {ref.get('id')} has an invalid crop for ROI {roi_id}")
                except (KeyError, TypeError, ValueError):
                    errors.append(f"Reference {ref.get('id')} has an invalid crop for ROI {roi_id}")

    serialized = json.dumps(payload, ensure_ascii=False)
    if "data:image/" in serialized or len(serialized.encode("utf-8")) > 2 * 1024 * 1024:
        errors.append("Revision payload contains inline image data or exceeds 2 MiB")
    return errors


@app.get("/v1/me")
def get_current_user(user: dict[str, Any] = Depends(require_user), db: ConnectionPool = Depends(get_pool)):
    role = resolve_user_role(user, db)
    return {"user_id": user.get("id"), "email": user.get("email"), "role": role}


@app.post("/v1/admin/users/{user_id}/role")
def assign_user_role(
    user_id: str, payload: RoleAssignmentRequest,
    user: dict[str, Any] = Depends(require_admin), db: ConnectionPool = Depends(get_pool),
):
    if payload.role not in {"OPERATOR", "ENGINEER", "APPROVER", "ADMIN"}:
        raise HTTPException(status_code=422, detail="Unsupported Vision-AI role")
    actor_id = str(user.get("id"))
    with db.connection() as connection, connection.transaction():
        connection.execute(
            """
            insert into public.vision_user_roles (user_id, email, role, is_active, assigned_by)
            values (%s, %s, %s, %s, %s)
            on conflict (user_id) do update set
              email=excluded.email, role=excluded.role, is_active=excluded.is_active,
              assigned_by=excluded.assigned_by, updated_at=now()
            """,
            (user_id, payload.email.strip().lower(), payload.role, payload.is_active, actor_id),
        )
    return {"assigned": True, "user_id": user_id, "role": payload.role, "is_active": payload.is_active}


@app.get("/v1/masters")
def list_masters(
    station_id: str = Query(default="VISION-AI-AWS", min_length=1, max_length=120),
    user: dict[str, Any] = Depends(require_user), db: ConnectionPool = Depends(get_pool),
):
    with db.connection() as connection:
        rows = connection.execute(
            """
            select m.id, m.product_code, m.product_name, m.description, m.is_active,
                   m.created_by, m.updated_by, m.created_at, m.updated_at,
                   r.id as revision_id, r.revision_code, r.revision_note, r.status,
                   r.revision_payload, r.checksum, r.created_by as revision_created_by,
                   r.approved_by, r.submitted_by, r.created_at as revision_created_at,
                   r.updated_at as revision_updated_at, r.submitted_at, r.approved_at,
                   a.revision_id as assigned_revision_id
            from public.vision_masters m
            left join public.vision_master_revisions r on r.master_id=m.id
            left join public.vision_station_master_assignments a
              on a.master_id=m.id and a.station_id=%s
            order by m.product_code, r.created_at
            """, (station_id,),
        ).fetchall()
    grouped: dict[str, dict[str, Any]] = {}
    for row in rows:
        mid = row["id"]
        if mid not in grouped:
            grouped[mid] = {
                "id": mid, "productCode": row["product_code"], "productName": row["product_name"],
                "description": row["description"], "activeRevisionId": row["assigned_revision_id"] or "",
                "isActive": bool(row["assigned_revision_id"]), "createdAt": row["created_at"].isoformat(),
                "updatedAt": row["updated_at"].isoformat(), "createdBy": str(row["created_by"]), "revisions": [],
            }
        if row["revision_id"]:
            item = dict(row["revision_payload"] or {})
            item.update({
                "id": row["revision_id"], "masterId": mid, "revisionCode": row["revision_code"],
                "revisionNote": row["revision_note"], "createdAt": row["revision_created_at"].isoformat(),
                "updatedAt": row["revision_updated_at"].isoformat(), "createdBy": str(row["revision_created_by"]),
                "status": row["status"], "checksum": row["checksum"],
                "approvedBy": str(row["approved_by"]) if row["approved_by"] else None,
                "submittedAt": row["submitted_at"].isoformat() if row["submitted_at"] else None,
                "submittedBy": str(row["submitted_by"]) if row["submitted_by"] else None,
                "approvedAt": row["approved_at"].isoformat() if row["approved_at"] else None,
            })
            grouped[mid]["revisions"].append(item)
    return list(grouped.values())


@app.patch("/v1/masters/{master_id}")
def update_master_metadata(
    master_id: str, payload: MasterMetadataRequest,
    user: dict[str, Any] = Depends(require_engineer), db: ConnectionPool = Depends(get_pool),
):
    actor = str(user.get("id"))
    with db.connection() as connection, connection.transaction():
        row = connection.execute(
            """update public.vision_masters
               set product_code=%s, product_name=%s, description=%s, updated_by=%s, updated_at=now()
               where id=%s returning id""",
            (payload.product_code.strip(), payload.product_name.strip(), payload.description, actor, master_id),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Master not found")
        _audit(connection, master_id, None, actor, "MASTER_METADATA_UPDATED",
               {"product_code": payload.product_code, "product_name": payload.product_name})
    return {"updated": True, "master_id": master_id}


@app.post("/v1/masters", status_code=status.HTTP_201_CREATED)
def create_master(
    payload: MasterSaveRequest,
    user: dict[str, Any] = Depends(require_engineer), db: ConnectionPool = Depends(get_pool),
):
    master, revision = payload.master, payload.revision
    mid, rid = str(master.get("id") or ""), str(revision.get("id") or "")
    code, name = str(master.get("productCode") or "").strip(), str(master.get("productName") or "").strip()
    if not all((mid, rid, code, name)):
        raise HTTPException(status_code=422, detail="Master/revision identifiers, product code, and name are required")
    actor = str(user.get("id"))
    checksum = _canonical_checksum(revision)
    with db.connection() as connection, connection.transaction():
        connection.execute(
            """insert into public.vision_masters
               (id,product_code,product_name,description,is_active,created_by,updated_by)
               values (%s,%s,%s,%s,true,%s,%s)""",
            (mid, code, name, str(master.get("description") or ""), actor, actor),
        )
        connection.execute(
            """insert into public.vision_master_revisions
               (id,master_id,revision_code,revision_note,status,revision_payload,checksum,created_by)
               values (%s,%s,%s,%s,'DRAFT',%s,%s,%s)""",
            (rid, mid, str(revision.get("revisionCode") or "REV-01"),
             str(revision.get("revisionNote") or ""), Jsonb(revision), checksum, actor),
        )
        _audit(connection, mid, rid, actor, "MASTER_CREATED", {"product_code": code})
    return {"created": True, "master_id": mid, "revision_id": rid, "status": "DRAFT", "checksum": checksum}


@app.put("/v1/masters/{master_id}/revisions/{revision_id}")
def save_master_revision(
    master_id: str, revision_id: str, payload: MasterSaveRequest,
    user: dict[str, Any] = Depends(require_engineer), db: ConnectionPool = Depends(get_pool),
):
    revision = payload.revision
    if str(payload.master.get("id") or "") != master_id or str(revision.get("id") or "") != revision_id:
        raise HTTPException(status_code=422, detail="Master/revision identity mismatch")
    actor, checksum = str(user.get("id")), _canonical_checksum(revision)
    with db.connection() as connection, connection.transaction():
        exists = connection.execute("select id from public.vision_masters where id=%s for update", (master_id,)).fetchone()
        if not exists:
            raise HTTPException(status_code=404, detail="Master not found")
        connection.execute(
            """update public.vision_masters set product_code=%s, product_name=%s,
               description=%s, updated_by=%s, updated_at=now() where id=%s""",
            (str(payload.master.get("productCode") or "").strip(),
             str(payload.master.get("productName") or "").strip(),
             str(payload.master.get("description") or ""), actor, master_id),
        )
        connection.execute(
            """insert into public.vision_master_revisions
               (id,master_id,revision_code,revision_note,status,revision_payload,checksum,created_by)
               values (%s,%s,%s,%s,'DRAFT',%s,%s,%s)
               on conflict (master_id,id) do update set
                 revision_code=excluded.revision_code, revision_note=excluded.revision_note,
                 status='DRAFT', revision_payload=excluded.revision_payload, checksum=excluded.checksum,
                 created_by=excluded.created_by, submitted_at=null, submitted_by=null,
                 approved_by=null, approved_at=null, updated_at=now()
               where vision_master_revisions.status in ('DRAFT','REJECTED')""",
            (revision_id, master_id, str(revision.get("revisionCode") or ""),
             str(revision.get("revisionNote") or ""), Jsonb(revision), checksum, actor),
        )
        saved = connection.execute(
            "select status from public.vision_master_revisions where master_id=%s and id=%s",
            (master_id, revision_id),
        ).fetchone()
        if not saved or saved["status"] != "DRAFT":
            raise HTTPException(status_code=409, detail="Only DRAFT or REJECTED revisions can be edited; clone an approved revision")
        _audit(connection, master_id, revision_id, actor, "MASTER_REVISION_SAVED", {"checksum": checksum})
    return {"saved": True, "status": "DRAFT", "checksum": checksum}


@app.post("/v1/masters/{master_id}/revisions/{revision_id}/submit")
def submit_master_revision(
    master_id: str, revision_id: str,
    user: dict[str, Any] = Depends(require_engineer), db: ConnectionPool = Depends(get_pool),
):
    actor = str(user.get("id"))
    with db.connection() as connection, connection.transaction():
        row = connection.execute(
            "select revision_payload,status from public.vision_master_revisions where master_id=%s and id=%s for update",
            (master_id, revision_id),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Revision not found")
        if row["status"] not in ("DRAFT", "REJECTED"):
            raise HTTPException(status_code=409, detail="Only DRAFT or REJECTED revisions can be submitted")
        errors = _validate_master_revision(dict(row["revision_payload"] or {}))
        if errors:
            raise HTTPException(status_code=422, detail={"message": "Master validation failed", "errors": errors})
        connection.execute(
            "update public.vision_master_revisions set status='PENDING_APPROVAL',submitted_at=now(),submitted_by=%s,updated_at=now() where master_id=%s and id=%s",
            (actor, master_id, revision_id),
        )
        connection.execute(
            "insert into public.vision_master_approvals(master_id,revision_id,action,actor_id) values (%s,%s,'SUBMITTED',%s)",
            (master_id, revision_id, actor),
        )
        _audit(connection, master_id, revision_id, actor, "REVISION_SUBMITTED")
    return {"submitted": True, "status": "PENDING_APPROVAL"}


@app.post("/v1/masters/{master_id}/revisions/{revision_id}/approve")
def approve_master_revision(
    master_id: str, revision_id: str,
    user: dict[str, Any] = Depends(require_approver), db: ConnectionPool = Depends(get_pool),
):
    actor = str(user.get("id"))
    with db.connection() as connection, connection.transaction():
        row = connection.execute(
            "select revision_payload,status,created_by,submitted_by from public.vision_master_revisions where master_id=%s and id=%s for update",
            (master_id, revision_id),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Revision not found")
        if row["status"] != "PENDING_APPROVAL":
            raise HTTPException(status_code=409, detail="Only PENDING_APPROVAL revisions can be approved")
        if str(row["submitted_by"]) == actor:
            raise HTTPException(status_code=403, detail="Maker-checker rule: submitter cannot approve own revision")
        errors = _validate_master_revision(dict(row["revision_payload"] or {}))
        if errors:
            raise HTTPException(status_code=422, detail={"message": "Master validation failed", "errors": errors})
        connection.execute(
            "update public.vision_master_revisions set status='APPROVED',approved_by=%s,approved_at=now(),updated_at=now() where master_id=%s and id=%s",
            (actor, master_id, revision_id),
        )
        connection.execute(
            "insert into public.vision_master_approvals(master_id,revision_id,action,actor_id) values (%s,%s,'APPROVED',%s)",
            (master_id, revision_id, actor),
        )
        _audit(connection, master_id, revision_id, actor, "REVISION_APPROVED")
    return {"approved": True, "status": "APPROVED"}


@app.post("/v1/masters/{master_id}/revisions/{revision_id}/reject")
def reject_master_revision(
    master_id: str, revision_id: str, payload: RevisionDecisionRequest,
    user: dict[str, Any] = Depends(require_approver), db: ConnectionPool = Depends(get_pool),
):
    actor, reason = str(user.get("id")), payload.reason.strip()
    if not reason:
        raise HTTPException(status_code=422, detail="A rejection reason is required")
    with db.connection() as connection, connection.transaction():
        row = connection.execute(
            "select status,created_by,submitted_by from public.vision_master_revisions where master_id=%s and id=%s for update",
            (master_id, revision_id),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Revision not found")
        if row["status"] != "PENDING_APPROVAL":
            raise HTTPException(status_code=409, detail="Only PENDING_APPROVAL revisions can be rejected")
        if str(row["submitted_by"]) == actor:
            raise HTTPException(status_code=403, detail="Maker-checker rule: submitter cannot reject own revision")
        connection.execute(
            "update public.vision_master_revisions set status='REJECTED',updated_at=now() where master_id=%s and id=%s",
            (master_id, revision_id),
        )
        connection.execute(
            "insert into public.vision_master_approvals(master_id,revision_id,action,actor_id,reason) values (%s,%s,'REJECTED',%s,%s)",
            (master_id, revision_id, actor, reason),
        )
        _audit(connection, master_id, revision_id, actor, "REVISION_REJECTED", {"reason": reason})
    return {"rejected": True, "status": "REJECTED"}


@app.post("/v1/masters/{master_id}/revisions/{revision_id}/assign")
def assign_master_revision(
    master_id: str, revision_id: str, payload: StationAssignmentRequest,
    user: dict[str, Any] = Depends(require_engineer), db: ConnectionPool = Depends(get_pool),
):
    actor = str(user.get("id"))
    with db.connection() as connection, connection.transaction():
        row = connection.execute(
            "select status from public.vision_master_revisions where master_id=%s and id=%s for share",
            (master_id, revision_id),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Revision not found")
        if row["status"] != "APPROVED":
            raise HTTPException(status_code=409, detail="Only approved revisions can be assigned to production")
        connection.execute(
            """insert into public.vision_station_master_assignments
               (station_id,master_id,revision_id,activated_by,activated_at)
               values (%s,%s,%s,%s,now())
               on conflict (station_id) do update set master_id=excluded.master_id,
                 revision_id=excluded.revision_id,activated_by=excluded.activated_by,activated_at=now()""",
            (payload.station_id, master_id, revision_id, actor),
        )
        _audit(connection, master_id, revision_id, actor, "REVISION_ASSIGNED_TO_STATION",
               {"station_id": payload.station_id}, payload.station_id)
    return {"assigned": True, "station_id": payload.station_id, "master_id": master_id, "revision_id": revision_id}


@app.get("/v1/stations/{station_id}/master")
def get_station_master(
    station_id: str, user: dict[str, Any] = Depends(require_user), db: ConnectionPool = Depends(get_pool),
):
    with db.connection() as connection:
        row = connection.execute(
            """select m.id as master_id,m.product_code,m.product_name,m.description,
                      r.id as revision_id,r.revision_code,r.revision_payload,r.checksum,a.activated_at
               from public.vision_station_master_assignments a
               join public.vision_masters m on m.id=a.master_id
               join public.vision_master_revisions r on r.master_id=a.master_id and r.id=a.revision_id
               where a.station_id=%s and r.status='APPROVED'""",
            (station_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="No approved Master is assigned to this station")
    return row


@app.post("/v1/events", status_code=status.HTTP_202_ACCEPTED)
def create_event(
    payload: VisionEvent,
    user: dict[str, Any] = Depends(require_user),
    db: ConnectionPool = Depends(get_pool),
):
    allowed_statuses = {"OK", "NG", "INVALID", "ERROR", "STANDBY"}
    if payload.status not in allowed_statuses:
        raise HTTPException(status_code=422, detail="Unsupported event status")

    station_id = payload.stationId or payload.jig
    with db.connection() as connection:
        if payload.status != "STANDBY":
            if not payload.masterId or not payload.masterRevisionId:
                raise HTTPException(status_code=422, detail="Inspection event must include exact Master and revision IDs")
            assignment = connection.execute(
                """
                select 1 from public.vision_station_master_assignments a
                join public.vision_masters m on m.id=a.master_id
                join public.vision_master_revisions r on r.master_id=a.master_id and r.id=a.revision_id
                where a.station_id=%s and a.master_id=%s and a.revision_id=%s
                  and m.product_code=%s and r.revision_code=%s and r.status='APPROVED'
                """,
                (station_id, payload.masterId, payload.masterRevisionId, payload.productCode, payload.revisionCode),
            ).fetchone()
            if not assignment:
                raise HTTPException(status_code=409, detail="Event rejected: station assignment does not match the reported Master revision")
        row = connection.execute(
            """
            insert into public.vision_events
              (status, confidence, mode, jig, station_id, master_id, master_revision_id,
               inspection_id, event_timestamp, product_code, revision_code,
               detected_count, expected_count, reason)
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            returning id
            """,
            (
                payload.status, payload.confidence, payload.mode, payload.jig,
                station_id, payload.masterId, payload.masterRevisionId,
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
    master_id = context.get("masterId")
    revision_id = context.get("masterRevisionId")
    with db.connection() as connection:
        if payload.action == "START_SESSION":
            if not master_id or not revision_id:
                raise HTTPException(status_code=422, detail="Session must include exact Master and revision IDs")
            assignment = connection.execute(
                """
                select 1 from public.vision_station_master_assignments a
                join public.vision_masters m on m.id=a.master_id
                join public.vision_master_revisions r on r.master_id=a.master_id and r.id=a.revision_id
                where a.station_id=%s and a.master_id=%s and a.revision_id=%s
                  and m.product_code=%s and r.revision_code=%s and r.status='APPROVED'
                """,
                (station_id, master_id, revision_id, context.get("productCode"), context.get("revisionCode")),
            ).fetchone()
            if not assignment:
                raise HTTPException(status_code=409, detail="Session rejected: approved Master revision is not assigned to this station")
        row = connection.execute(
            """
            insert into public.vision_sessions
              (station_id, action, master_id, master_revision_id, product_code, revision_code, context, event_timestamp)
            values (%s, %s, %s, %s, %s, %s, %s, %s)
            returning id
            """,
            (
                station_id, payload.action, master_id, revision_id,
                context.get("productCode"), context.get("revisionCode"), Jsonb(context),
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
    master_id = master.get("id")
    revision_id = revision.get("id")
    if not master_id or not revision_id:
        raise HTTPException(status_code=422, detail="Station configuration must reference exact Master and revision IDs")
    with db.connection() as connection:
        assignment = connection.execute(
            "select 1 from public.vision_station_master_assignments where station_id=%s and master_id=%s and revision_id=%s",
            (station_id, master_id, revision_id),
        ).fetchone()
        if not assignment:
            raise HTTPException(status_code=409, detail="Configuration rejected: selected Master revision is not assigned to this station")
        master_snapshot = {key: master.get(key) for key in ("id", "productCode", "productName")}
        revision_snapshot = {key: revision.get(key) for key in ("id", "revisionCode", "checksum")}
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
                Jsonb(camera), Jsonb(master_snapshot), Jsonb(revision_snapshot),
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
    with db.connection() as connection:
        assignment = connection.execute(
            """
            select 1 from public.vision_station_master_assignments
            where station_id=%s and master_id=%s and revision_id=%s
            """,
            (data.get("station_id") or "VISION-AI-AWS", data["master_id"], data["master_revision_id"]),
        ).fetchone()
    if not assignment:
        raise HTTPException(status_code=409, detail="Inspection history rejected: Master revision is not the approved revision assigned to this station")
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
        "plc_timeline", "station_id",
    ]
    values = [data.get(column) for column in columns]
    placeholders = ", ".join(["%s"] * len(columns))
    with db.connection() as connection:
        connection.execute(
            f"""
            insert into public.inspection_history ({", ".join(columns)})
            values ({placeholders})
            on conflict (id) do nothing
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
