# Vision-AI AWS — OpenCV 5 Evidence Analyzer

AWS-focused verification implementation for the Vision-AI project. This repository contains the AWS analyzer, infrastructure definition, tests, and submission evidence documentation. The production frontend and inspection application are maintained separately in [Vision-Ai-Prod](https://github.com/hidayatressa-pixel/Vision-Ai-Prod); their source is not copied into this repository.

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

## Repository scope

This repository is intentionally AWS-only. It does not host or build the production React application, and it does not deploy a frontend to GitHub Pages. Production inspection logic and its UI remain in the separate [Vision-Ai-Prod repository](https://github.com/hidayatressa-pixel/Vision-Ai-Prod).

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

## AWS deployment

Infrastructure is defined in `aws/vision-analyzer/template.yaml`. After reviewing AWS account, region, permissions, and cost implications:

```bash
sam build --template-file aws/vision-analyzer/template.yaml
sam deploy --guided
```

Deployment creates AWS resources and may incur charges. No live endpoint or end-to-end AWS execution should be claimed until the stack has actually been deployed and tested.

## Continuous integration

The `aws-opencv5` GitHub Actions job installs dependencies, runs the API analyzer tests, runs the mocked S3 event test, builds the Lambda container, and verifies OpenCV 5 inside that container. CI does not deploy AWS resources.

## AWS-backed product judgement and evidence

The live inspection path sends the selected camera frame and compact per-ROI OK/NG reference patches to the AWS `/analyze` endpoint. OpenCV on Lambda independently compares every configured ROI against both approved reference classes. Missing references, unreadable patches, out-of-frame ROIs, low similarity, or an uncertain comparison return `INVALID`; they are never upgraded to `OK`.

The PLC result is sent only after AWS returns a product judgement. The browser rule engine is a cross-check: if browser and AWS disagree, the cycle is changed to `INVALID`; if the AWS request fails or times out, the cycle is `ERROR` and the interlock must remain safe. The result and OpenCV measurements are then submitted to `/inspection-result` for encrypted S3 evidence storage. The API response and S3 evidence key are checked before the timeline reports confirmation.

The current ROI classifier is a reference-patch similarity MVP, not a certified production vision model. Validate it with real OK/NG parts, lighting changes, camera shifts, and representative false-positive/false-negative cases before production use. The API endpoints still require server-side authorization before exposure to untrusted clients.

## Security and limitations

- The API currently exposes demonstration routes without an application-level authorizer. Do not expose configuration/session write routes to untrusted users until an authentication strategy compatible with the production frontend is implemented and tested. CORS is not authentication.
- The API's analysis output is a set of image-processing measurements and circle candidates; it is not a validated production OK/NG decision.
- S3 evidence objects are private and encrypted at rest by the SAM template. Verify least-privilege IAM and review cost/retention settings before deployment.
- Never commit AWS credentials, access tokens, production images, or sensitive customer data. Rotate any credential found in Git history.

## Evidence status

- [x] OpenCV 5 dependency and container runtime verification in CI
- [x] Meaningful image-analysis pipeline
- [x] AWS SAM infrastructure definition
- [x] API Gateway request-path tests, including malformed Base64, empty body, and size-limit cases
- [x] Mocked S3 event processing and JSON result tests
- [x] Lambda container build in CI
- [ ] API authentication/authorization validated for production use\n- [ ] Live AWS deployment evidence
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
