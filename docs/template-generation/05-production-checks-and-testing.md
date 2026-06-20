# Feature 5: Production Checks and MVP Integration Testing

## Goal

Provide basic production-readiness feedback for generated editable templates and prove the MVP workflow works end-to-end on a fixture InDesign document.

Do not overbuild final print certification. The MVP checks should catch obvious issues that block editable template generation: overset text, missing links, missing fonts, visible reference underlays, and unlabeled generated objects.

## Tools to implement

- `check_overset_text`
- `check_missing_links`
- `check_missing_fonts`
- `check_hidden_or_locked_problem_items`
- `run_preflight`
- `run_template_preflight`

## Files to add or modify

Recommended new files:

- `src/handlers/templateHandlers.js`
- `src/types/toolDefinitionsTemplate.js`

Tests:

- `tests/test-template-unit.js`
- `tests/test-template-mvp-flow.js`

## Shared implementation rules

All checks should:

1. Validate active document is the working copy.
2. Return structured results with `ok`, `issues`, and `warnings`.
3. Include page index and object identity where practical.
4. Avoid failing the whole check if one optional InDesign field is unavailable.
5. Be safe to run repeatedly.

## `check_overset_text`

### Output

```json
{
  "ok": false,
  "issues": [
    {
      "objectId": 123,
      "objectName": "speaker_post__body__text",
      "pageIndex": 2,
      "textExcerpt": "Long text...",
      "summary": "Text frame is overset"
    }
  ],
  "warnings": []
}
```

### How to implement

Inside UXP:

1. Iterate all document text frames.
2. For each frame, read `overflows` or equivalent property.
3. If overset, collect object ID/name/page/layer/bounds and a short text excerpt.
4. Return `ok: issues.length === 0`.

If the API exposes story-level overset instead of frame-level, include story ID and best-effort frame mapping.

## `check_missing_links`

### Output

```json
{
  "ok": false,
  "issues": [
    {
      "linkName": "portrait.jpg",
      "status": "missing",
      "objectId": 456,
      "pageIndex": 3,
      "path": "/workspace/assets/portrait.jpg"
    }
  ],
  "warnings": []
}
```

### How to implement

1. Iterate `doc.links`.
2. Normalize status names into `ok`, `missing`, `outdated`, or `unknown`.
3. For missing/outdated links, return link name, status, path, and best-effort owning page item ID/page index.
4. Do not attempt to relink automatically.

## `check_missing_fonts`

### Output

```json
{
  "ok": false,
  "issues": [
    {
      "fontName": "Some Font\tBold",
      "status": "missing",
      "pages": [1, 2],
      "objectIds": [123, 124]
    }
  ],
  "warnings": []
}
```

### How to implement

1. Inspect `doc.fonts` or application font records where available.
2. Detect missing/substituted statuses.
3. If direct mapping from fonts to objects is unavailable, scan text frames and collect first text object usages.
4. Return structured warnings if mapping is partial.

## `check_hidden_or_locked_problem_items`

### Purpose

Find generated objects that are hidden or locked in ways that may block downstream editing.

### Behavior

- Scan named/labeled generated objects.
- Ignore intentionally locked reference underlays.
- Report generated objects that are hidden, locked, or on locked/hidden layers.
- Report visible reference-underlay objects as a production issue.

## `run_preflight`

Wrap existing document preflight functionality where available. Return raw/basic InDesign preflight state plus normalized issues.

This tool may be a thin wrapper around existing `preflight_document`, but should validate the active working copy and return a predictable JSON shape.

## `run_template_preflight`

Aggregate MVP checks:

- overset text
- missing links
- missing fonts
- basic InDesign preflight if accessible
- visible `REFERENCE_UNDERLAY`
- generated objects without labels, where practical
- hidden/locked generated problem items

Output:

```json
{
  "ok": false,
  "summary": {
    "oversetText": 1,
    "missingLinks": 0,
    "missingFonts": 0,
    "visibleReferenceUnderlays": 1,
    "unlabeledGeneratedObjects": 2
  },
  "checks": {
    "oversetText": {},
    "missingLinks": {},
    "missingFonts": {},
    "documentPreflight": {},
    "referenceUnderlay": {},
    "labels": {}
  },
  "issues": [],
  "warnings": []
}
```

## What not to implement in MVP checks

- Bleed/safe-area enforcement.
- Rasterized-layout detector.
- Full PDF/X validation.
- Color profile certification.
- Complex packaging verification.

These can be future feature groups.

## Test plan by requirement

### Workspace safety tests

- Cannot open original for editing.
- Cannot save to original path.
- Cannot write outside `workspaceRoot`.
- Rejects `../` traversal.
- `execute_indesign_code` denied by default.
- Preview exports only to previews folder.
- Version save and rollback work.

### Inspection tests

- `inspect_document_bundle` returns styles, swatches, layers, pages, spreads, links, and fonts.
- `inspect_page_items_v2` returns bounds, type, layer, style, text info, and image info.

### Layout tests

- `create_text_frame` creates live editable text.
- `create_image_frame` creates a real placeholder frame.
- `create_shape` creates editable vector object.
- `set_bounds` changes object geometry.
- `align_items` works on multiple objects.
- `distribute_items` works on multiple objects.
- Labels/names are retrievable.

### Production check tests

- Overset check detects overset text.
- Missing link check returns structured missing/outdated results.
- Missing font check returns structured missing/substituted results.
- Template preflight aggregates the checks and detects visible reference underlay.

### MVP integration test

Create `tests/test-template-mvp-flow.js` to run the required flow:

1. Build or load a base INDD fixture.
2. Initialize workspace.
3. Open working copy.
4. Inspect document and page items.
5. Export and return a base preview.
6. Create derivative `speaker_post`:
   - square/social page
   - live headline/name/title/date text
   - portrait placeholder frame
   - vector/background motif
   - semantic labels
   - preview
   - overset check
   - save version
7. Create derivative `a5_invitation`:
   - A5 page
   - live title/subtitle/date/location/body text
   - editable motifs/shapes
   - placeholders as needed
   - preview
   - overset check
   - save version
8. Create derivative `a3_room_sign`:
   - A3 page
   - large live room name
   - editable directional arrow/vector shape
   - optional session/title text
   - preview
   - overset check
   - save version
9. Run `run_template_preflight`.
10. Roll back to a previous version.
11. Verify original source file checksum is unchanged.
12. Verify all generated files are inside workspace.

First-pass fixture decision:

- Use strategy A: no binary `.indd` fixture yet.
- Add the live integration test scaffold even if it fails for now without a Mac running InDesign/bridge/plugin.
- Include clear comments in the test explaining each expected failure point:
  - Mac/InDesign is not available in the current Linux-only environment.
  - Bridge is not running.
  - UXP plugin is not connected.
  - Real `.indd` fixture and derivative content will be supplied during a later paired live-testing pass.
- Do not hide these issues as successful mock tests. The failing/skipped status should make the live dependency explicit.
- Keep fast Node-only tests separate so path guard, manifest, HTTP transport, and config logic can still be verified before live Mac testing.

Derivative-content decision:

- Do not design or finalize the `speaker_post`, `a5_invitation`, or `a3_room_sign` briefs now.
- Treat the three-derivative flow as a later paired live-testing activity that the user will run when the Mac/InDesign environment is available.
- The first implementation should provide tool capability and test scaffolding, not final creative content.

## Test environment notes

Some tests require a running bridge and InDesign plugin. Separate tests into:

- Fast Node-only tests for `pathGuard`, manifest handling, image metadata, review JSONL, and schema validation.
- Bridge/InDesign integration tests for actual document opening, object creation, preview export, and preflight.

Recommended npm scripts to add later:

```json
{
  "test": "node tests/test-all-handlers.js",
  "test:template:unit": "node tests/test-template-unit.js",
  "test:template:integration": "node tests/test-template-mvp-flow.js"
}
```

If `test:template:integration` is known to fail before the Mac environment exists, document that directly in the test file and in the script description/comments. Do not make the default `npm test` depend on live InDesign until the Mac pass is complete.

## Acceptance criteria

- Production checks return actionable structured issues.
- The three-derivative MVP flow completes on a fixture or generated test document.
- Original INDD remains untouched.
- All outputs remain inside `workspaceRoot`.
- Rollback restores a saved working-copy version.
