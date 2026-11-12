# Eight-Point Screw Presence Inspection

## Scope

This profile checks eight required screw positions on one workpiece. The screw type is common to all eight slots. The workpiece may translate, rotate, and scale within the configured alignment tolerances; the relative screw layout is defined in Master coordinates.

The profile is activated automatically when a Master revision contains exactly eight required inspection ROIs and every ROI is configured as:

- `objectType: "screw"`
- `isRequired: true`
- `expectedObjectPresence: true`

No new database field is required. Existing Master revisions remain compatible unless they meet this exact profile signature.

## Master setup requirements

1. Upload the full-view Master image.
2. Configure exactly eight screw ROIs in the required order: P1–P4 on the first row, P5–P6 on the second row, P7–P8 on the third row.
3. Configure at least three unique, non-collinear fiducial anchors. Four corner anchors are recommended. Set each anchor search radius wide enough to cover the expected whole-workpiece translation, while keeping the search region distinctive enough to avoid matching a neighboring feature.
4. Configure an approved OK reference image showing all expected screw positions. Each reference must have a valid crop layout for all eight ROIs.
5. Set `expectedObjectCount` to 8. The setup validator also checks this value.
6. Keep the ROI rectangles tight enough to isolate the screw head and its immediate seat, but wide enough to tolerate the expected screw-head variation. The Master Setup dialog provides a 4-2-2 starter preset; move and resize its eight ROIs onto the actual screw centers before saving.

For this profile, NG reference images are optional. Missing screws are decided from strong local absence evidence, not from a requirement to upload a separate NG example for every possible missing-screw combination. Existing NG references may still be retained for compatibility and comparison.

## Runtime flow

1. The camera captures the workpiece.
2. AlignmentEngine locates the configured fiducials and calculates a whole-workpiece similarity transform.
3. ROIInspector maps and rectifies each of the eight Master ROIs into the live frame.
4. Each ROI is checked for a screw-like foreground component and compared with the approved OK reference.
5. EightPointPresenceCore maps the eight independent results to P1–P8 and aggregates the final judgement.

The eight-point core does not perform image segmentation itself. It deliberately consumes the existing ROIInspector evidence so there is one visual-feature implementation rather than a second competing detector.

## Evidence and judgement

- `PRESENT + PASS`: point OK.
- `ABSENT`: confirmed missing screw; point NG.
- `PRESENT + FAIL`: an object is present but does not satisfy the approved screw reference; point NG.
- `UNCERTAIN` or missing result: point is inconclusive.

Final judgement:

- OK only when all eight points are PRESENT and PASS.
- NG when any point is confirmed ABSENT or has a confirmed visual mismatch.
- INVALID when no confirmed NG exists but one or more points are uncertain.
- A confirmed NG takes precedence over uncertainty at other points.

The empty-slot evidence gate requires a non-present descriptor with presence confidence >= 0.75 and foreground area ratio <= 0.003. Weak or blurred evidence remains uncertain; it is never promoted to a missing-screw NG.

## Validation and limitations

- Alignment is mandatory for this profile. At least three non-collinear anchors are required; four are recommended.
- A fixed camera profile without anchors remains supported for non-eight-point Master revisions.
- Synthetic CI audits cover 8/8 OK, missing P1/P6/P7/P8, uncertainty, NG precedence, and alignment failure.
- Synthetic tests are not proof of camera performance. Validate with actual camera images under the real lighting, lens, workpiece finish, and placement variation before production use.
- The current design compensates whole-workpiece movement. It does not support each screw moving independently outside its own ROI tolerance.
