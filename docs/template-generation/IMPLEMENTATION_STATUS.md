# Template Generation Implementation Status

This started as the honest status after the local Linux-only implementation pass.

A focused live Mac/InDesign/UXP validation pass ran on 2026-06-29 against the workspace working copy. The table below records what was actually exercised live, what passed, and what remains untested or local-only.

Anything that depends on the InDesign DOM outside the table below is still best-effort or explicitly blocked until a live pass proves the exact API behavior.

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
- `return_preview_as_image` for an existing workspace PNG/JPG file, returning metadata by default and MCP image output only when explicitly requested.
- `capture_screen_preview`, `capture_indesign_screen_preview`, `export_page_preview`, `export_spread_preview`, and `export_derivative_preview` now return MCP images by default when the caller does not opt out.
- Preview export quality presets with cheap `checkpoint` defaults, metadata (`previewQuality`, `resolution`, pixel size, bytes), and lower-cost internal preview calls in roundtrip/finalization flows.
- `diagnose_visual_mismatch` for targeted read-only preview-vs-structure diagnosis on one page.
- `set_item_layer` for explicit layer moves plus optional front/back repair.
- `update_text_slot` now rejects `fit:true` before mutation and returns short before/after text evidence.
- `fit_text_to_frame` nullish/boolean precedence fix plus local regression coverage.
- `duplicate_template_page` schema/handler with direct full-page duplication, copied-slot relabeling, duplicate-slot rollback, in-script derivative marker creation, manifest metadata persistence, and default rejection of duplicate `derivativeId` values.
- Dependency-free `scripts/fill_template_from_csv.py` with exact UTF-8/BOM CSV parsing, pre-mutation validation, explicit active-document `ok:true` checking, Streamable HTTP session reuse, durable slot targeting, hashes/result reporting, dry-run, and fake-client tests.
- Visual-review JSONL append/list, tolerant structured design-quality rubric normalization with complete/partial metadata, and blocker-aware derivative review summaries in the manifest.
- Fast Node tests for HTTP transport, workspace safety, bridge timeout dirty-state, UXP busy-gate, and inspection bounds.
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
- `duplicate_template_page` (handler and schema are locally tested; complete source-page fidelity was live-validated on 2026-06-29 for the required fixture shape, but the item-by-item fallback path is still pending)
- `duplicate_items_to_page`
- `create_text_slot`
- `create_image_slot`
- `fit_text_to_frame`
- `export_derivative_preview`
- `diagnose_visual_mismatch`
- `set_item_layer`
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
- Preview-quality presets and metadata are locally covered, but exact rendered fidelity still needs live InDesign validation.
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

## June 27 reliability pass

- Added targeted visual mismatch diagnosis instead of broad layer-debug loops.
- Added explicit layer reassignment for derivative repair work.
- Made preview exports default to low-cost `checkpoint` quality unless callers opt into `review`, `final`, or an explicit resolution.
- Stopped `verify_template_roundtrip`, `finalize_derivative`, and `build_derivative_from_recipe` from inlining preview images by default.
- Separated text mutation from fitting by rejecting `update_text_slot({ fit: true })`.
- Added focused local regressions in `tests/test-template-reliability.js` plus an optional live reliability script: `tests/test-template-reliability-live.js`.

## June 28 derivative reliability pass

- Centralized existing-frame text replacement into a shared safe helper that refuses threaded/shared story frames by default.
- Added derivative-page resolution helpers so mutating tools prefer durable `derivativeId` resolution over cached `pageIndex`.
- Made duplicate-base-motif text handling explicit with skip/fresh/raw modes and defaulted derivative base duplication away from raw text reuse.
- Added decorative bleed opt-in for bounds validation instead of loosening content-slot checks globally.

## June 29 CSV template-fill pass

- Added the separate `duplicate_template_page` path for finished full-page templates without changing creative `create_derivative_page` behavior.
- Added duplicate `derivativeId` rejection, in-script marker creation, and all-slot uniqueness checks to `duplicate_template_page`.
- Added a Linux-side CSV runner and examples. Python, not the model, transfers exact row values to `update_text_slot` by `{ derivativeId, slot }`, and it now refuses to save partial failures by default.
- Added local static/unit coverage for schema registration, marker/manifest/label paths, fit separation, UTF-8 BOM/Hebrew/quoted commas/empty cells, config validation, active-document validation, save-skipping, and fake MCP call sequencing.
- Live InDesign duplication is now validated for the required fixture shape. The remaining caveats are documented in the live-validation table below.

## Live validation status, 2026-06-29

| Area                                   | Status   | Evidence | Notes / remaining risk |
| -------------------------------------- | -------- | -------- | ---------------------- |
| duplicate_template_page full-page copy | passed   | `live_dup_001`; source page `16`; pageId `7833`; pageIndex `17`; previews `preview_live_dup_001_001`, `preview_live_dup_001_003` | Preserved linked SVG, background shape, decorative oval, two labeled text frames, and marker; live visual sanity checked with checkpoint/review previews. |
| duplicate derivativeId rejection       | passed   | `derivativeId already exists in workspace manifest: live_dup_001 ...` | No second derivative page was created; `resolve_derivative_page` still returned the original page. |
| all-slot uniqueness                    | passed   | `Duplicate slot labels on copied page: ...` for `live_dup_duplicate_slot` | Cleanup removed the failed derivative record; no orphan manifest entry remained. |
| CSV exact-value fill                   | passed   | `fill_result.json`; processed `2`; failed `0`; derivativesCreated `2`; previews `preview_live_csv_001_001`, `preview_live_csv_002_001` | Hebrew, quoted comma, leading/trailing spaces, and empty cell behavior all transferred exactly. |
| save skip on failure                   | passed   | `fail_result.json`; `saveSkipped: true`; `saveSkippedReason: "errors_present"` | Explicit `--save-on-error` was not run; intentionally skipped to avoid persisting a failed live document. |
| update_text_slot isolated replacement  | passed   | `Identity Alpha 01` / `Identity Beta 02` before-after evidence on `live_identity_001` and `live_identity_002` | `textReplacePolicy: "isolatedOnly"` held, and `stillOverset: false` after replacement. |
| fit:true rejection                     | passed   | `update_text_slot no longer supports fit=true; call fit_text_to_frame separately after inspecting the updated text.` | Separate `fit_text_to_frame` call succeeded and stayed non-overset. |
| layer inspection/move                  | passed   | `objectId 7835` moved from `Layer 1` to `AGENT_WORK`; checkpoint preview `preview_live_dup_001_002` | No unrelated objects were moved; layer visibility stayed sane. |
| preview quality defaults               | passed   | checkpoint preview resolution `48`; review preview resolution `96` for `live_dup_001` | Confirms cheap checkpoint defaults and opt-in higher quality. |
| asset SVG materialization/placement    | passed   | `tabler:brand-google-home`; Mac path `/Users/morbendror/InDesignMCPWorkSpace3/assets/imports/tabler:brand-google-home/asset.svg`; placed objectId `8067`; preview `preview_live_asset_001_001` | Linux asset MCP stayed provider-side; Mac materializer consumed only sanitized SVG/base64. |
| derivative identity / page-index drift  | passed   | `live_identity_001 -> pageId 8338 / pageIndex 23`, `live_identity_002 -> pageId 8410 / pageIndex 24`; previews `preview_live_identity_001_001`, `preview_live_identity_002_001` | Updates were targeted by `derivativeId`; no stale page index was reused for mutation. |

Remaining untested live items:

- Explicit `--save-on-error` override for the CSV runner.
- Roundtrip/finalization flows on the newly created live derivatives.
- Any source-page variants that do not include the live fixture's placed image, background shape, styled text, and decorative object mix.

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
