# Frontend AWS lifecycle integration

The public GitHub Pages build uses the React/Vite application at the repository root.

After deploying `aws/vision-analyzer/template.yaml`, configure these GitHub Actions repository variables:

- `VISION_CONFIG_API_URL`: stack output `VisionConfigurationApi` (`/Prod/config`).
- `VISION_SESSION_API_URL`: stack output `VisionSessionLifecycleApi` (`/Prod/session`).
- `VISION_EVENT_API_URL`: leave unset until a dedicated event-ingestion route exists. The `/Prod/analyze` route expects an `image_base64` image payload and is not compatible with inspection-event JSON.

The Pages workflow injects these URLs at build time. They are public endpoint addresses, not secrets. Never put credentials in `VITE_*` variables.

The demo backend is public and throttled. CORS only controls browser origins; it does not authenticate callers or prevent direct API requests. Do not store confidential production images, customer data, credentials, or sensitive records in this public demonstration. Add real identity, authorization, audit, retention, and abuse controls before using it for private production operations.

The `/config` and `/session` endpoints write JSON records to the private encrypted S3 bucket. They do not create a continuously running Lambda process; the analyzer itself remains event-driven.
