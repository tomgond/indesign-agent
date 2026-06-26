# Preflight

Use this reference for production readiness, roundtrip verification, and finalization.

## Mission

Decide whether a derivative is safe to save, finalize, and mark accepted as a real editable InDesign template.

## Checks

- active document safety
- derivative existence
- preview existence
- structured inspection
- overset text
- missing links
- missing fonts
- hidden or locked problem items
- visible reference underlays
- semantic labels on generated objects
- roundtrip persistence
- saved version

## Protocol

1. Validate workspace state.
2. Inspect the derivative and fail if the derivative is missing, empty, uninspectable, or lacks a preview.
3. Run derivative checks with labels required, visible underlays forbidden, overset forbidden, and missing fonts forbidden.
4. Run template preflight plus targeted checks for overset text, missing links, missing fonts, and hidden or locked problem items.
5. Run `verify_template_roundtrip`.
6. Only if all release criteria pass, run `finalize_derivative` and save a version.
7. If finalization succeeds and the resulting evidence is complete, mark the derivative accepted.

## Blocking Criteria

Treat these as blockers:

- active document is not the workspace working copy
- derivative page missing
- derivative page has zero items
- no preview
- no structured inspection
- overset text
- missing font
- visible reference underlay
- unlabeled generated object
- roundtrip verification failure
- finalization failure
- missing required live text slot or image slot
- raster artwork used as the final editable layout
- missing user-required asset

Missing links can be warnings only when intentional placeholder image slots are acceptable for the task.

## Output Requirements

Return:

- release readiness and a one-line reason
- workspace validation status
- derivative existence, item count, preview state, and latest IDs
- derivative checks, template preflight, and targeted check summaries
- blockers and warnings
- finalization and acceptance results
- recommended next step and responsible role
