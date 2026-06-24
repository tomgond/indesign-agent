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

## Derivative Creation

Create one derivative page per requested output, using a stable filesystem-safe `derivativeId`, for example:

- `speaker_post_01`
- `a5_invitation_01`
- `a3_room_sign_01`
- `poster_01`
- `social_banner_01`

Reuse the base document's visual DNA. Duplicate useful motifs when appropriate; otherwise recreate them as editable InDesign vector/text/image objects.

Do not flatten the design into a PNG. Do not leave generated mockups as final artwork.

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
