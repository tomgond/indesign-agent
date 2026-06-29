---
name: indesign-template-agent
description: Use when creating editable derivative layouts, template pages, or workspace-safe InDesign outputs from a manually designed base .indd using the InDesign MCP workspace flow.
---

# InDesign Template Agent Skill

You use the InDesign MCP to create editable derivative layouts from a manually designed base `.indd`.

Do not create final raster artwork. The final output must be editable InDesign structure: live text frames, image frames/placeholders, vector objects, reused styles/swatches, named/labeled objects, saved versions, and exported previews.

The InDesign document structure is the source of truth. Preview images are feedback only.

## Non-negotiable Rules

Never modify the original `.indd`.

Always work through the protected workspace:
- initialize or verify workspace
- copy original into workspace
- open the working copy
- validate the active document is the working copy
- save the working copy and versions only inside the workspace

Use workspace-safe paths only. Assets belong under `assets/` or `input/`; previews under `previews/`; exports under `exports/`.

Do not use arbitrary filesystem paths.

Before broad or destructive edits, inspect first and target objects by stable identifiers:
- `objectId`
- `name`
- `labelQuery`

Prefer `labelQuery` for agent-created objects.

Use exported previews for document truth. Use structured inspection for geometry, layer, text, and visibility truth. Use live screen capture only for viewport, focus, or UI diagnosis.

Default preview checkpoints to `previewQuality: "checkpoint"`. Use `review` or `final` only when low-res evidence is ambiguous or user review needs it.

After visible mutation batches, validate with cheap preview evidence plus structured inspection. Object creation alone is not visual success.

Do not run layer debugging by default. Use `diagnose_visual_mismatch` only when preview evidence and structured inspection disagree.

Repair visibility and stacking explicitly with `set_item_layer`, `send_to_back`, or `bring_to_front`.
- Treat `derivativeId` as the durable derivative target. Do not carry raw `pageIndex` forward when a derivative can be resolved again before mutation.

Use `update_text_slot` only when text content actually changes. Never call it with `fit:true`.

Do not use `update_text_slot` as a geometry or fitting repair tool. Preserve a known-good text excerpt before risky edits and do not mutate raw duplicated or threaded/shared text frames as normal editable text.

If text fitting is needed, inspect/export first, then call `fit_text_to_frame` separately and check `resolved` and `stillOverset` on the result.

Decorative bleed is opt-in. Keep normal content slots strict unless a call explicitly sets `allowBleed` or `decorative`.

Once one or two targeted repairs fail to improve the preview, or known-good text/motif preservation becomes uncertain, stop salvage work and rebuild from the source anchor instead.

## CSV/Table Template Fill Flow

Use this flow when a finished source page should be copied once per CSV/table row with only text changes.

- Prefer `duplicate_template_page`; it duplicates the complete page through InDesign and preserves its images, placed graphics, shapes, styles, swatches, layers, and geometry as normal duplication allows.
- Do not use `create_derivative_page` as a complete copy. That tool creates a new creative derivative page and optionally copies labeled editable motifs only.
- Label source text frames, for example `{ "slot": "name", "role": "title", "editable": true }`. Duplication patches in the row `derivativeId`, so updates use `{ "derivativeId": "invite_001", "slot": "name" }`.
- Let `scripts/fill_template_from_csv.py` read exact local CSV values. The model chooses config/mapping once and does not manually copy row values.
- Validate/open the working copy, duplicate once per row, call `update_text_slot` by `derivativeId` plus slot, optionally inspect/check/export checkpoint previews, then save.
- Fail on ambiguous duplicate slots and respect threaded/shared/raw text diagnostics. Do not use UI/text-edit automation, selection/current-page targeting, raw page indexes as durable identity, or `update_text_slot` with `fit:true`.

```bash
python scripts/fill_template_from_csv.py --csv examples/template_rows.csv --config examples/template_fill_config.json --out fill_result.json
```

Claim completion only when the runner reports all selected rows processed with no row/slot errors. Final visual success still requires preview and structured inspection; sample previews for large batches. See `docs/template-generation/csv-template-fill.md`.

Live validation on 2026-06-29 exercised the real Mac/InDesign/UXP path for full-page duplication, exact CSV transfer, isolated text replacement, separate fit repair, preview checkpoints, layer moves, asset placement, and derivative identity/page-index drift. The canonical evidence table is in `docs/live-mcp-validation.md`.

## Geometry

Template bounds use InDesign order:

`[top, left, bottom, right]`

Returned geometry is in points.

Use `pt` internally unless the user gives print dimensions in millimeters.

All create tools require `pageIndex`.

Use absolute bounds for layout edits. `resize_item` accepts absolute `bounds`, not `delta`. Use `move_item` for delta moves.

## Base Inspection

Before creating derivatives, inspect enough of the base document to understand:
- page size and margins
- layer structure
- styles
- swatches
- parent pages
- important text hierarchy
- reusable motifs
- image/link usage
- grid and spacing rhythm

Use design-system analysis as a heuristic, not truth. Confirm important conclusions from actual page items and previews.

Before planning a visual derivative from an existing page:

1. validate the working copy
2. inspect source/base-page geometry and key objects
3. export a low-cost checkpoint preview of the source/base page
4. use that preview as the visual anchor for motifs, colors, relative positions, and visible source content
5. do not rely only on copied object IDs or item counts

## Derivative Creation

Create one derivative page per requested output, using a stable filesystem-safe `derivativeId`, for example:

- `speaker_post_01`
- `a5_invitation_01`
- `a3_room_sign_01`
- `poster_01`
- `social_banner_01`

Reuse the base document's visual DNA. Duplicate useful motifs when appropriate; otherwise recreate them as editable InDesign vector/text/image objects.

Do not flatten the design into a PNG. Do not leave generated mockups as final artwork.

Use one clear layer strategy per derivative. Acceptable strategies are:

- build generated objects on `AGENT_WORK` and keep backgrounds behind generated foreground content
- duplicate source motifs/text into a known target layer, then place generated background behind them
- keep source layers untouched and add only safe editable overlays

Do not place full-page generated backgrounds above source text, source motifs, or duplicated content.

After creating a full-page rectangle, image, or background, verify it sits behind the intended visible content.

If a preview becomes blank, solid-color, or missing expected motifs while inspection still shows objects:

1. stop content mutation
2. run `diagnose_visual_mismatch`
3. look for full-page occluders, hidden or nonprinting items, hidden or locked layers, off-page items, and overset text
4. repair with the smallest visibility or z-order change using `set_item_layer`, `send_to_back`, or `bring_to_front`
5. export another checkpoint preview
6. if one or two targeted repairs do not improve the preview, rollback/replan instead of piling on edits

Checkpoint after each visible mutation batch:

- after derivative creation, export a checkpoint preview
- after adding a full-page background, export a checkpoint preview
- after duplicating source motifs or text, inspect plus preview
- after layer or z-order repair, preview again
- before claiming completion, run derivative checks and roundtrip/finalization evidence

Final-state protection:

- once text or content is correct and visible, do not run destructive text updates
- do not run risky fit or autoFit paths after a fit failure in the same session
- do not move text layers unless diagnosing a concrete mismatch
- confirm final state with preview plus inspection before save/finalize

## Editable Objects

Prefer semantic tools:
- `create_text_slot`
- `create_image_slot`
- `create_vector_motif`

Use lower-level frame/shape/line tools only when needed.

Every agent-created object should have:
- meaningful `name`
- semantic `label`
- style/swatch references where possible
- role/slot metadata when applicable

Recommended label pattern:

```json
{
  "derivativeId": "speaker_post_01",
  "role": "title",
  "slot": "speaker_name",
  "source": "agent_created",
  "editable": true
}
```
