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
8. If fitting failed with tool instability, preview and inspection still disagree, or known-good text became damaged, return the derivative for rollback or rebuild instead of finalization.
9. Read the latest visual review with `list_visual_reviews` when available and evaluate unresolved structured rubric findings.

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

Unresolved high-severity design issues block finalization only when `acceptanceImpact` is `userAcceptanceCriteria`, `readability`, `editability`, or `productionSafety`. A `visualQualityOnly` warning does not block unless the user explicitly made that concern an acceptance criterion. The rubric is not a broad taste gate.

Once text or content is correct and visible, final-state protection applies: no destructive text updates, no risky fit paths, and no text-layer moves without a concrete mismatch diagnosis.

## Output Requirements

Return:

- release readiness and a one-line reason
- workspace validation status
- derivative existence, item count, preview state, and latest IDs
- derivative checks, template preflight, and targeted check summaries
- blockers and warnings
- finalization and acceptance results
- recommended next step and responsible role
