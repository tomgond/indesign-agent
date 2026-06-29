# InDesign UXP MCP Server - LLM Instructions

## Overview

This repository provides a Model Context Protocol (MCP) server for Adobe InDesign using a UXP plugin bridge.

Current architecture:

- MCP client -> Node MCP server
- Node MCP server -> bridge HTTP server
- bridge HTTP server -> UXP plugin over WebSocket
- UXP plugin -> InDesign DOM

This is not the old AppleScript server. Do not assume temp JSX files, AppleScript automation, or macOS-only behavior.

For design assets, keep provider calls and heavy vectorization on Linux. The Mac-side MCP should only materialize already-sanitized inline SVG/base64 into `workspace/assets/imports/` and pass the resulting local file path to existing placement tools. In template mode, use `create_image_slot` or `replace_image_in_frame` for placement; `place_file_on_page` is only in the generic/all profiles. The materializer is covered by local unit tests in this repo, but this change does not claim live Mac/InDesign validation.

The Linux `design-assets-mcp` package should be treated as the source of truth for remote provider access and asset provenance. Tabler works locally out of the box; extra Iconify collections require explicit packages, and remote Iconify search is discovery-only unless the resolved icon is already available locally. Recraft stays gated by token, `force`, and `maxCostUsd`, and the vector adapter only accepts sanitized SVG/vector payloads before any Mac-side materialization. VTracer stays Linux-only and returns `VTRACER_UNAVAILABLE` when the binary is missing.

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
- Treat `derivativeId` as the durable derivative target. Do not carry raw `pageIndex` from one mutation to the next when `derivativeId` exists; resolve the page again before mutating if identity may have drifted.
- Use `update_text_slot` only for real text-content changes. Never call `update_text_slot` with `fit:true`; fit separately with `fit_text_to_frame` after inspection.
- Do not edit raw duplicated text frames as normal editable text. Use `create_text_slot` for fresh isolated derivative text, and expect `update_text_slot` to refuse threaded/shared story frames by default.
- `fit_text_to_frame` is a heuristic only. Check `resolved` and `stillOverset`; it does not repair story/thread corruption.
- Decorative bleed is explicit. Keep normal content slots strict unless a call sets `allowBleed` or `decorative`.

## CSV/Table Template Fill Flow

For a finished source page that needs many text-only copies, use `duplicate_template_page`, not `create_derivative_page`. The former duplicates the complete page through InDesign and patches labeled slots with the new `derivativeId`; the latter creates a new page and optionally copies only labeled editable motifs for creative layout generation.

Source text frames should have labels such as `{ "slot": "name", "role": "title", "editable": true }`. After duplication, update through `labelQuery: { "derivativeId": "invite_001", "slot": "name" }`. Do not target the selected frame, current page, or a cached page index.

Use `scripts/fill_template_from_csv.py` for deterministic table transfer. Python reads the CSV on Linux, preserves exact cell values, initializes and reuses one Streamable HTTP MCP session, duplicates per row, and calls `update_text_slot` with `textReplacePolicy: "isolatedOnly"`. The model supplies the config/mapping once and does not manually copy row values. Duplicate slots and unsafe threaded/shared stories are errors; fitting is a separate explicit operation and `update_text_slot({ fit: true })` remains forbidden. The runner now refuses to save partial failures by default and only saves on error when `--save-on-error` is set explicitly.

See `./template-generation/csv-template-fill.md` for configuration, command, failure reporting, and the live-validation checklist. Completion requires no runner row/slot errors; final visual success still requires preview plus structured inspection evidence.

Live validation on 2026-06-29 exercised the real Mac/InDesign/UXP session for `duplicate_template_page`, exact-value CSV fill, isolated text replacement, separate fit repair, preview checkpoints, layer repair, asset placement, and derivative identity/page-index drift. The detailed evidence table lives in `docs/live-mcp-validation.md`.

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
