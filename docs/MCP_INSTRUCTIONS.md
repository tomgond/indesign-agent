# InDesign UXP MCP Server - LLM Instructions

## Overview

This repository provides a Model Context Protocol (MCP) server for Adobe InDesign using a UXP plugin bridge.

Current architecture:

- MCP client -> Node MCP server
- Node MCP server -> bridge HTTP server
- bridge HTTP server -> UXP plugin over WebSocket
- UXP plugin -> InDesign DOM

This is not the old AppleScript server. Do not assume temp JSX files, AppleScript automation, or macOS-only behavior.

## Read First

- `../README.md`
- `../AGENTS.md`
- `../.codex/skills/indesign-mcp-repo/SKILL.md`
- `../.codex/skills/indesign-template-agent/SKILL.md`
- `../.codex/skills/indesign-template-orchestrator/SKILL.md`
- `../.opencode/skills/indesign-mcp-repo/SKILL.md`
- `../.opencode/skills/indesign-template-agent/SKILL.md`
- `./live-mcp-validation.md`
- `./template-generation/IMPLEMENTATION_STATUS.md`

## Environment Expectations

### Local-only work

You can safely do local code and docs work on Linux or any machine with Node.js.

### Live InDesign work

Real validation of UXP DOM behavior requires:

- Adobe InDesign 2024+
- The UXP plugin in `plugin/`
- The bridge in `bridge/`
- A live InDesign session connected to the bridge

Do not claim live coverage without it.

## Setup Summary

### 1. Install dependencies

```bash
npm install
```

### 2. Start the bridge

```bash
cd bridge && node server.js
```

### 3. Load the UXP plugin in InDesign

Plugin files:

```text
plugin/
├── index.js
└── manifest.json
```

### 4. Start the MCP server

```bash
npm start
```

Or explicitly:

```bash
MCP_TRANSPORT=http MCP_HOST=0.0.0.0 MCP_PORT=3333 BRIDGE_URL=http://127.0.0.1:3000 node src/index.js
```

HTTP MCP endpoint: `POST /mcp`

Operational endpoints:

- `GET /health`
- `GET /bridge-status`

## Repo Structure

- `src/core/`: MCP server, transport, session management
- `src/handlers/`: tool handlers grouped by feature area
- `src/types/`: MCP tool schemas
- `bridge/`: HTTP/WebSocket bridge
- `plugin/`: UXP plugin running inside InDesign
- `tests/`: local and live regression scripts

## Working Rules For Agents

- Prefer the smallest correct change.
- Keep the UXP-first architecture intact.
- Keep docs honest about what is locally tested versus live-validated.
- When changing setup, tool behavior, or validation state, update the matching docs in the same pass.
- Use exported previews for document truth and keep live screen capture for viewport/focus/UI diagnosis.
- Default derivative preview checkpoints to `previewQuality: "checkpoint"` and only raise quality for review/final proof.
- Treat `return_preview_as_image` as metadata-first. Request inline image payloads only when you actually need them.
- Do not treat object existence as visual success; after visible mutation batches, pair cheap preview evidence with structured inspection.
- Run `diagnose_visual_mismatch` only when preview evidence and structured inspection disagree materially.
- Use `set_item_layer` or explicit front/back ordering for layer repairs instead of ad hoc repeated screenshot loops.
- Use `update_text_slot` only for real text-content changes. Never call `update_text_slot` with `fit:true`; fit separately with `fit_text_to_frame` after inspection.
- If `fit_text_to_frame` throws a runtime/syntax failure in a live session, avoid `autoFit` and fit-repair loops for the rest of that session and repair via frame geometry instead.

## Verification

Run the smallest relevant check:

```bash
node tests/test-uxp-handlers.js
node tests/test-all-handlers.js
node tests/test-mcp-live-regressions.js
```

`test-mcp-live-regressions.js` is for a live environment. If the bridge/plugin/InDesign session is missing, say that clearly.

## Tooling Notes

- InDesign collections usually require `.item(n)` access.
- UXP code can use `async/await`.
- Tool handlers should return structured JSON, not stringly output.
- `doc.filePath` and some filesystem interactions can differ between local assumptions and real UXP runtime behavior; verify live before tightening claims.

## Template Generation Status

Template-generation support exists, but some pieces are only locally implemented or docs-verified.

Before changing or relying on those tools, check:

- `./template-generation/IMPLEMENTATION_STATUS.md`
- `./template-generation/complete/README.md`

## When Writing Or Updating Docs

Keep these aligned:

- `README.md` for human setup and architecture overview
- `AGENTS.md` for repo working rules
- `.codex/skills/indesign-mcp-repo/SKILL.md` for repo-local Codex guidance
- `.codex/skills/indesign-template-agent/SKILL.md` for derivative/template operator guidance
- `.codex/skills/indesign-template-orchestrator/SKILL.md` for end-to-end template workflow orchestration
- `.opencode/skills/indesign-mcp-repo/SKILL.md` for repo-local opencode guidance
- `.opencode/skills/indesign-template-agent/SKILL.md` for derivative/template workspace guidance
- `docs/live-mcp-validation.md` for live coverage status
