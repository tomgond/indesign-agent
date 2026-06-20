# Feature 4: Semantic Labels, Reference Underlays, and Review State

## Goal

Allow an external AI/vision review loop to refer to specific editable InDesign objects by semantic role, use target/mockup images as temporary non-final guides, and store review outcomes for each derivative.

## Tools to implement

Semantic object tools:

- `rename_page_item`
- `label_object`
- `get_object_label`
- `find_objects_by_label`
- `list_named_objects`

Reference-underlay tools:

- `create_reference_underlay`
- `hide_reference_underlay`
- `remove_reference_underlay`

Visual-review state tools:

- `record_visual_review`
- `list_visual_reviews`
- `mark_derivative_accepted`
- `get_derivative_status`

## Files to add or modify

Recommended new files:

- `src/handlers/templateHandlers.js`
- `src/types/toolDefinitionsTemplate.js`

Add helper files only after duplicate code appears.

## Naming convention

Use this MVP object-name convention:

```text
derivativeId__role__type
```

Examples:

- `speaker_post__headline__text`
- `speaker_post__speaker_name__text`
- `speaker_post__portrait__image_frame`
- `a5_invitation__date__text`
- `room_sign__room_name__text`
- `room_sign__arrow__shape`

Validation:

- `derivativeId`, `role`, and `type` should be lowercase snake-case.
- Reject path-like characters, quotes, and control characters.
- Keep names human-readable; do not use opaque IDs as names unless necessary.

## Label metadata

Labels can be simple JSON key/value metadata stored on page items.

Recommended shape:

```json
{
  "derivativeId": "speaker_post",
  "role": "speaker_name",
  "slot": "name",
  "source": "agent_created",
  "editable": true,
  "placeholder": false
}
```

Required MVP fields:

- `derivativeId`
- `role`
- `source`
- `editable`

Optional fields:

- `slot`
- `placeholder`
- `referenceOnly`
- `createdAt`
- `updatedAt`

## How to store labels in InDesign

Prefer using the InDesign page item label APIs when available. If the API supports only a string label, store a JSON string under one known key or in the item label field.

Implementation approach:

1. Read existing label JSON if present.
2. Merge incoming metadata by default.
3. Validate values are JSON-serializable primitives or arrays/objects of primitives.
4. Write the JSON back to the page item.
5. Return the full label object.

If the UXP API supports `insertLabel(key, value)` and `extractLabel(key)`, use a namespace key such as `mcpTemplateLabel` for the JSON payload.

## `rename_page_item`

Inputs:

- object selector
- `name`
- optional `validateConvention` default `true`

Behavior:

1. Validate active document is working copy.
2. Resolve object.
3. Validate name.
4. Set object name.
5. Return old and new name plus object ID.

## `label_object`

Inputs:

- object selector
- `label`
- optional `merge` default `true`

Behavior:

1. Validate active document is working copy.
2. Resolve object.
3. Read existing metadata.
4. Merge or replace.
5. Write metadata.
6. Return full label metadata.

## `get_object_label`

Inputs:

- object selector

Return the parsed metadata and raw label string if parsing fails.

## `find_objects_by_label`

Inputs:

- label query object, for example `{ "derivativeId": "speaker_post", "role": "speaker_name" }`
- optional `pageIndex`
- optional `includeHidden` default `false`

Behavior:

- Scan page items.
- Parse labels.
- Return objects whose label metadata contains all query fields.
- Include object ID, name, page index, layer, bounds, type, and label.

## `list_named_objects`

Inputs:

- optional `derivativeId`
- optional `pageIndex`
- optional `namePrefix`

Return all named/labeled objects useful to a review loop.

## Reference underlay concept

A reference underlay is a temporary target/mockup guide. It helps the agent align editable objects, but it must never become final artwork.

Rules:

- Create or reuse a layer named `REFERENCE_UNDERLAY`.
- Place target/mockup image on that layer.
- Lock the layer after placement.
- Mark the layer non-printing if the API supports it.
- Label underlay object with `referenceOnly: true`.
- Exclude reference underlays from final production unless intentionally shown for debugging.

## `create_reference_underlay`

Inputs:

- `imagePath` inside `workspaceRoot`
- `pageIndex`
- optional `bounds`
- optional `opacity` default around 35-50
- optional `fitMode`
- optional `derivativeId`

Behavior:

1. Validate active document is working copy.
2. Validate image path is inside workspace.
3. Create or find `REFERENCE_UNDERLAY` layer.
4. Unlock layer temporarily.
5. Place image on the target page.
6. Fit to provided bounds or page bounds.
7. Set opacity if available.
8. Label object as reference-only.
9. Mark layer non-printing if possible.
10. Lock layer.
11. Return underlay object metadata.

## `hide_reference_underlay`

Behavior:

- Set `REFERENCE_UNDERLAY.visible = false`.
- Return layer state and affected object count.

## `remove_reference_underlay`

Behavior:

1. Find `REFERENCE_UNDERLAY` objects with `referenceOnly: true`.
2. Unlock layer temporarily.
3. Remove those objects.
4. Optionally remove layer if empty.
5. Return removed object count.

## Visual review storage

Review records can be stored either in `manifest.json` or in `logs/visual_reviews.jsonl`.

Recommended MVP approach:

- Store a concise derivative status summary in manifest.
- Append full review records to `logs/visual_reviews.jsonl`.

Record shape:

```json
{
  "reviewId": "review_20260619T120000Z",
  "derivativeId": "speaker_post",
  "targetPreviewId": "target_001",
  "indesignPreviewId": "preview_001",
  "brief": "Square speaker announcement with headline, portrait, date",
  "issues": [
    { "severity": "medium", "objectRole": "speaker_name", "summary": "Name is too close to portrait" }
  ],
  "suggestedFixes": [
    { "tool": "move_item", "targetRole": "speaker_name", "summary": "Move 5mm down" }
  ],
  "timestamp": "2026-06-19T12:00:00.000Z"
}
```

## `record_visual_review`

Inputs:

- `derivativeId`
- `targetPreviewId`
- `indesignPreviewId`
- `brief`
- `issues`
- `suggestedFixes`

Behavior:

1. Validate preview IDs or paths refer to workspace previews/logged assets.
2. Validate JSON payload sizes are reasonable.
3. Append review record to `logs/visual_reviews.jsonl`.
4. Update derivative record in manifest with latest review ID/status.
5. Return review record.

## `list_visual_reviews`

Inputs:

- optional `derivativeId`
- optional `limit`

Return review records newest-first or oldest-first consistently. Include parse warnings for malformed JSONL lines rather than failing the whole response.

## `mark_derivative_accepted`

Inputs:

- `derivativeId`
- optional `acceptedPreviewId`
- optional `versionId`
- optional `notes`

Behavior:

- Update derivative status in manifest to `accepted`.
- Record accepted preview/version if provided.
- Return updated derivative record.

## `get_derivative_status`

Inputs:

- `derivativeId`

Return:

- derivative record
- associated page index
- latest preview
- latest version
- latest review
- accepted flag/status
- outstanding issue count if known

## Tests for this feature

- `rename_page_item` sets and returns object name.
- `label_object` writes JSON metadata and merges existing metadata.
- `get_object_label` parses stored metadata.
- `find_objects_by_label` finds objects by derivative and role.
- `list_named_objects` returns named/labeled items.
- `create_reference_underlay` creates locked non-printing reference layer and labeled reference object.
- `hide_reference_underlay` hides the layer.
- `remove_reference_underlay` removes reference-only objects.
- `run_template_preflight` later detects visible reference underlay as a warning/error.
- `record_visual_review` appends JSONL and updates manifest.
- `mark_derivative_accepted` and `get_derivative_status` work from manifest state.

## Acceptance criteria

- Review loops can refer to objects by semantic name or label.
- Target/mockup images can guide layout without becoming final artwork.
- Review outcomes and derivative acceptance state survive MCP restarts.
