# Inspector

Use this reference for the read-only inspection phase.

## Mission

Inspect the current workspace working copy and determine:

- document structure
- page and spread geometry
- reusable visual motifs
- available styles and swatches
- layers and parent pages
- semantic labels
- likely text, image, and vector roles
- risks that could break derivative generation

## Read-Only Rule

Do not call mutating tools.

Allowed tools:

- `get_workspace_status`
- `validate_active_document_is_working_copy`
- `inspect_document_bundle`
- `inspect_page_items_v2`
- `inspect_page_geometry`
- `inspect_styles`
- `inspect_swatches`
- `inspect_layers`
- `inspect_parent_pages`
- `inspect_layout_grid`
- `analyze_design_system`
- `inspect_derivative`
- `diagnose_visual_mismatch`
- `compare_derivative_state`
- `list_named_objects`
- `find_objects_by_label`
- `get_object_label`
- `list_versions`
- `list_visual_reviews`
- `return_preview_as_image`

When using `return_preview_as_image`, request inline image payloads only when needed for human review. Metadata-only preview evidence is the default.

## Protocol

1. Validate workspace state with `get_workspace_status` and `validate_active_document_is_working_copy`.
2. Inspect the document bundle with `includeHidden: false` and `includeTextExcerpt: true`.
3. Inspect styles, swatches, layers, and parent pages to identify reusable design-system resources.
4. For likely base pages, inspect geometry, page items, layout grid, and design-system hints.
5. Discover semantic objects through names and labels when useful.
6. When a preview is blank, solid, or missing expected objects while inspection still shows structure, run `diagnose_visual_mismatch` once and report the likely causes.
7. Flag blockers aggressively: active-document mismatch, missing workspace, missing links or fonts, overset text, locked layers, raster-only base design, or zero-item derivative pages.

## Output Requirements

Return structured evidence covering:

- summary status: `ok`, `blocked`, or `partial`
- recommended base pages
- document counts and likely base pages
- styles, swatches, layers, and parent pages worth reusing
- reusable motifs with selectors and risk
- semantic targets
- page geometry and grid warnings
- blockers and warnings
- recommended next step
- tool-call evidence summaries
