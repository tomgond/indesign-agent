# Feature 3: Editable Layout Primitives

## Goal

Expose deterministic, typed layout tools that create and modify real editable InDesign structures: live text frames, image placeholder frames, vector shapes, lines, groups, styles, swatches, and geometry.

The external AI agent should not need `execute_indesign_code` for normal template creation.

## Tools to implement or improve

- `create_page`
- `duplicate_page`
- `create_text_frame`
- `create_image_frame`
- `create_shape`
- `create_line`
- `place_image`
- `apply_styles`
- `apply_swatches`
- `set_text_content`
- `set_bounds`
- `move_item`
- `resize_item`
- `rotate_item`
- `lock_item`
- `unlock_item`
- `group_items`
- `ungroup_items`
- `bring_to_front`
- `send_to_back`
- `align_items`
- `distribute_items`
- `fit_content_to_frame`
- `fit_frame_to_content`

## Files to add or modify

Recommended new files:

- `src/handlers/templateHandlers.js`
- `src/types/toolDefinitionsTemplate.js`

Existing files to review and reuse:

- `src/handlers/pageHandlers.js`
- `src/handlers/textHandlers.js`
- `src/handlers/graphicsHandlers.js`
- `src/handlers/pageItemHandlers.js`
- `src/handlers/groupHandlers.js`
- `src/handlers/styleHandlers.js`

Existing risky file tools may be made workspace-safe even if that breaks old arbitrary-path behavior. For layout tools, reuse existing names where possible instead of adding aliases.

## Shared implementation rules

All mutating layout tools must:

1. Load workspace manifest.
2. Validate active document is the working copy.
3. Use only typed parameters, never arbitrary code from the user.
4. Return the created or modified object ID, name, label metadata, bounds, page index, and layer.
5. Allow destructive object edits inside the working copy.
6. Not enforce policy at object level beyond basic validity checks.

## Object lookup strategy

Many tools should accept one of:

- `objectId`
- `name`
- `labelQuery`

Resolution order should be explicit:

1. `objectId` if provided.
2. exact `name` if provided.
3. label match if provided.

If multiple objects match `name` or label, return an error with candidates unless the tool accepts multi-selection.

## Coordinate and bounds model

Adopt a consistent public shape:

```json
{
  "bounds": [top, left, bottom, right],
  "unit": "mm"
}
```

Support `mm` and `pt` for MVP. Convert in UXP or by setting/reading document measurement units carefully.

Validation:

- `bottom > top`
- `right > left`
- no `NaN`, `Infinity`, or non-number values
- reject zero or negative width/height
- optionally warn when bounds are outside page bounds, but do not block unless impossible

## `create_page`

### Inputs

- `width` optional
- `height` optional
- `unit` default `mm`
- `position` default `AT_END`
- `afterPageIndex` optional
- `name` optional
- `derivativeId` optional

### Behavior

1. Validate active document is the working copy.
2. Add a new page using existing page handler logic where possible.
3. Apply page size if width/height are provided.
4. Record derivative page metadata in manifest when `derivativeId` is provided.
5. Return page index, name, size, and derivative ID.

Use this as a friendly alias over existing `add_page` where practical.

## `duplicate_page`

Enhance existing behavior so it can:

- duplicate a base page as a derivative start point,
- optionally assign `derivativeId`,
- optionally move duplicated page to the end,
- return new object/page mappings if practical.

## `create_text_frame`

### Required support

Inputs:

- `pageIndex`
- `bounds`
- `unit`
- `text`
- `paragraphStyle`
- optional `characterStyle`
- optional `objectStyle`
- optional `layer`
- optional `name`
- optional `label`
- optional fill/stroke settings

### Behavior

1. Resolve page.
2. Create a real InDesign text frame.
3. Set geometric bounds.
4. Set contents.
5. Apply paragraph style, character style, and object style if provided.
6. Assign layer if provided, creating it only if the tool explicitly allows layer creation.
7. Set name and label metadata.
8. Return object metadata including overset status.

This tool should not create outlined text or rasterized text.

## `set_text_content`

Inputs:

- object selector
- `text`
- optional `preserveFormatting` default `true`

Behavior:

- Locate a text frame.
- Replace contents.
- Preserve paragraph style by default.
- Return updated excerpt and overset status.

## `create_image_frame`

### Inputs

- `pageIndex`
- `bounds`
- `unit`
- optional `objectStyle`
- optional `layer`
- optional `name`
- optional `label`
- `placeholder` default `true`
- optional `imagePath`
- optional `fitMode`

### Behavior

1. Create a rectangle frame with graphic-frame intent when available.
2. If `placeholder` is true and no image is provided, leave it as a real empty frame with visible placeholder stroke/fill if requested.
3. If `imagePath` is provided, validate it is inside an allowed workspace assets/input location, then place the image.
4. Apply object style and label.
5. Return frame metadata and placed link info if any.

Do not place a target/mockup as final artwork unless the tool is explicitly `create_reference_underlay`.

## `place_image`

Enhance existing `place_image` to be workspace-safe:

- Source image must be inside `workspaceRoot` unless a later explicit asset-import tool copies it in.
- Destination frame must be in the active working copy.
- Return link status, effective PPI, fitting result, and object ID.

## `create_shape`

### Inputs

- `shapeType`: `rectangle`, `oval`, `polygon`
- `pageIndex`
- `bounds` or `points`
- `unit`
- `fillSwatch`
- `strokeSwatch`
- `strokeWeight`
- optional `opacity`
- optional `objectStyle`
- optional `layer`
- optional `name`
- optional `label`

### Behavior

Create a real editable vector object, not a raster image. For polygons, accept points where the API supports them; otherwise create regular polygons for MVP and document limitations in the response warning.

## `create_line`

Inputs:

- `pageIndex`
- `start`
- `end`
- `unit`
- `strokeSwatch`
- `strokeWeight`
- optional arrowhead/endcap if available
- optional layer/name/label

Return editable line object metadata.

## Geometry tools

### `set_bounds`

- Accept object selector and bounds.
- Validate non-zero positive size.
- Convert units.
- Apply to `geometricBounds`.
- Return old and new bounds.

### `move_item`

- Accept object selector and either absolute position or delta.
- Return old and new bounds.

### `resize_item`

- Accept object selector, width/height or scale factors.
- Preserve top-left by default; optionally support anchor points later.

### `rotate_item`

- Accept object selector and degrees.
- Return old/new rotation.

## Z-order tools

- `bring_to_front`
- `send_to_back`

For MVP, support page-item-level front/back. Later versions can add step-forward/backward.

## Group tools

- `group_items`
- `ungroup_items`

Existing group handlers can be wrapped with template safety checks. Return group ID/name and child IDs.

## Fit tools

- `fit_content_to_frame`
- `fit_frame_to_content`

Support common InDesign fitting modes:

- proportionally
- fill frame proportionally
- center content
- fit content to frame
- fit frame to content

Return fitting mode and resulting bounds/link info.

## `align_items`

### Inputs

- `objectIds` or selectors
- `mode`: `left`, `right`, `top`, `bottom`, `centerX`, `centerY`
- `alignTo`: `page`, `spread`, `selection`, `referenceObject`
- `pageIndex` optional
- `referenceObjectId` optional

### Behavior

1. Resolve target items.
2. Resolve reference rectangle:
   - page bounds,
   - spread bounds,
   - selection union,
   - or reference object bounds.
3. Compute target bounds.
4. Move each item without resizing.
5. Return per-item old/new bounds.

## `distribute_items`

### Inputs

- `objectIds` or selectors
- `axis`: `horizontal` or `vertical`
- optional `fixedSpacing`
- optional `within`: `page`, `spread`, or explicit bounds

### Behavior

- Sort items by position on the selected axis.
- If `fixedSpacing` is provided, position items sequentially using that spacing.
- Otherwise distribute evenly within the reference bounds.
- Return per-item old/new bounds.

## `apply_styles`

Inputs:

- object selector
- optional `paragraphStyle`
- optional `characterStyle`
- optional `objectStyle`

Behavior:

- Validate style names exist.
- Apply applicable style types only.
- Return applied style names and warnings for non-applicable style types.

## `apply_swatches`

Inputs:

- object selector
- optional `fillSwatch`
- optional `strokeSwatch`
- optional `strokeWeight`
- optional text fill/stroke targets for text frames

Behavior:

- Validate swatch names exist.
- Apply fill/stroke to object or text as requested.
- Return new color fields.

## Tests for this feature

- `create_text_frame` creates live editable text.
- `create_image_frame` creates a real placeholder frame.
- `place_image` places only workspace assets.
- `create_shape` creates editable vector object.
- `create_line` creates editable vector line.
- `set_bounds` changes object geometry and rejects invalid sizes.
- `move_item`, `resize_item`, and `rotate_item` return old/new geometry.
- `align_items` works against page, spread, and reference object.
- `distribute_items` works horizontally and vertically.
- `apply_styles` applies paragraph, character, and object styles.
- `apply_swatches` applies fill and stroke swatches.
- Group, ungroup, z-order, and fit tools operate only on the working copy.

## Acceptance criteria

- The external agent can build derivatives from typed tools only.
- Created objects are editable InDesign objects.
- Layout adjustments are deterministic and inspectable.
- Existing project handlers are reused where possible, but all template mutations are guarded by active-working-copy validation.
