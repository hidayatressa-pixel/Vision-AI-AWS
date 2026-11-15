import unittest

from backend.app.main import _validate_master_revision


def valid_revision():
    return {
        "masterImagePath": "PRODUCT/REV-01/master-image.png",
        "masterWidth": 1280,
        "masterHeight": 720,
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


class MasterRevisionValidationTests(unittest.TestCase):
    def test_complete_master_with_positive_and_negative_reference_is_valid(self):
        self.assertEqual(_validate_master_revision(valid_revision()), [])

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


if __name__ == "__main__":
    unittest.main()
