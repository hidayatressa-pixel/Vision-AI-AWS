# Vision-AI AWS — OpenCV 5 Evidence Analyzer

Public-first Vision-AI AWS demonstration repository. It contains a browser-based inspection UI, OpenCV 5 analyzer, AWS infrastructure definition, tests, and deployment documentation. The separate [Vision-Ai-Prod](https://github.com/hidayatressa-pixel/Vision-Ai-Prod) repository remains the production application; do not use this public demo for confidential production data.

## Purpose

Demonstrate meaningful server-side image analysis using **OpenCV 5 inside an AWS Lambda container**, with two supported input paths:

- API Gateway: `POST /analyze` accepts a JSON body containing `image_base64`.
- Amazon S3: uploaded images under `incoming/` trigger analysis; structured JSON results are written under `results/`.

This analyzer is an evidence/verification component, not the production inspection authority. A passing CI build is not proof of a live AWS deployment.

## OpenCV processing

The analyzer decodes the image, converts it to grayscale, applies Gaussian blur, extracts Canny edges, generates circular candidates using Hough Circles, and reports image dimensions, edge density, OpenCV version, and processing time.

Pinned dependency:

```text
opencv-python-headless==5.0.0.93
```

## AWS components

The AWS SAM template defines:

- **AWS Lambda** — containerized Python image analyzer.
- **Amazon S3** — incoming evidence images and JSON analysis results.
- **API Gateway** — HTTP demonstration route `POST /analyze`.
- **IAM policies** — scoped S3 read/write permissions for the analyzer.

The S3 notification only watches the `incoming/` prefix. Output is stored under `results/` to prevent result objects from recursively triggering analysis.

## Public demo and repository scope

The React/Vite inspection demonstration lives at the repository root (`src/`, `index.html`, and `package.json`) and is published through GitHub Pages. The separate `frontend/` directory is an isolated setup prototype and is not the Pages deployment target. Production application ownership remains in [Vision-Ai-Prod](https://github.com/hidayatressa-pixel/Vision-Ai-Prod).

**Public deployment warning:** anyone can open the demo. Browser-side master data is stored locally and is not an authenticated private database. Do not upload confidential drawings, customer information, credentials, production images, or sensitive inspection records. The engineering PIN was removed from the public build because a `VITE_*` value is visible in downloaded JavaScript and is not authentication.

## Local verification

Requirements: Python 3.12, Docker, and (for infrastructure validation/deployment) AWS SAM CLI.

Install dependencies:

```bash
python -m pip install -r aws/vision-analyzer/requirements.txt
python -m pip install pytest
```

Run all analyzer tests, including the mocked S3 event path:

```bash
pytest -q aws/vision-analyzer/test_app.py tests/test_s3_path.py
```

Validate the SAM template:

```bash
sam validate --lint --template-file aws/vision-analyzer/template.yaml
```

Build the Lambda container and verify its OpenCV major version:

```bash
docker build -t vision-ai-aws-opencv5 aws/vision-analyzer
docker run --rm --entrypoint python vision-ai-aws-opencv5 -c "import cv2; print(cv2.__version__); assert cv2.__version__.startswith('5.')"
```

## Deployment sequence

### 1. GitHub Pages frontend

The workflow `.github/workflows/deploy-pages.yml` builds the root React/Vite application and publishes `dist/` on pushes to `main`. Configure these GitHub Actions repository variables after the AWS API exists:

- `VISION_CONFIG_API_URL` — deployed `/Prod/config` endpoint.
- `VISION_SESSION_API_URL` — deployed `/Prod/session` endpoint.
- `VISION_EVENT_API_URL` — leave unset until a dedicated event-ingestion route exists. `/Prod/analyze` expects an `image_base64` image payload and is not compatible with inspection-event JSON.

These values are public endpoint URLs, not secrets. Never put credentials or private tokens in `VITE_*` variables.

### 2. AWS backend

Infrastructure is defined in `aws/vision-analyzer/template.yaml`. Review account, region, permissions, and cost implications before deployment:

```bash
sam build --template-file aws/vision-analyzer/template.yaml
sam deploy --guided --parameter-overrides AllowedOrigin=https://hidayatressa-pixel.github.io
```

The template provisions Lambda, API Gateway, and a private encrypted S3 evidence bucket. API Gateway is public and throttled; CORS limits browser origins but is **not authentication**. Treat this as a demonstration backend only. Do not send confidential production data until proper user authentication, authorization, retention, and abuse controls are implemented. Deployment creates AWS resources and may incur charges.

### 3. Connect and verify

Copy the `/Prod/config` and `/Prod/session` output URLs from the deployed SAM stack into the GitHub Actions repository variables, then rerun the Pages workflow. Verify `/analyze`, `/config`, and `/session` with non-sensitive test data before claiming an end-to-end deployment.

No live endpoint or end-to-end AWS execution should be claimed until the stack has actually been deployed and tested.

## Continuous integration

The CI workflow tests the frontend and Lambda analyzer, builds the Lambda container, and verifies OpenCV 5. CI does not deploy AWS resources. The Pages workflow publishes the root frontend; AWS SAM deployment remains a separate, explicit operation.

## Evidence status

- [x] OpenCV 5 dependency and container runtime verification in CI
- [x] Meaningful image-analysis pipeline
- [x] AWS SAM infrastructure definition
- [x] API Gateway request-path tests
- [x] Mocked S3 event processing and JSON result tests
- [x] Lambda container build in CI
- [ ] Live AWS deployment evidence
- [ ] End-to-end request and S3 result evidence from a deployed stack
- [ ] Final demonstration recording and submission form

Unchecked items must remain unchecked until the evidence is actually captured.

## Project structure

```text
aws/vision-analyzer/
├── app.py
├── Dockerfile
├── requirements.txt
├── template.yaml
└── test_app.py
.github/workflows/ci.yml
docs/
tests/
README.md
```
