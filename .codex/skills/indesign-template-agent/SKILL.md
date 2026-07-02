---
name: indesign-template-agent
description: Use when creating editable derivative layouts, template pages, or workspace-safe InDesign outputs from a manually designed base .indd through the template workspace flow.
---

# InDesign Template Agent

Use this skill when operating on template-generation tasks through the InDesign MCP workspace flow.

The deliverable is editable InDesign structure, not flattened artwork. Preview images are review artifacts only.

## Non-Negotiable Rules

- Never modify the original `.indd`.
- Always work through the protected workspace and the working copy.
- Validate that the active document is the working copy before mutating.
- Use workspace-safe paths only:
  - assets under `assets/` or `input/`
  - previews under `previews/`
  - exports under `exports/`
- Do not use arbitrary filesystem paths.
- Before broad or destructive edits, inspect first and target objects by stable selectors:
  - `objectId`
  - `name`
  - `labelQuery`
- Prefer `labelQuery` for agent-created objects.
- Use exported previews for document truth. Use structured inspection for geometry, layer, text, and visibility truth. Use live screen capture only for viewport, focus, or UI diagnosis.
- Default preview checkpoints to `previewQuality: "checkpoint"`. Use `review` or `final` only when low-res evidence is ambiguous or user review needs it.
- After visible mutation batches, validate with cheap preview evidence plus structured inspection. Object creation alone is not visual success.
- Do not run layer debugging by default. Use `diagnose_visual_mismatch` only when preview evidence and structured inspection disagree.
- Repair visibility and stacking explicitly with `set_item_layer`, `send_to_back`, or `bring_to_front`.
- Treat `derivativeId` as the durable derivative target. Do not carry raw `pageIndex` forward when a derivative can be resolved again before mutation.
- Use `update_text_slot` only when text content actually changes. Never call it with `fit:true`.
- Do not use `update_text_slot` as a geometry or fitting repair tool. Preserve a known-good text excerpt before risky edits and do not mutate raw duplicated or threaded/shared text frames as normal editable text.
- If text fitting is needed, inspect/export first, then call `fit_text_to_frame` separately and check `resolved` and `stillOverset` on the result.
- Decorative bleed is opt-in. Keep normal content slots strict unless a call explicitly sets `allowBleed` or `decorative`.
- Once one or two targeted repairs fail to improve the preview, or known-good text/motif preservation becomes uncertain, stop salvage work and rebuild from the source anchor instead.
- Use the structured `designQualityRubric` as the normal visual-review contract. Its categories are `hierarchy`, `alignment`, `spacing`, `typography`, `contrastColor`, `imageUse`, `styleConsistency`, `editability`, and `productionRisk`; record substantive reviews with `record_visual_review`.
- Treat rubric repairs as bounded constraints, preserve `doNotChange`, and do not redesign unrelated elements.

## Geometry And Coordinates

- Template bounds use InDesign order: `[top, left, bottom, right]`.
- Returned geometry is in points.
- Use `pt` internally unless the user gives print dimensions in millimeters.
- All create tools require `pageIndex`.
- Use absolute bounds for layout edits.
- `resize_item` accepts absolute `bounds`, not `delta`; use `move_item` for delta moves.

## CSV/Table Template Fill Flow

Use this flow when the user has a finished source page and wants many copies with text-only changes.

- Use `duplicate_template_page` by default. It duplicates the complete page through InDesign so images, placed graphics, shapes, styles, swatches, layers, and geometry are preserved as normal duplication allows.
- Do not use `create_derivative_page` as a full-page copy. It creates a new page and optionally copies labeled editable motifs for creative derivative generation.
- Require labeled source text frames, for example `{ "slot": "name", "role": "title", "editable": true }`.
- After duplication, target copied text with `update_text_slot` and `labelQuery: { "derivativeId": "invite_001", "slot": "name" }`.
- Have a deterministic script read CSV/table values. The model chooses mapping/config once and must not manually copy per-row values.
- Run `get_workspace_status`, `open_working_copy`, and `validate_active_document_is_working_copy` before mutation; then duplicate per row, update slots, optionally inspect/check/export checkpoint previews, and save.
- Fail on ambiguous duplicate slots. Keep `textReplacePolicy: "isolatedOnly"`; inspect threaded/shared/raw diagnostics rather than forcing edits.
- Never use UI/text-edit automation, selection/current-page targeting, raw page indexes as durable identity, or `update_text_slot` with `fit:true`.

Minimal runner:

```bash
python scripts/fill_template_from_csv.py --csv examples/template_rows.csv --config examples/template_fill_config.json --out fill_result.json
```

Completion requires processed rows with no row/slot errors. Final visual success still requires preview plus structured inspection; sample checkpoint previews for large batches unless all pages were requested. See `docs/template-generation/csv-template-fill.md`.

Live validation on 2026-06-29 covered the real Mac/InDesign/UXP path for full-page duplication, exact CSV transfer, isolated text replacement, separate fit repair, preview checkpoints, layer moves, asset placement, and derivative identity/page-index drift. See `docs/live-mcp-validation.md` for the canonical evidence table.

## Base Inspection

Before creating derivatives, inspect enough of the base document to understand:

- page size and margins
- layer structure
- styles
- swatches
- parent pages
- important text hierarchy
- reusable motifs
- image and link usage
- grid and spacing rhythm

Use `analyze_design_system` as bounded heuristic evidence, not truth. Call it page-scoped by default with an explicit `pageIndex`. Use summary or standard detail for planning, and reserve `allowHeavyInspection=true` for explicit multi-page or document-wide analysis. Do not request path points, image metadata, text excerpts, hidden items, or deep detail by default. Expect bounded signals such as `typeScale`, `fontUsage`, `colorRoles`, `spacingScale`, `marginHints`, `gridHints`, `motifCandidates`, `imageRoles`, `warnings`, `confidence`, and `provenance`. Confirm important conclusions from real page items and previews.

Before planning a visual derivative from an existing page:

1. validate the working copy
2. inspect source/base-page geometry and key objects
3. export a low-cost checkpoint preview of the source/base page
4. use that preview as the visual anchor for motifs, colors, relative positions, and visible source content
5. do not rely only on copied object IDs or item counts

## Derivative Creation

- Create one derivative page per requested output using a stable filesystem-safe `derivativeId`.
- Reuse the base document's visual DNA.
- Duplicate useful motifs when appropriate; otherwise recreate them as editable text, image, and vector objects.
- Do not flatten the design into a PNG.
- Do not leave generated mockups as the final artwork.
- Use one clear layer strategy per derivative. Acceptable strategies are:
  - build generated objects on `AGENT_WORK` and keep backgrounds behind generated foreground content
  - duplicate source motifs/text into a known target layer, then place generated background behind them
  - keep source layers untouched and add only safe editable overlays
- Do not place full-page generated backgrounds above source text, source motifs, or duplicated content.
- After creating a full-page rectangle, image, or background, verify it sits behind the intended visible content.

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

## Editable Object Rules

Prefer semantic tools first:

- `create_text_slot`
- `create_image_slot`
- `create_vector_motif`

Use lower-level frame, shape, and line tools only when needed.

Every agent-created object should have:

- a meaningful `name`
- a semantic `label`
- style and swatch references where possible
- role or slot metadata when applicable

Recommended label shape:

```json
{
  "derivativeId": "speaker_post_01",
  "role": "title",
  "slot": "speaker_name",
  "source": "agent_created",
  "editable": true
}
```
