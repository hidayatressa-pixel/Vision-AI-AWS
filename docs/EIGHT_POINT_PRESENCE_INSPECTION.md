# Eight-Point Screw Presence Inspection

## Scope

This profile verifies eight required screw positions on one rigid workpiece. All eight positions use the same screw type. The complete workpiece may translate, rotate, and scale within the configured alignment tolerances; the relative positions of the eight screw slots remain fixed in Master coordinates.

The profile is automatically selected when a revision contains exactly eight screw ROIs with expected presence enabled. The validator then enforces the 4-2-2 arrangement, required status, unique IDs, valid bounds, and non-overlapping ROI rectangles.

## Master setup

1. Upload the full-view Master image.
2. Create exactly eight screw ROIs. Arrange four in the top row, two in the middle row, and two in the bottom row.
3. Keep the rectangles centered on each screw head and make sure no two rectangles overlap.
4. Configure at least three unique, non-collinear fiducial anchors. Four corner anchors are recommended. Each anchor's search radius must cover the expected whole-workpiece movement without including ambiguous neighboring features.
5. Upload at least one positive OK reference image showing the expected screws. Ensure every screw ROI has a valid crop in that reference.
6. NG reference images are optional for this presence-only profile. They remain supported for the standard ROI profile.
7. Adjust all starter ROI positions and sizes to the actual Master image before saving.

The engine derives stable point IDs P1–P8 by sorting the ROI centers from top to bottom, then left to right within each row. The IDs do not depend on the order of the ROIs in the saved array.

## Runtime flow

1. The camera captures the workpiece.
2. AlignmentEngine locates the configured fiducial anchors and estimates the whole-workpiece similarity transform.
3. ROIInspector maps and rectifies each Master ROI into the live camera frame.
4. Each slot is checked for strong physical presence evidence and compared with the positive screw Master reference.
5. EightPointPresenceEngine maps the independent ROI evidence to P1–P8 and aggregates the final judgement.

The eight-point engine does not implement a second image segmenter. It reuses the existing ROIInspector so the application has one shared visual-feature pipeline.

## Judgement rules

- OK only when all eight points return PRESENT, PASS, and within tolerance.
- NG when one or more points have confirmed ABSENT evidence.
- INVALID when one or more points are uncertain, unreadable, or do not pass the positive screw-reference check, unless another point is already confirmed missing (NG takes precedence).
- Weak or blurred evidence must never be converted into an automatic OK or NG.

## Validation and limitations

- At least three non-collinear anchors are mandatory for this moving-workpiece profile.
- ROI rectangles must not overlap; otherwise one screw could be counted for two positions.
- The current profile compensates movement of the complete workpiece. It does not support each screw moving independently outside its own ROI.
- Synthetic tests cover the 4-2-2 layout, 8/8 OK, missing screw, uncertainty, NG precedence, stable point numbering, overlapping slots, duplicate IDs, and present-but-unapproved evidence.
- Synthetic tests are not proof of camera accuracy. Validate with actual station images under real lighting, lens, workpiece finish, and placement variation before production use.
