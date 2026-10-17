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
