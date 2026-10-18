import base64
import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from app import analyze_image, lambda_handler


def make_fixture():
    image = np.full((240, 320, 3), 220, dtype=np.uint8)
    for center in ((80, 80), (160, 80), (240, 160)):
        cv2.circle(image, center, 22, (45, 45, 45), 4)
        cv2.circle(image, center, 7, (90, 90, 90), -1)
    ok, encoded = cv2.imencode(".png", image)
    assert ok
    return encoded.tobytes()


def test_opencv5_is_used():
    assert cv2.__version__.split(".")[0] == "5"


def test_substantial_analysis_returns_candidates():
    result = analyze_image(make_fixture())
    assert result["width"] == 320
    assert result["height"] == 240
    assert result["processing_ms"] >= 0
    assert 0 < result["edge_density"] < 1
    assert isinstance(result["circle_candidates"], list)


def test_api_gateway_demo_path():
    raw = make_fixture()
    event = {
        "body": json.dumps({"image_base64": base64.b64encode(raw).decode("ascii")}),
        "isBase64Encoded": False,
    }
    response = lambda_handler(event, None)
    assert response["statusCode"] == 200
    body = json.loads(response["body"])
    assert body["opencv_version"].split(".")[0] == "5"



def test_api_rejects_oversized_image(monkeypatch):
    import app

    monkeypatch.setattr(app, "MAX_IMAGE_BYTES", 16)
    event = {
        "body": json.dumps({"image_base64": base64.b64encode(make_fixture()).decode("ascii")}),
        "isBase64Encoded": False,
    }
    response = lambda_handler(event, None)
    assert response["statusCode"] == 413
    assert "Image payload exceeds" in response["body"]


def test_api_does_not_leak_internal_exception_details(monkeypatch):
    import app

    def explode(_raw):
        raise RuntimeError("private infrastructure detail")

    monkeypatch.setattr(app, "analyze_image", explode)
    event = {
        "body": json.dumps({"image_base64": base64.b64encode(make_fixture()).decode("ascii")}),
        "isBase64Encoded": False,
    }
    response = lambda_handler(event, None)
    assert response["statusCode"] == 500
    assert "private infrastructure detail" not in response["body"]



def test_malformed_base64_returns_client_error():
    response = lambda_handler(
        {"path": "/analyze", "body": json.dumps({"image_base64": "not valid base64!"})},
        None,
    )
    assert response["statusCode"] == 400
    assert json.loads(response["body"])["error"]


def test_empty_json_body_returns_client_error():
    response = lambda_handler({"path": "/analyze", "body": ""}, None)
    assert response["statusCode"] == 400


def test_image_size_limit_returns_413(monkeypatch):
    import app

    monkeypatch.setattr(app, "MAX_IMAGE_BYTES", 8)
    response = lambda_handler(
        {"path": "/analyze", "body": json.dumps({"image_base64": base64.b64encode(b"x" * 9).decode()})},
        None,
    )
    assert response["statusCode"] == 413
    assert json.loads(response["body"])["max_image_bytes"] == 8


def test_config_requires_expected_action():
    response = lambda_handler(
        {"path": "/config", "body": json.dumps({"action": "UNKNOWN", "configuration": {}})},
        None,
    )
    assert response["statusCode"] == 400


def test_session_rejects_invalid_action():
    response = lambda_handler(
        {"path": "/session", "body": json.dumps({"action": "DELETE_SESSION", "context": {}})},
        None,
    )
    assert response["statusCode"] == 400



def test_inspection_result_requires_opencv_evidence():
    response = lambda_handler(
        {
            "path": "/inspection-result",
            "body": json.dumps({
                "action": "STORE_INSPECTION_RESULT",
                "decisionSource": "browser_rule_engine",
                "event": {
                    "status": "OK",
                    "inspectionId": "INSP-TEST-001",
                    "jig": "STATION-01",
                },
            }),
        },
        None,
    )
    assert response["statusCode"] == 400


def test_inspection_result_stores_confirmed_opencv_evidence(monkeypatch):
    import app

    stored = {}
    def fake_store(prefix, document, identity):
        stored.update({"prefix": prefix, "document": document, "identity": identity})
        return "inspection-results/INSP-TEST-002/result.json"

    monkeypatch.setattr(app, "_store_json_document", fake_store)
    response = lambda_handler(
        {
            "path": "/Prod/inspection-result",
            "body": json.dumps({
                "action": "STORE_INSPECTION_RESULT",
                "decisionSource": "browser_rule_engine",
                "event": {
                    "status": "NG",
                    "inspectionId": "INSP-TEST-002",
                    "jig": "STATION-01",
                    "productCode": "P-01",
                    "revisionCode": "REV-01",
                },
                "opencvAnalysis": {
                    "opencv_version": "5.0.0",
                    "width": 320,
                    "height": 240,
                    "circle_candidates": [],
                    "processing_ms": 2.0,
                    "judgement": "NG",
                    "primary_reason": "Test NG",
                    "roi_results": [],
                },
            }),
        },
        None,
    )
    body = json.loads(response["body"])
    assert response["statusCode"] == 200
    assert body["accepted"] is True
    assert body["success"] is True
    assert body["key"] == "inspection-results/INSP-TEST-002/result.json"
    assert stored["prefix"] == "inspection-results"
    assert stored["document"]["decision_source"] == "browser_rule_engine"
    assert stored["document"]["opencv_analysis"]["opencv_version"] == "5.0.0"


def test_standby_event_can_be_stored_without_frame_analysis(monkeypatch):
    import app
    monkeypatch.setattr(app, "_store_json_document", lambda prefix, document, identity: "sessions/standby.json")
    response = lambda_handler(
        {
            "path": "/inspection-result",
            "body": json.dumps({
                "action": "STORE_INSPECTION_RESULT",
                "event": {"status": "STANDBY", "jig": "STATION-01"},
            }),
        },
        None,
    )
    assert response["statusCode"] == 200
    assert json.loads(response["body"])["accepted"] is True



def _reference_patch_b64(image, encode_format=".png"):
    ok, encoded = cv2.imencode(encode_format, image)
    assert ok
    return base64.b64encode(encoded.tobytes()).decode("ascii")


def test_server_side_roi_judgement_matches_approved_ok_reference():
    import app
    raw = make_fixture()
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    # One ROI centered on a region containing the known circle. Use the same
    # crop as its OK patch; the NG patch is a flat image with different structure.
    x, y, w, h = 80 / 320, 80 / 240, 0.18, 0.18
    crop = image[int((y - h / 2) * 240):int((y + h / 2) * 240),
                 int((x - w / 2) * 320):int((x + w / 2) * 320)]
    ok_patch = cv2.resize(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), (64, 64))
    ng_patch = np.full((64, 64), 220, dtype=np.uint8)
    config = {"rois": [{
        "id": "roi-1", "name": "Circle", "x": x, "y": y, "width": w, "height": h,
        "minConfidence": 0.75, "comparisonMode": "BALANCED",
        "references": [
            {"kind": "OK", "patch_base64": _reference_patch_b64(ok_patch)},
            {"kind": "NG", "patch_base64": _reference_patch_b64(ng_patch)},
        ],
    }]}
    result = app.analyze_image(raw, config)
    assert result["judgement"] == "OK"
    assert result["decision_source"] == "aws_opencv_roi_reference"
    assert result["roi_results"][0]["status"] == "OK"


def test_server_side_roi_without_both_reference_classes_is_invalid():
    import app
    raw = make_fixture()
    config = {"rois": [{
        "id": "roi-1", "name": "Circle", "x": 0.25, "y": 0.33,
        "width": 0.18, "height": 0.18, "references": [],
    }]}
    result = app.analyze_image(raw, config)
    assert result["judgement"] == "INVALID"
    assert result["roi_results"][0]["status"] == "INVALID"
