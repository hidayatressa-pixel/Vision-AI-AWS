import base64
import binascii
import json
import os
import time
import urllib.parse

import boto3
import cv2
import numpy as np

s3 = boto3.client("s3")
OUTPUT_PREFIX = os.getenv("OUTPUT_PREFIX", "results/")
MAX_IMAGE_BYTES = int(os.getenv("MAX_IMAGE_BYTES", str(8 * 1024 * 1024)))


class PayloadTooLargeError(ValueError):
    pass


def _validate_image_size(raw: bytes) -> None:
    if len(raw) > MAX_IMAGE_BYTES:
        raise PayloadTooLargeError(f"Image exceeds the {MAX_IMAGE_BYTES}-byte limit")


def _decode_image(raw: bytes):
    _validate_image_size(raw)
    if not raw:
        raise ValueError("Image payload is empty")
    array = np.frombuffer(raw, dtype=np.uint8)
    image = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("OpenCV could not decode the supplied image")
    return image


def analyze_image(raw: bytes) -> dict:
    """Meaningful server-side OpenCV 5 inspection stage.

    This intentionally mirrors the browser pipeline at a coarse level: decode,
    grayscale, denoise, edge extraction and circular candidate detection. The
    browser-side master/ROI rule engine remains the final production authority.
    """
    started = time.perf_counter()
    image = _decode_image(raw)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 1.2)
    edges = cv2.Canny(blurred, 60, 140)

    circles = cv2.HoughCircles(
        blurred,
        cv2.HOUGH_GRADIENT,
        dp=1.2,
        minDist=18,
        param1=100,
        param2=24,
        minRadius=3,
        maxRadius=max(4, min(image.shape[:2]) // 4),
    )

    edge_density = float(np.count_nonzero(edges)) / float(edges.size or 1)
    candidates = []
    if circles is not None:
        for x, y, radius in np.round(circles[0]).astype(int).tolist():
            candidates.append({"x": int(x), "y": int(y), "radius": int(radius)})

    return {
        "opencv_version": cv2.__version__,
        "width": int(image.shape[1]),
        "height": int(image.shape[0]),
        "edge_density": round(edge_density, 6),
        "circle_candidates": candidates,
        "processing_ms": round((time.perf_counter() - started) * 1000, 3),
    }


def _response(status: int, body: dict):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "OPTIONS,POST"},
        "body": json.dumps(body),
    }


def _analyze_s3_record(record: dict) -> dict:
    bucket = record["s3"]["bucket"]["name"]
    key = urllib.parse.unquote_plus(record["s3"]["object"]["key"])
    obj = s3.get_object(Bucket=bucket, Key=key)
    declared_size = obj.get("ContentLength")
    if isinstance(declared_size, int) and declared_size > MAX_IMAGE_BYTES:
        raise PayloadTooLargeError(f"S3 object exceeds the {MAX_IMAGE_BYTES}-byte limit")
    raw = obj["Body"].read(MAX_IMAGE_BYTES + 1)
    _validate_image_size(raw)
    result = analyze_image(raw)
    result.update({"source": "s3", "bucket": bucket, "key": key})

    result_key = f"{OUTPUT_PREFIX.rstrip('/')}/{key}.json"
    s3.put_object(
        Bucket=bucket,
        Key=result_key,
        Body=json.dumps(result).encode("utf-8"),
        ContentType="application/json",
    )
    return {**result, "result_key": result_key}




def _request_path(event: dict) -> str:
    resource = event.get("resource")
    if isinstance(resource, str) and resource:
        return resource.rstrip("/")
    path = event.get("path") or event.get("rawPath") or ""
    return path.rstrip("/") if isinstance(path, str) else ""


def _parse_json_body(event: dict) -> dict:
    body = event.get("body")
    if not isinstance(body, str) or not body.strip():
        raise ValueError("Missing JSON request body")
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body, validate=True).decode("utf-8")
    payload = json.loads(body)
    if not isinstance(payload, dict):
        raise ValueError("Request body must be a JSON object")
    return payload


def _store_json_document(prefix: str, document: dict, identity: str) -> str:
    bucket = os.getenv("EVIDENCE_BUCKET", "").strip()
    if not bucket:
        raise RuntimeError("EVIDENCE_BUCKET is not configured")
    safe_identity = "".join(ch for ch in identity if ch.isalnum() or ch in "-_")[:80] or "default"
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    key = f"{prefix.rstrip('/')}/{safe_identity}/{stamp}-{int(time.time() * 1000)}.json"
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode("utf-8"),
        ContentType="application/json",
        ServerSideEncryption="AES256",
    )
    return key


def lambda_handler(event, context):
    # S3 -> Lambda path used by the production/demo evidence flow.
    records = event.get("Records", []) if isinstance(event, dict) else []
    if records and records[0].get("eventSource") == "aws:s3":
        results = [_analyze_s3_record(record) for record in records]
        return {"processed": len(results), "results": results}

    # API Gateway path: accept a Base64 image or JSON containing image_base64.
    try:
        if not isinstance(event, dict):
            raise ValueError("Invalid request event")

        request_path = _request_path(event)
        if request_path.endswith("/config") or request_path == "/config":
            payload = _parse_json_body(event)
            if payload.get("action") != "SAVE_CONFIGURATION":
                raise ValueError("Unsupported configuration action")
            configuration = payload.get("configuration")
            if not isinstance(configuration, dict):
                raise ValueError("Missing configuration object")
            serialized = json.dumps(configuration, ensure_ascii=False).encode("utf-8")
            if len(serialized) > 2 * 1024 * 1024:
                raise PayloadTooLargeError("Configuration exceeds the 2 MiB limit")
            station_id = str(configuration.get("stationId") or "default")
            key = _store_json_document("configurations", {
                "action": "SAVE_CONFIGURATION",
                "saved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "configuration": configuration,
            }, station_id)
            return _response(200, {"saved": True, "success": True, "key": key})

        if request_path.endswith("/session") or request_path == "/session":
            payload = _parse_json_body(event)
            action = payload.get("action")
            if action not in ("START_SESSION", "END_SESSION"):
                raise ValueError("Unsupported session action")
            context_data = payload.get("context") or {}
            if not isinstance(context_data, dict):
                raise ValueError("Session context must be a JSON object")
            station_id = str(context_data.get("stationId") or "default")
            key = _store_json_document("sessions", {
                "action": action,
                "received_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "context": context_data,
            }, station_id)
            return _response(200, {"accepted": True, "success": True, "action": action, "key": key})

        payload = _parse_json_body(event)
        image_base64 = payload.get("image_base64")
        if not isinstance(image_base64, str) or not image_base64.strip():
            raise ValueError("Expected JSON containing an image_base64 field")
        raw = base64.b64decode(image_base64, validate=True)

        _validate_image_size(raw)
        result = analyze_image(raw)
        return _response(200, result)

    except PayloadTooLargeError:
        return _response(413, {
            "error": "Image payload exceeds the configured size limit",
            "max_image_bytes": MAX_IMAGE_BYTES,
        })
    except (ValueError, KeyError, json.JSONDecodeError, binascii.Error, UnicodeDecodeError):
        return _response(400, {
            "error": "Invalid image request. Provide a valid encoded image in image_base64.",
            "opencv_version": cv2.__version__,
        })
    except Exception:
        # Do not return exception text, S3 keys, or infrastructure details to callers.
        return _response(500, {
            "error": "Image analysis failed",
            "opencv_version": cv2.__version__,
        })
