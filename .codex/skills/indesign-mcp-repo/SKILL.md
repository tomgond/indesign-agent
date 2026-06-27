---
name: indesign-mcp-repo
description: Use when editing code or docs in this InDesign UXP MCP server repo and you need the current architecture rules, verification boundaries, and doc-alignment expectations.
---

# InDesign MCP Repo

Use this skill for normal repository maintenance in this workspace.

## Scope

- `src/`: MCP server, tool schemas, transport, handlers.
- `bridge/`: HTTP and WebSocket bridge between Node and the plugin.
- `plugin/`: UXP plugin code running inside Adobe InDesign.
- `docs/`: setup, validation, and template-generation status.
- `tests/`: local regressions and live validation entry points.

## Required Architecture Assumptions

- Keep the current execution path intact: Node MCP server -> bridge HTTP server -> UXP plugin -> InDesign DOM.
- Do not reintroduce AppleScript, ExtendScript temp-file flows, or macOS-only assumptions unless the change explicitly requires historical comparison.
- Treat live InDesign behavior as unverified until it has been exercised against a real bridge, plugin, and InDesign session.

## Working Rules

- Prefer the smallest correct patch.
- Keep docs honest about what is locally tested versus live-validated.
- When touching setup, tool behavior, or validation status, update the matching docs in the same pass.
- For template-generation work, check `docs/template-generation/IMPLEMENTATION_STATUS.md` before claiming completeness.
- For editable derivative work, prefer exported preview checkpoints over repeated live screenshots, default preview quality to `checkpoint`, and keep text mutation separate from fitting.

## Verification

Run the smallest relevant command for the files you changed:

- `node tests/test-uxp-handlers.js`
- `node tests/test-all-handlers.js`
- `node tests/test-mcp-live-regressions.js`

If a change depends on real InDesign behavior, say clearly when only local verification was possible.

## Key References

- `README.md`
- `AGENTS.md`
- `docs/MCP_INSTRUCTIONS.md`
- `docs/live-mcp-validation.md`
- `docs/template-generation/IMPLEMENTATION_STATUS.md`
