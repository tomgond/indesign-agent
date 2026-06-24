---
name: indesign-mcp-repo
description: Use when working in this InDesign UXP MCP server repo to keep changes aligned with the Node bridge plus UXP plugin architecture, the documented test commands, and the live-vs-local validation boundary.
---

# InDesign MCP Repo

Use this skill when editing this repository's code or docs.

## What This Repo Owns

- `src/`: MCP server, schemas, handlers, transport wiring.
- `bridge/`: HTTP and WebSocket bridge.
- `plugin/`: UXP plugin code that runs inside InDesign.
- `docs/`: setup, validation, and template-generation status docs.
- `tests/`: local regression checks and some live entry points.

## Repo Rules

- Keep the current UXP architecture intact: Node -> bridge -> UXP plugin -> InDesign DOM.
- Prefer small handler or doc fixes over new abstractions.
- Do not describe tools as live-validated unless the live validation docs or tests actually show that.
- When touching setup or LLM-facing guidance, keep `README.md`, `AGENTS.md`, and `docs/MCP_INSTRUCTIONS.md` consistent.
- For template-generation work, check `docs/template-generation/IMPLEMENTATION_STATUS.md` before claiming completeness.

## Verification

Use the smallest relevant command:

- `node tests/test-uxp-handlers.js`
- `node tests/test-all-handlers.js`
- `node tests/test-mcp-live-regressions.js`

If a change depends on real InDesign behavior, call out when only local verification was possible.

## Key Docs

- `README.md`
- `AGENTS.md`
- `docs/MCP_INSTRUCTIONS.md`
- `docs/live-mcp-validation.md`
- `docs/template-generation/IMPLEMENTATION_STATUS.md`
