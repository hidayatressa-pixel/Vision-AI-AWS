# Vision-AI-AWS Master Governance

## Authority model

- Supabase is the source of truth for Master products, revision snapshots, approval history, audit events, and station assignments.
- The frontend's IndexedDB/localStorage is not an operational source of truth. It is read only for one-time migration when an Engineer/Admin signs in.
- Supabase Storage bucket `vision-assets` is private. Master and reference images are stored as object paths in revision JSON; the browser receives temporary signed URLs only.
- `vision_configurations` stores station camera/runtime settings and compact Master/revision identifiers. It is not the Master catalogue.
- A station can start Live Inspection only after FastAPI confirms that the exact approved Master/revision is assigned to that station.
- Inspection events and history include the exact Master and revision IDs. History inserts are idempotent and cannot overwrite an existing record.

## Revision lifecycle

`DRAFT -> PENDING_APPROVAL -> APPROVED` or `PENDING_APPROVAL -> REJECTED -> DRAFT`.

- Drafts can be edited by Engineer/Admin.
- Submission performs server-side geometry, tolerance, reference, Storage-path, and eight-point layout validation.
- Pending revisions are locked by a PostgreSQL trigger.
- Approval is performed by Approver/Admin and the submitter cannot approve or reject their own submission. This is enforced by FastAPI and PostgreSQL.
- Approved revisions are immutable.
- Assignment is a separate action and only APPROVED revisions can be assigned.
- A station assignment cannot be changed while the latest Live Inspection session is active (16-hour crash-recovery window).
- Active revision pointers are station-specific; creating/cloning a draft does not change production.

## Roles

- OPERATOR: read the approved revision assigned to the station and run inspection.
- ENGINEER: create/edit drafts, submit, and assign approved revisions.
- APPROVER: approve/reject pending revisions.
- ADMIN: all governance actions and role assignment.

The first administrator is bootstrapped from the backend `VISION_ADMIN_EMAILS` allowlist. The admin can assign roles from Master Manager > USER ROLES. Obtain the target user's UUID from Supabase Dashboard > Authentication > Users. The target email must also be in `VISION_ALLOWED_USER_EMAILS` unless it is an admin email.

Maker-checker compares the actual submitter UUID with the approver UUID, not just the original draft creator.

## Required environment

### Render backend service

- `DATABASE_URL`: existing least-privilege Vision backend DB connection.
- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`: existing Supabase Auth verification settings.
- `VISION_ALLOWED_USER_EMAILS`: comma-separated users allowed to use the backend.
- `VISION_ADMIN_EMAILS`: comma-separated bootstrap administrator emails.
- `CORS_ORIGINS`: must include `https://vision-ai-aws-trial.onrender.com` and any development origin in use.

Do not put a Supabase service-role key or database superuser credential in the frontend. The backend continues to use the dedicated `vision_backend` database role.

### Render frontend service

- `VITE_VISION_API_URL=https://vision-ai-aws-api.onrender.com`
- `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (or the project's existing publishable-key setting).
- Optional `VITE_VISION_STATION_ID`; defaults to `VISION-AI-AWS`. The same station ID is used for Master assignment, events, sessions, and history.

## Asset constraints

- Private bucket: `vision-assets`.
- Allowed MIME types: JPG, PNG, WEBP.
- Maximum file size: 25 MiB.
- Storage paths are namespaced by Master ID and revision ID.
- Storage RLS allows signed-in Vision users to read, Engineers/Admins to upload/update, and Admins to delete. The legacy `customer-files` bucket is not changed.

## Existing local Master migration

When central Master storage is empty or partially populated, the first Engineer/Admin load imports missing local Master products/revisions and uploads inline image assets to private Storage. Imported revisions become DRAFT; no local active revision is automatically assigned to a production station. An Engineer must review, submit, receive independent approval, and assign it.

If an asset cannot be uploaded (unsupported type, inaccessible blob URL, or over 25 MiB), migration fails closed rather than falling back to local-only inspection. Re-upload the affected image in Master Setup.

## Recognition and judgment rules

For every ROI, the Master stores:
- positive OK reference(s) and negative NG reference(s), each with a crop layout for every ROI;
- ROI geometry, expected presence, shape/texture settings, RGB color similarity threshold, and RGB weight.

The live recognizer compares grayscale structure/shape and RGB chromaticity against the labelled references. If the area, object, or color evidence is unreadable or does not match sufficiently, the ROI returns UNCERTAIN/WARNING and the product result is INVALID. A failure to recognize is never interpreted as absence and never becomes OK.

For eight-point screw inspection, the server also checks the 4-2-2 layout and requires both screw-present OK and screw-absent NG reference crops for every slot.

Color similarity is a deterministic classical-CV signal (normalized RGB chromaticity), not a trained model. Metallic neutral references are treated as color-neutral. Thresholds and weights must be calibrated with representative production images and camera conditions before production use.

## Validation

CI runs:
- TypeScript typecheck and production build;
- recognizer and eight-point adversarial audits;
- Python compile check and Master server-validation unit tests;
- backend auth/CORS and deployed frontend/backend smoke tests.

Passing CI does not prove camera robustness. Before production rollout, verify at least:
1. correct screw-present images under expected lighting;
2. missing screw images with the real empty mounting area;
3. wrong screw/foreign object images;
4. wrong part/background and camera displacement;
5. blur, glare, shadows, exposure and focus variation;
6. two different users/devices and maker-checker approval;
7. assignment change blocked during an active session;
8. history preserves the exact revision ID/checksum used.
