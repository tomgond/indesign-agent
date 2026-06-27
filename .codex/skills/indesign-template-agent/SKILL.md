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
- Use exported previews for document truth. Use live screen capture only for viewport, focus, or UI diagnosis.
- Default preview checkpoints to `previewQuality: "checkpoint"`. Use `review` or `final` only when low-res evidence is ambiguous or user review needs it.
- After visible mutation batches, validate with cheap preview evidence plus structured inspection. Object creation alone is not visual success.
- Do not run layer debugging by default. Use `diagnose_visual_mismatch` only when preview evidence and structured inspection disagree.
- Repair visibility and stacking explicitly with `set_item_layer`, `send_to_back`, or `bring_to_front`.
- Use `update_text_slot` only when text content actually changes. Never call it with `fit:true`.
- If text fitting is needed, inspect/export first, then call `fit_text_to_frame` separately.
- If `fit_text_to_frame` fails once with a runtime or syntax error in a session, avoid `autoFit` and fit-based repair paths for the rest of that session.

## Geometry And Coordinates

- Template bounds use InDesign order: `[top, left, bottom, right]`.
- Returned geometry is in points.
- Use `pt` internally unless the user gives print dimensions in millimeters.
- All create tools require `pageIndex`.
- Use absolute bounds for layout edits.
- `resize_item` accepts absolute `bounds`, not `delta`; use `move_item` for delta moves.

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

Use design-system analysis as a heuristic, not truth. Confirm important conclusions from real page items and previews.

## Derivative Creation

- Create one derivative page per requested output using a stable filesystem-safe `derivativeId`.
- Reuse the base document's visual DNA.
- Duplicate useful motifs when appropriate; otherwise recreate them as editable text, image, and vector objects.
- Do not flatten the design into a PNG.
- Do not leave generated mockups as the final artwork.
- Use one clear layer strategy per derivative. Avoid putting full-page generated backgrounds above source text/motifs unless the layer placement or z-order is explicit.

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
