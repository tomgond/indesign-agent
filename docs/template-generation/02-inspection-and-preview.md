# Feature 2: Document Inspection and Preview Loop

## Goal

Give an external AI agent a complete, structured understanding of the base InDesign document and provide preview images that a vision model can compare against target/mockup images.

The key design principle is to return structured JSON, not prose. A design agent should be able to reason over page sizes, layers, styles, swatches, links, fonts, objects, and geometry without using arbitrary JS.

## Tools to implement

Inspection:

- `inspect_document_bundle`
- `inspect_page_items_v2`
- `inspect_styles`
- `inspect_swatches`
- `inspect_layers`
- `inspect_parent_pages`

Preview:

- `export_page_preview`
- `export_spread_preview`
- `return_preview_as_image`

## Files to add or modify

Recommended new files:

- `src/handlers/templateHandlers.js`
- `src/types/toolDefinitionsTemplate.js`
- `src/utils/imageInfo.js`

Existing files to modify:

- `src/types/index.js`
- `src/core/InDesignMCPServer.js`
- `src/handlers/exportHandlers.js` only if preview export should reuse existing export helpers.

## Shared implementation rules

All inspection and preview tools should:

1. Load workspace manifest.
2. Verify active document is `work/current.indd`.
3. Return deterministic JSON with stable field names.
4. Avoid throwing for optional InDesign DOM fields; return `null`, empty arrays, or warnings when unavailable.
5. Include warnings for fields that could not be read.

Preview tools must additionally validate all output paths through the workspace path jail and write only to `workspaceRoot/previews`.

For derivative-generation agents, the intended truth model is:

- exported preview = document/export/layout truth
- structured inspection = object/layer/text/geometry/visibility truth
- live screenshot = viewport/focus/UI diagnosis only

Before planning a derivative from an existing page, validate the working copy, inspect source/base-page geometry and key objects, export a low-cost checkpoint preview of the source/base page, and use that preview as the visual anchor. Do not rely only on copied object IDs or item counts.

## `inspect_document_bundle`

### Purpose

Return a single high-level inventory of the base or working document so a design agent can understand the document system before editing.

### Output shape

```json
{
  "success": true,
  "document": {
    "name": "current.indd",
    "path": "/workspace/work/current.indd",
    "units": { "horizontal": "MILLIMETERS", "vertical": "MILLIMETERS" },
    "pageCount": 4,
    "facingPages": false,
    "bleed": {},
    "slug": {},
    "preflight": {}
  },
  "pages": [],
  "spreads": [],
  "layers": [],
  "swatches": [],
  "styles": {
    "paragraph": [],
    "character": [],
    "object": [],
    "table": [],
    "cell": []
  },
  "parentPages": [],
  "fonts": [],
  "links": [],
  "warnings": []
}
```

### How to implement

Inside a UXP snippet:

1. Read `app.activeDocument`.
2. Read document name/path and preference objects.
3. Iterate `doc.pages` with `.item(i)` and collect:
   - index
   - name
   - bounds
   - width/height
   - applied parent/master if available
   - margins if available
4. Iterate `doc.spreads` and collect:
   - index
   - name
   - page indices/names
   - bounds if available
5. Call helper functions for styles, swatches, layers, parent pages, links, and fonts.
6. Return partial data even if one collection fails.

Implementation should use local UXP helper functions like `safeRead(fn, fallback)` and `collectionToArray(collection, mapper)` to avoid repeated try/catch boilerplate.

## `inspect_page_items_v2`

### Inputs

- `pageIndex` optional
- `spreadIndex` optional
- `includeTextExcerpt` default `true`
- `includeHidden` default `false`
- `includeParentItems` default `false`

Exactly one of `pageIndex` or `spreadIndex` can be provided. If neither is provided, inspect all regular page items in the active document.

### Output item shape

```json
{
  "id": 123,
  "name": "speaker_post__headline__text",
  "type": "TextFrame",
  "pageIndex": 0,
  "spreadIndex": 0,
  "layerName": "Text",
  "bounds": [0, 0, 50, 100],
  "geometricBounds": [0, 0, 50, 100],
  "visibleBounds": [0, 0, 50, 100],
  "coordinateUnit": "pt",
  "rotation": 0,
  "zOrder": 12,
  "locked": false,
  "visible": true,
  "fillColor": "Brand Blue",
  "strokeColor": "None",
  "strokeWeight": 0,
  "opacity": 100,
  "appliedObjectStyle": "Text Box",
  "parentOrigin": null,
  "label": {},
  "text": {},
  "image": {},
  "shape": {}
}
```

### How to implement item classification

Use InDesign constructor names and duck typing rather than relying on one fragile enum.

Recommended mapping:

- Text frames: object has `contents`, `parentStory`, or appears in `page.textFrames`.
- Image/graphic frames: object has `graphics.length > 0`, `images.length > 0`, or is a rectangle with placed graphic.
- Shapes: rectangles, ovals, polygons, graphic lines.
- Groups: object has `allPageItems` or group-specific collection.

### Text info fields

For text frames, collect:

- `excerpt` if `includeTextExcerpt` is true, capped to about 500 characters.
- `storyId`
- first paragraph style
- first character style
- font family/style when available
- point size
- leading
- tracking
- justification
- overset boolean

If mixed formatting prevents a single value, return first value and optionally `mixed: true`.

### Image info fields

For image/graphic frames, collect:

- `hasPlacedGraphic`
- `linkName`
- `linkPath`
- `linkStatus`
- fitting mode if available
- effective PPI if available

Ensure link paths are returned for inspection only; do not use them as write destinations.

### Shape info fields

For shapes, collect:

- `shapeType`: rectangle, oval, polygon, line, unknown
- corner radius if available
- path points when practical and not huge

For path points, cap result size and include `truncated: true` if too many points.

## `inspect_styles`

Return paragraph, character, object, table, and cell styles where available.

For paragraph and character styles include:

- name
- id
- based-on relationship
- font family/style
- point size
- leading
- tracking
- fill/stroke color when applicable
- alignment
- indents and spacing
- style group path if available

For object styles include:

- name
- id
- based-on relationship
- fill/stroke settings
- text-frame options if available
- effects if practical

Implementation notes:

- Skip default style internals if the API throws.
- Preserve style names exactly for later use by `apply_styles`.
- Return group hierarchy as strings; full nested objects can be added later.

## `inspect_swatches`

Return:

- name
- id
- type
- color model
- color space
- raw color values
- tint if available
- approximate usage count if practical

Usage count can be expensive. For MVP, return `usageCount: null` and `usageCountAvailable: false`.

Do not let usage count block core inspection.

## `inspect_layers`

Return:

- name
- id
- visible
- locked
- printable
- layer color if available
- item count

Layer item count can be computed with `layer.pageItems.length` if available or by scanning page items.

## `inspect_parent_pages`

Return:

- parent/master name
- id
- pages that apply it
- parent page items summary
- margins/guides if available

Terminology may vary across InDesign versions (`masterSpreads` vs parent pages). Implement with the current UXP API but expose the tool name as `inspect_parent_pages`.

## `export_page_preview`

### Inputs

- `pageIndex`
- `format`: `png` or `jpg`
- `resolution`
- `includeBleed`
- `outputName`
- `transparentBackground` optional
- `overwrite` default `false`

### Behavior

1. Validate active document is the working copy.
2. Validate `pageIndex` exists.
3. Sanitize `outputName` to a basename; reject path separators.
4. Normalize `outputName`: append `.<format>` when missing and reject mismatched extensions.
5. Build output path under `workspaceRoot/previews`.
6. Reject overwrite unless `overwrite: true`.
7. Configure InDesign export preferences for page range, format, resolution, bleed, and transparency if available.
8. Export to the preview path.
9. Read image dimensions/mime type with `imageInfo.js`.
10. Record preview metadata in `manifest.previews[]`.
11. Return preview record and, by default, an MCP image response item unless `returnImage: false`.

Preview record:

```json
{
  "previewId": "preview_20260619T120000Z_page_0",
  "path": "/workspace/previews/speaker_post.png",
  "filePath": "/workspace/previews/speaker_post.png",
  "format": "png",
  "mimeType": "image/png",
  "widthPx": 1080,
  "heightPx": 1080,
  "sizeBytes": 12345,
  "pageIndex": 0,
  "pageId": 42,
  "spreadIndex": null,
  "derivativeId": null,
  "createdAt": "2026-06-19T12:00:00.000Z"
}
```

## `export_spread_preview`

Same as `export_page_preview`, but accepts `spreadIndex` and exports the spread range if supported. If UXP export APIs do not directly support spread range, implement by setting page range to the spread's pages and recording the behavior clearly.

## `return_preview_as_image`

### Inputs

- `previewId` or `path`

### Behavior

1. If `previewId`, load preview record from manifest.
2. If `path`, validate it is under `workspaceRoot/previews`.
3. Read the file from disk in Node.
4. Return preview metadata by default. Attach an MCP image only when `returnImage: true`, with optional legacy base64 only when explicitly requested:

```json
{
  "previewId": "preview_...",
  "path": "/workspace/previews/speaker_post.png",
  "filePath": "/workspace/previews/speaker_post.png",
  "format": "png",
  "mimeType": "image/png",
  "widthPx": 1080,
  "heightPx": 1080,
  "sizeBytes": 12345
}
```

## Tests for this feature

- `inspect_document_bundle` returns pages, spreads, layers, swatches, styles, links, fonts, and document preferences on a fixture document.
- `inspect_page_items_v2` returns bounds, type, layer, object style, text details, image details, shape details.
- Hidden items are excluded by default and included when requested.
- Parent items are excluded by default and included when requested.
- Preview exports only to `workspaceRoot/previews`.
- Preview export rejects path separators and `../` in `outputName`.
- Preview export appends the requested extension when `outputName` is missing one and rejects mismatched extensions.
- Preview export refuses overwrite unless requested.
- `return_preview_as_image` rejects paths outside previews and returns an MCP image only when `returnImage: true`.
- `manifest.previews[]` is the canonical preview registry for lookup.

## Acceptance criteria

- The external agent can inspect the design system without arbitrary code.
- Page items include enough geometry/style/type data to recreate design motifs.
- A vision model can receive actual preview image bytes for base and derivative pages.
- Preview metadata is tracked in manifest.
