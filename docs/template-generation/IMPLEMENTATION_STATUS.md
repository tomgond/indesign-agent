# Template Generation Implementation Status

This is the honest status after the local Linux-only implementation pass.

No live Mac/InDesign/UXP plugin validation has been run. Anything that depends on the InDesign DOM is either best-effort or explicitly blocked until a live pass proves the exact API behavior.

## Complete locally

These pieces are complete enough for Node-side use and have local checks:

- Durable active-workspace pointer at `~/.indesign-agent/active-workspace.json` plus `attach_template_workspace` reattach flow.
- Default `INDESIGN_TOOL_PROFILE=template`, so template mode no longer lists conflicting generic open/save/create/export tools.
- Template page-local coordinate conversion and bounds validation wiring for core creation/bounds tools.
- Derivative identity persistence with `pageId`/`pageBounds` plus nonprinting page marker fallback.
- Roundtrip/finalization tools: `resolve_derivative_page`, `inspect_page_geometry`, `verify_template_roundtrip`, `finalize_derivative`, `build_derivative_from_recipe`.
- Streamable HTTP MCP transport at `/mcp`.
- `GET /health`.
- `GET /bridge-status` using the configured bridge `/status` endpoint only.
- Configurable `BRIDGE_URL` with default `http://127.0.0.1:3000`.
- Workspace folder/manifest creation.
- Original INDD copy to `input/base-copy.indd` and `work/current.indd`.
- Path jail helper for workspace buckets.
- Version copy/list/rollback at the filesystem level.
- Default denial of public `execute_indesign_code` unless `ALLOW_EXECUTE_INDESIGN_CODE=true`.
- Workspace-active guard for risky open/save/export/package paths covered in the local pass.
- `return_preview_as_image` for an existing workspace PNG/JPG file.
- Visual-review JSONL append/list and derivative status updates in manifest.
- Fast Node tests for HTTP transport and workspace safety.
- Live MVP test scaffold that fails clearly without Mac/InDesign/bridge/plugin.

See `complete/README.md` for the same complete list in a folder marker.

## Partially implemented, requires live InDesign validation

These tools have best-effort UXP snippets, but they are not complete until tested against real InDesign UXP:

- `open_working_copy`
- `validate_active_document_is_working_copy`
- `save_working_copy`
- `inspect_document_bundle`
- `inspect_page_items_v2`
- `inspect_styles`
- `inspect_swatches`
- `inspect_layers`
- `inspect_parent_pages`
- `export_page_preview`
- `export_spread_preview`
- `create_page`
- `create_derivative_page`
- `duplicate_items_to_page`
- `create_text_slot`
- `create_image_slot`
- `fit_text_to_frame`
- `export_derivative_preview`
- `inspect_derivative`
- `apply_layout_recipe`
- `replace_image_in_frame`
- `update_text_slot`
- `move_resize_items`
- `create_vector_motif`
- `inspect_layout_grid`
- `analyze_design_system`
- `compare_derivative_state`
- `run_derivative_checks`
- `duplicate_page`
- `create_text_frame`
- `create_image_frame` as an empty rectangle placeholder only
- `create_shape`
- `create_line`
- `set_text_content`
- `set_bounds`
- `move_item`
- `resize_item`
- `rotate_item`
- `lock_item`
- `unlock_item`
- `rename_page_item`
- `label_object`
- `get_object_label`
- `find_objects_by_label`
- `list_named_objects`
- `check_overset_text`
- `check_missing_links`
- `check_missing_fonts`
- `check_hidden_or_locked_problem_items`
- `run_preflight`
- `run_template_preflight`
- `bring_to_front`
- `send_to_back`
- `fit_content_to_frame`
- `fit_frame_to_content`
- `apply_styles`
- `apply_swatches`
- `place_image`
- `group_items`
- `ungroup_items`
- `align_items`
- `distribute_items`
- `create_reference_underlay`
- `hide_reference_underlay`
- `remove_reference_underlay`

Known risks in this group:

- `doc.filePath` path shape may differ from the current string comparison.
- Some InDesign collection names/properties may differ by version.
- Export preferences/page range are not fully wired; preview export may export more than the requested page/spread.
- Unit conversion is not implemented; bounds are passed through as-is.
- `create_image_frame` does not place an image.
- Preflight checks are basic DOM scans, not full production certification.
- Z-order and frame fitting methods are docs-verified only; they still need live UXP validation on real page items.
- Style and swatch application methods are docs-verified only; they still need live UXP validation for text-frame style behavior, object styles, and built-in swatch names.
- `place_image` validates paths locally under `assets/` or `input/`, then uses docs-verified `frame.place(path)` and optional fitting; path-string placement still needs live UXP validation.
- Group and ungroup methods are docs-verified only; item-array behavior and common-parent requirements still need live UXP validation.
- Deterministic align/distribute and derivative-layout flows now run through bounds math locally, but still need live UXP validation on real page items, grouped objects, and spread/page bounds.
- Reference underlay layer/image methods are docs-verified only; layer printable/lock behavior and path-string placement still need live UXP validation.

## Not implemented yet

No registered template-generation tools intentionally return not-implemented after the extended-capabilities pass. Most InDesign DOM-dependent tools are still only docs-verified until the live Mac/InDesign pass.

## June 21 fix batch pending deployment

- Export/package handlers no longer use ExtendScript-style `new File` / `new Folder`; Node prepares folders and UXP receives plain Mac path strings, with a UXP storage fallback for packaging.
- The UXP plugin manifest now requests `localFileSystem: fullAccess` for package fallback and file-system entry access.
- Group add/remove now accepts stable `groupId` / `itemId` and avoids flattened `allPageItems` child-index confusion by falling back to the single standalone page item when legacy index calls hit an existing group child.
- Template active-document guard now normalizes UXP file entries through `nativePath` / `fsName`.
- Preview export validates page/spread indexes and sets image export page ranges/resolution where available.
- Template layout tools now do basic positive-bounds validation, `mm` to `pt` conversion, create-time style/swatch basics, optional image placement for `create_image_frame`, semantic name rejection for unsafe characters, and the documented `REFERENCE_UNDERLAY` default layer name.
- Derivative page/slot/recipe/check helpers now persist manifest state, deterministic preview naming, and inspection snapshots locally.

Still pending: live Mac/InDesign retest after deployment and deeper fixture-driven completion of every optional inspection/preflight field.

## What it takes to finish

1. Use Adobe InDesign UXP DOM docs to map each incomplete tool to exact APIs and enum names.
2. Run small live probes through the existing bridge for each API family:
   - active document path and save/open behavior,
   - export image preferences and page/spread range,
   - page item creation and bounds units,
   - image placement and fitting,
   - style/swatch lookup and application,
   - grouping, z-order, align/distribute, fitting,
   - label storage APIs,
   - layer non-printing/locked/visible behavior for reference underlays,
   - link/font/preflight status fields.
3. Replace registered-failing tools with real guarded UXP snippets.
4. Run `tests/test-template-mvp-flow.js` with `RUN_TEMPLATE_LIVE=1` against a real `.indd` fixture and real asset file to prove the end-to-end derivative flow.
5. Run the full three-derivative flow on a real `.indd` fixture and fix DOM/version differences.

## Geometry canary command

Run this only with a real bridge/plugin/InDesign session:

```bash
RUN_TEMPLATE_LIVE=1 TEMPLATE_BASE_INDD="/absolute/path/to/base.indd" TEMPLATE_WORKSPACE_ROOT="/absolute/path/to/workspace" node scripts/template-geometry-canary.mjs
```

## Documentation sources to use next

- Local API research notes: [`UXP_API_REFERENCE_NOTES.md`](./UXP_API_REFERENCE_NOTES.md).
- Adobe InDesign UXP scripting/API reference.
- Adobe InDesign DOM reference for document export, page items, styles, swatches, links, fonts, layers, labels, and preflight.
- The installed MCP SDK docs/source for Streamable HTTP behavior.
- Live runtime probes, because UXP support can differ from older ExtendScript examples.

## Ledger note

No repo ledger file was found during this pass, so no ledger entry was written.
