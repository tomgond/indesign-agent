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
- `duplicate_template_page` and the Linux CSV runner have local static/unit coverage only. Full-page duplication has not been validated against live InDesign.

## Pending CSV Template Duplication Scenario

Create a source page containing one placed image frame, one background shape, two labeled/styled text slots, and one unlabeled decorative item. Through the template workspace working copy:

1. Run `duplicate_template_page` with a new `derivativeId`.
2. Confirm all visible objects, links, layers, styles, swatches, and geometry survive the duplicate.
3. Confirm copied slot labels contain the new `derivativeId` and unique original slot names.
4. Run the CSV runner so Python updates both slots by `{ derivativeId, slot }`.
5. Export a checkpoint preview and inspect copied slots, text diagnostics, and links.

Do not mark this tool live-validated until that scenario passes through the real bridge, UXP plugin, and InDesign session.

## Refresh Procedure

1. Run:
   `MCP_URL=<full /mcp URL> MCP_EXPORT_DIR=<writable remote dir> node tests/test-mcp-live-regressions.js`
2. Copy the `LIVE_MCP_SUMMARY` JSON into this note.
3. Update the "Last Known Live Baseline" section with the new pass/fail/unverified sets and any exact runtime error strings returned by the endpoint.
