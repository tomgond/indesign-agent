# InDesign MCP Server Test Suite

This directory contains intent-focused regression and integration tests for the MCP server. The suite is useful coverage, but it is not a blanket proof that every listed tool is validated in every runtime.

Canonical live status lives in [docs/live-mcp-validation.md](../docs/live-mcp-validation.md).

## Quick Start

```bash
# Run the grouped local suites
node tests/index.js

# Run only the required suites
node tests/index.js --required

# Focused local regression pass for the recent live MCP fixes
node tests/test-mcp-live-regressions.js

# Remote live regression pass
MCP_URL=http://host:3333/mcp \
MCP_EXPORT_DIR=/writable/remote/export/root \
node tests/test-mcp-live-regressions.js
```

## Suite Layout

- `test-uxp-handlers.js`: quick bridge and handler sanity checks.
- `test-all-handlers.js`: broad local integration sweep across handler categories.
- `test-pageitem-group.js`: page item and group workflows.
- `test-advanced-features.js`: layers, spreads, export/package flows, and utility behavior.
- `test-mcp-live-regressions.js`: focused regression checks for the live MCP issues fixed in this branch.

## Coverage Intent

- Local tests aim to catch handler regressions, transport issues, and common end-to-end flows.
- Remote live validation is a separate concern because it depends on the deployed MCP endpoint, bridge state, InDesign host behavior, and writable remote export paths.
- Some checks are intentionally reported as `unverified` when the runtime disables dangerous tools such as `execute_indesign_code`, or when remote export paths are not provided.

## Notes

- `MCP_URL` must be a full Streamable HTTP endpoint ending in `/mcp`.
- `MCP_EXPORT_DIR` should point to a writable directory on the remote host when validating `export_pdf`, `export_images`, or `package_document`.
- `test-data.csv` is the shared fixture for data-merge-related tests.
