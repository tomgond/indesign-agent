# Live MCP Validation

This is the canonical status note for live MCP validation. It separates actual handler regressions from deployment/runtime caveats.

## Scope

- Local focused runner: `node tests/test-mcp-live-regressions.js`
- Remote focused runner: `MCP_URL=<full /mcp URL> MCP_EXPORT_DIR=<writable remote dir> node tests/test-mcp-live-regressions.js`
- Current runner output includes a machine-readable `LIVE_MCP_SUMMARY ...` line with `passed`, `failed`, and `unverified` checks.

## Endpoint

- Remote validation is intentionally operator-supplied through `MCP_URL`.
- The June 21, 2026 baseline failures came from a private online Streamable HTTP endpoint ending in `/mcp`; that exact URL is not stored in this repo.
- A post-fix remote rerun was not possible from this workspace because no `MCP_URL` was configured here.

## Handler Bugs Fixed In Code

- `list_groups` now filters for real groups instead of treating any item with a `pageItems`-like shape as a group.
- `add_item_to_group` no longer relies on `group.add(item)` and now rebuilds the group through ungroup/regroup.
- `remove_item_from_group` no longer relies on `group.remove(item)` and now ungroups, removes the selected child, and regroups only when needed.
- `export_pdf` now prepares parent directories and exports to a `File`.
- `export_images` now normalizes formats to `jpg` / `png` / `tif`, prepares the output directory, and exports each page to a `File`.
- `package_document` now prepares the output directory and passes the full `packageForPrint()` argument list expected by the current UXP API.

## Last Known Live Baseline

Date: June 21, 2026

Passed live before these fixes:
- `create_document`
- `create_layer`
- `set_active_layer`
- `close_document`
- `get_session_info` session-clear check

Failed live before these fixes:
- `add_item_to_group`
  - Failure class: real handler bug
  - Cause: relied on `group.add(item)`, which is not available in the live UXP environment
- `remove_item_from_group`
  - Failure class: real handler bug
  - Cause: relied on `group.remove(item)`, which is not reliable in the live UXP environment
- `list_groups`
  - Failure class: real handler bug
  - Cause: plain page items could be misreported as groups
- `export_pdf`
  - Failure class: real handler bug plus writable-path dependency
  - Cause: exported to a raw string path and did not ensure parent directory creation
- `export_images`
  - Failure class: real handler bug plus writable-path dependency
  - Cause: the live endpoint did not accept the previous PNG export format resolution; PNG needed extension-based export values instead
- `package_document`
  - Failure class: real handler bug plus writable-path dependency
  - Cause: `packageForPrint()` was called without the full current required argument list, including `creatingReport`

## Environment-Specific Caveats

- `execute_indesign_code`
  - When the deployed server keeps `ALLOW_EXECUTE_INDESIGN_CODE` disabled, the runner now marks execute-based checks as `unverified` instead of treating them as regressions.
- Export and package validation
  - Remote validation needs `MCP_EXPORT_DIR` to point at a writable directory on the remote host.
  - If `MCP_EXPORT_DIR` is unset, the focused runner marks `export_pdf`, `export_images`, and `package_document` as `unverified`.

## Current Status From This Workspace

- Code changes for the known group/export/package regressions are implemented in `src/handlers/groupHandlers.js` and `src/handlers/exportHandlers.js`.
- The focused runner has been updated for both local spawned-server mode and remote `MCP_URL` mode.
- A local rerun on June 21, 2026 reached the server and bridge, but could not validate handlers because the bridge reported: `Error: Plugin not connected. Open InDesign, then load the Bridge Panel via UXP Developer Tool.`
- A fresh post-fix remote validation result is still pending because this workspace does not have the private remote `MCP_URL` and writable `MCP_EXPORT_DIR` required to execute the live rerun.
- `duplicate_template_page` and the Linux CSV runner now have live workspace validation recorded below; the earlier remote-baseline note remains pending because the private remote `MCP_URL` and writable `MCP_EXPORT_DIR` are still unavailable here.

## June 29, 2026 Workspace Validation

This workspace ran a focused live Mac/InDesign/UXP pass against the working copy on 2026-06-29. The tested flows passed as follows:

| Area                                   | Status   | Evidence | Notes / remaining risk |
| -------------------------------------- | -------- | -------- | ---------------------- |
| duplicate_template_page full-page copy | passed   | `live_dup_001`; pageId `7833`; pageIndex `17`; previews `preview_live_dup_001_001`, `preview_live_dup_001_003` | Preserved linked SVG, background, decorative oval, two labeled text frames, and marker; live visual sanity checked with checkpoint/review previews. |
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

Untested live:

- Explicit `--save-on-error` override for the CSV runner.
- Roundtrip/finalization flows on the newly created live derivatives.
- Any source-page variants that do not include the live fixture's placed image, background shape, styled text, and decorative object mix.

## CSV Template Duplication Scenario

The scenario below was completed in the 2026-06-29 workspace validation pass.

Create a source page containing one placed image frame, one background shape, two labeled/styled text slots, and one unlabeled decorative item. Through the template workspace working copy:

1. Run `duplicate_template_page` with a new `derivativeId`.
2. Confirm all visible objects, links, layers, styles, swatches, and geometry survive the duplicate.
3. Confirm copied slot labels contain the new `derivativeId` and unique original slot names.
4. Run the CSV runner so Python updates both slots by `{ derivativeId, slot }`.
5. Export a checkpoint preview and inspect copied slots, text diagnostics, and links.

The scenario has now passed through the real bridge, UXP plugin, and InDesign session for the live fixture used in this workspace.

## Refresh Procedure

1. Run:
   `MCP_URL=<full /mcp URL> MCP_EXPORT_DIR=<writable remote dir> node tests/test-mcp-live-regressions.js`
2. Copy the `LIVE_MCP_SUMMARY` JSON into this note.
3. Update the "Last Known Live Baseline" section with the new pass/fail/unverified sets and any exact runtime error strings returned by the endpoint.
