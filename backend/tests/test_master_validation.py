import unittest
from unittest.mock import MagicMock

from fastapi import HTTPException

from backend.app.main import (
    _canonical_checksum,
    _validate_master_revision,
    require_station_access,
)


def valid_revision():
    return {
        "masterImagePath": "PRODUCT/REV-01/master-image.png",
        "masterWidth": 1280,
        "masterHeight": 720,
        "detectionZone": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0},
        "tolerance": {
            "maxPositionOffsetMm": 1.0,
            "maxPositionOffsetPx": 8.0,
            "maxRotationToleranceDeg": 3.0,
            "minAlignmentConfidence": 0.7,
            "minScrewConfidence": 0.75,
            "stabilizationDelayMs": 500,
            "stabilizationMotionThreshold": 0.1,
            "partRemovalThreshold": 0.2,
            "detectionZonePresenceThreshold": 0.7,
        },
        "expectedObjectCount": 1,
        "anchors": [],
        "inspectionROIs": [
            {
                "id": "P1",
                "name": "P1",
                "objectType": "screw",
                "x": 0.5,
                "y": 0.5,
                "radius": 0.05,
                "width": 0.1,
                "height": 0.1,
            }
        ],
        "referenceImages": [
            {
                "id": "ok-1",
                "kind": "OK",
                "storagePath": "PRODUCT/REV-01/ok.png",
                "roiLayouts": {"P1": {"x": 0.4, "y": 0.4, "width": 0.2, "height": 0.2}},
            },
            {
                "id": "ng-1",
                "kind": "NG",
                "storagePath": "PRODUCT/REV-01/ng.png",
                "roiLayouts": {"P1": {"x": 0.4, "y": 0.4, "width": 0.2, "height": 0.2}},
            },
        ],
    }


def valid_eight_point_revision():
    payload = valid_revision()
    positions = [
        (0.20, 0.30), (0.40, 0.30), (0.60, 0.30), (0.80, 0.30),
        (0.40, 0.55), (0.60, 0.55),
        (0.40, 0.80), (0.60, 0.80),
    ]
    payload["expectedObjectCount"] = 8
    payload["inspectionROIs"] = []
    layouts = {}
    for index, (x, y) in enumerate(positions, start=1):
        roi_id = f"P{index}"
        payload["inspectionROIs"].append({
            "id": roi_id, "name": roi_id, "objectType": "screw",
            "x": x, "y": y, "radius": 0.025, "width": 0.05, "height": 0.05,
            "expectedObjectPresence": True, "minConfidence": 0.75,
            "minColorSimilarity": 0.55, "colorWeight": 0.15,
        })
        layouts[roi_id] = {"x": x - 0.05, "y": y - 0.05, "width": 0.1, "height": 0.1}
    payload["referenceImages"][0]["roiLayouts"] = layouts
    payload["referenceImages"][1]["roiLayouts"] = layouts
    return payload


class StationAccessTests(unittest.TestCase):
    def test_operator_with_station_assignment_is_allowed(self):
        connection = MagicMock()
        connection.execute.return_value.fetchone.return_value = {"is_active": True}
        pool = MagicMock()
        pool.connection.return_value.__enter__.return_value = connection
        require_station_access({"id": "user-1", "vision_role": "OPERATOR"}, "LINE-01", pool)

    def test_operator_without_station_assignment_is_denied(self):
        connection = MagicMock()
        connection.execute.return_value.fetchone.return_value = None
        pool = MagicMock()
        pool.connection.return_value.__enter__.return_value = connection
        with self.assertRaises(HTTPException) as raised:
            require_station_access({"id": "user-1", "vision_role": "OPERATOR"}, "LINE-02", pool)
        self.assertEqual(raised.exception.status_code, 403)

    def test_engineer_can_manage_stations_without_operator_mapping(self):
        pool = MagicMock()
        require_station_access({"id": "engineer-1", "vision_role": "ENGINEER"}, "LINE-99", pool)
        pool.connection.assert_not_called()


    def test_approver_cannot_operate_a_production_station(self):
        pool = MagicMock()
        with self.assertRaises(HTTPException) as raised:
            require_station_access({"id": "approver-1", "vision_role": "APPROVER"}, "LINE-01", pool)
        self.assertEqual(raised.exception.status_code, 403)
        pool.connection.assert_not_called()


class MasterRevisionValidationTests(unittest.TestCase):
    def test_checksum_ignores_embedded_previous_checksum(self):
        payload = {"revisionCode": "REV-01", "inspectionROIs": [], "checksum": "old-value"}
        changed_metadata = {**payload, "checksum": "different-old-value"}
        self.assertEqual(_canonical_checksum(payload), _canonical_checksum(changed_metadata))

    def test_complete_master_with_positive_and_negative_reference_is_valid(self):
        self.assertEqual(_validate_master_revision(valid_revision()), [])

    def test_expected_object_count_must_match_presence_rois(self):
        payload = valid_revision()
        payload["expectedObjectCount"] = 0
        errors = _validate_master_revision(payload)
        self.assertTrue(any("Expected object count" in error for error in errors))

    def test_missing_negative_reference_is_rejected(self):
        payload = valid_revision()
        payload["referenceImages"] = [payload["referenceImages"][0]]
        errors = _validate_master_revision(payload)
        self.assertTrue(any("negative NG reference" in error for error in errors))

    def test_missing_roi_negative_crop_is_rejected(self):
        payload = valid_revision()
        payload["referenceImages"][1]["roiLayouts"] = {}
        errors = _validate_master_revision(payload)
        self.assertTrue(any("missing a NG reference crop" in error for error in errors))

    def test_inline_base64_image_is_rejected(self):
        payload = valid_revision()
        payload["masterImageUrl"] = "data:image/png;base64,AAAA"
        errors = _validate_master_revision(payload)
        self.assertTrue(any("inline image data" in error for error in errors))

    def test_out_of_bounds_roi_is_rejected(self):
        payload = valid_revision()
        payload["inspectionROIs"][0]["x"] = 0.99
        errors = _validate_master_revision(payload)
        self.assertTrue(any("outside normalized image bounds" in error for error in errors))

    def test_collinear_anchors_are_rejected(self):
        payload = valid_revision()
        payload["anchors"] = [
            {"id": "A", "x": 0.1, "y": 0.1},
            {"id": "B", "x": 0.5, "y": 0.5},
            {"id": "C", "x": 0.9, "y": 0.9},
        ]
        errors = _validate_master_revision(payload)
        self.assertTrue(any("non-collinear" in error for error in errors))

    def test_valid_eight_point_422_layout_is_accepted(self):
        self.assertEqual(_validate_master_revision(valid_eight_point_revision()), [])

    def test_invalid_eight_point_row_distribution_is_rejected(self):
        payload = valid_eight_point_revision()
        payload["inspectionROIs"][6]["y"] = 0.68
        payload["inspectionROIs"][7]["y"] = 0.80
        errors = _validate_master_revision(payload)
        self.assertTrue(any("4-2-2 row layout" in error for error in errors))

    def test_overlapping_eight_point_rois_are_rejected(self):
        payload = valid_eight_point_revision()
        payload["inspectionROIs"][1]["x"] = payload["inspectionROIs"][0]["x"]
        errors = _validate_master_revision(payload)
        self.assertTrue(any("must not overlap" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
