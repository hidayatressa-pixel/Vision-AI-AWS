"""Server-side OpenCV preprocessing stage.

The production OK/NG/INVALID judgement remains in the existing TypeScript
alignment, ROI, rule, and Eight-Point pipeline. This module does not decide
product quality.
"""
import time

import cv2
import numpy as np


class PayloadTooLargeError(ValueError):
    pass


def decode_image(raw: bytes, max_image_bytes: int):
    if len(raw) > max_image_bytes:
        raise PayloadTooLargeError(
            f"Image exceeds the {max_image_bytes}-byte limit"
        )
    if not raw:
        raise ValueError("Image payload is empty")

    array = np.frombuffer(raw, dtype=np.uint8)
    image = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("OpenCV could not decode the supplied image")
    return image


def analyze_image(raw: bytes, max_image_bytes: int) -> dict:
    """Return preprocessing diagnostics; never return an OK/NG judgement."""
    started = time.perf_counter()
    image = decode_image(raw, max_image_bytes)
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
        "judgement": None,
        "judgement_owner": "frontend_eight_point_pipeline",
    }
