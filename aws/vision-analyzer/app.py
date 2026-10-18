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


def _normalize_patch(values: np.ndarray) -> np.ndarray:
    values = values.astype(np.float32)
    mean = float(values.mean()) if values.size else 0.0
    std = float(values.std()) if values.size else 0.0
    scale = max(std, 8.0)
    return np.clip((values - mean) / scale, -2.5, 2.5) / 2.5


def _patch_similarity(reference: np.ndarray, current: np.ndarray, mode: str) -> float:
    ref = _normalize_patch(reference)
    cur = _normalize_patch(current)
    structural = float(np.abs(ref - cur).mean()) / 2.0
    brightness = float(np.abs(reference.astype(np.float32) - current.astype(np.float32)).mean()) / 255.0
    if mode == "STRUCTURE_FIRST":
        difference = structural * 0.92 + brightness * 0.08
    elif mode == "INTENSITY_FIRST":
        difference = structural * 0.25 + brightness * 0.75
    else:
        difference = structural * 0.75 + brightness * 0.25
    return max(0.0, min(1.0, 1.0 - difference))


def _decode_reference_patch(encoded: str):
    raw = base64.b64decode(encoded, validate=True)
    _validate_image_size(raw)
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if image is None:
        return None
    return cv2.resize(image, (64, 64), interpolation=cv2.INTER_AREA)


def _evaluate_configured_rois(image: np.ndarray, config: dict) -> dict:
    rois = config.get("rois")
    if not isinstance(rois, list) or not rois:
        return {"judgement": "INVALID", "primary_reason": "No inspection ROIs were supplied", "expected_count": 0, "detected_count": 0, "roi_results": []}

    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    results = []
    any_ng = False
    any_uncertain = False
    passed_count = 0

    for roi in rois:
        if not isinstance(roi, dict):
            any_uncertain = True
            continue
        roi_id = str(roi.get("id") or "")
        name = str(roi.get("name") or roi_id or "ROI")
        x = float(roi.get("x", -1))
        y = float(roi.get("y", -1))
        roi_w = float(roi.get("width", 0))
        roi_h = float(roi.get("height", 0))
        left = int(round((x - roi_w / 2) * width))
        top = int(round((y - roi_h / 2) * height))
        crop_w = int(round(roi_w * width))
        crop_h = int(round(roi_h * height))
        if (not roi_id or not all(np.isfinite(v) for v in (x, y, roi_w, roi_h)) or
                crop_w < 2 or crop_h < 2 or left < 0 or top < 0 or
                left + crop_w > width or top + crop_h > height):
            any_uncertain = True
            results.append({"roi_id": roi_id, "roi_name": name, "status": "INVALID", "reason": "ROI crop is outside the image or has invalid dimensions"})
            continue

        current = cv2.resize(gray[top:top + crop_h, left:left + crop_w], (64, 64), interpolation=cv2.INTER_AREA)
        references = roi.get("references")
        if not isinstance(references, list):
            references = []
        comparisons = []
        for reference in references:
            if not isinstance(reference, dict) or reference.get("kind") not in ("OK", "NG"):
                continue
            encoded = reference.get("patch_base64")
            if not isinstance(encoded, str) or not encoded:
                continue
            try:
                patch = _decode_reference_patch(encoded)
            except (ValueError, binascii.Error):
                patch = None
            if patch is not None:
                comparisons.append({
                    "kind": reference["kind"],
                    "label": str(reference.get("label") or ""),
                    "similarity": _patch_similarity(patch, current, str(roi.get("comparisonMode") or "BALANCED")),
                })
        ok = [item for item in comparisons if item["kind"] == "OK"]
        ng = [item for item in comparisons if item["kind"] == "NG"]
        if not ok or not ng:
            any_uncertain = True
            results.append({"roi_id": roi_id, "roi_name": name, "status": "INVALID", "reason": "Both readable OK and NG reference patches are required"})
            continue

        best_ok = max(ok, key=lambda item: item["similarity"])
        best_ng = max(ng, key=lambda item: item["similarity"])
        threshold = max(0.5, min(0.98, float(roi.get("minConfidence") or 0.75)))
        if best_ok["similarity"] >= threshold and best_ok["similarity"] > best_ng["similarity"]:
            passed_count += 1
            results.append({"roi_id": roi_id, "roi_name": name, "status": "OK", "confidence": round(best_ok["similarity"], 4), "best_ok_similarity": round(best_ok["similarity"], 4), "best_ng_similarity": round(best_ng["similarity"], 4)})
        elif best_ng["similarity"] >= threshold and best_ng["similarity"] > best_ok["similarity"]:
            any_ng = True
            results.append({"roi_id": roi_id, "roi_name": name, "status": "NG", "confidence": round(best_ng["similarity"], 4), "best_ok_similarity": round(best_ok["similarity"], 4), "best_ng_similarity": round(best_ng["similarity"], 4)})
        else:
            any_uncertain = True
            results.append({"roi_id": roi_id, "roi_name": name, "status": "INVALID", "reason": "Neither approved OK nor NG reference passed the similarity threshold", "best_ok_similarity": round(best_ok["similarity"], 4), "best_ng_similarity": round(best_ng["similarity"], 4)})

    if any_uncertain:
        judgement = "INVALID"
        reason = "AWS OpenCV could not verify every configured ROI with sufficient reference evidence"
    elif any_ng:
        judgement = "NG"
        reason = "AWS OpenCV found at least one ROI matching its approved NG reference"
    elif passed_count == len(rois):
        judgement = "OK"
        reason = f"All {passed_count}/{len(rois)} configured ROIs matched approved OK references"
    else:
        judgement = "INVALID"
        reason = "Not all configured ROIs produced a reliable judgement"

    return {
        "judgement": judgement,
        "primary_reason": reason,
        "expected_count": len(rois),
        "detected_count": passed_count,
        "roi_results": results,
        "decision_source": "aws_opencv_roi_reference",
    }


def analyze_image(raw: bytes, inspection_config: dict | None = None) -> dict:
    """Analyze a frame with OpenCV and optionally classify product ROIs against approved references."""
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

    result = {
        "opencv_version": cv2.__version__,
        "width": int(image.shape[1]),
        "height": int(image.shape[0]),
        "edge_density": round(edge_density, 6),
        "circle_candidates": candidates,
        "processing_ms": round((time.perf_counter() - started) * 1000, 3),
    }
    if inspection_config is not None:
        if not isinstance(inspection_config, dict):
            raise ValueError("inspection_config must be a JSON object")
        result.update(_evaluate_configured_rois(image, inspection_config))
    result["processing_ms"] = round((time.perf_counter() - started) * 1000, 3)
    return result


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
        if request_path.endswith("/inspection-result") or request_path == "/inspection-result":
            payload = _parse_json_body(event)
            if payload.get("action") != "STORE_INSPECTION_RESULT":
                raise ValueError("Unsupported inspection-result action")
            inspection_event = payload.get("event")
            if not isinstance(inspection_event, dict):
                raise ValueError("Missing inspection event")
            status = inspection_event.get("status")
            if status not in ("OK", "NG", "INVALID", "ERROR", "STANDBY"):
                raise ValueError("Invalid inspection status")
            inspection_id = str(inspection_event.get("inspectionId") or "").strip()
            if status != "STANDBY" and not inspection_id:
                raise ValueError("Inspection ID is required for a completed result")
            opencv_analysis = payload.get("opencvAnalysis")
            if status in ("OK", "NG", "INVALID"):
                if not isinstance(opencv_analysis, dict):
                    raise ValueError("Completed inspection requires AWS OpenCV analysis evidence")
                if not isinstance(opencv_analysis.get("opencv_version"), str):
                    raise ValueError("OpenCV analysis version is missing")
                if not isinstance(opencv_analysis.get("circle_candidates"), list):
                    raise ValueError("OpenCV circle candidate list is missing")
                if opencv_analysis.get("judgement") not in ("OK", "NG", "INVALID"):
                    raise ValueError("OpenCV product judgement is missing")
            document = {
                "schema_version": 1,
                "decision_source": str(payload.get("decisionSource") or "unspecified"),
                "received_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "event": inspection_event,
                "opencv_analysis": opencv_analysis,
                "browser_decision": payload.get("browserDecision"),
                "analysis_error": payload.get("analysisError"),
            }
            identity = inspection_id or str(inspection_event.get("jig") or "station")
            key = _store_json_document("inspection-results", document, identity)
            return _response(200, {
                "accepted": True,
                "success": True,
                "key": key,
                "opencv_version": opencv_analysis.get("opencv_version") if isinstance(opencv_analysis, dict) else None,
            })

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
        inspection_config = payload.get("inspection_config")
        result = analyze_image(raw, inspection_config)
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
