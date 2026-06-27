# AGENTS.md

## What This Repo Is

This repo is an InDesign UXP MCP server:

- `src/` is the Node MCP server and tool handlers.
- `bridge/` is the HTTP/WebSocket bridge between Node and InDesign.
- `plugin/` is the UXP plugin that runs inside Adobe InDesign.
- `tests/` contains local regression checks and some live test entry points.

The current architecture is UXP-first. Do not reintroduce AppleScript or ExtendScript assumptions into docs or handlers unless a change explicitly requires them.

## Read First

- `README.md`
- `docs/MCP_INSTRUCTIONS.md`
- `docs/live-mcp-validation.md`
- `docs/template-generation/IMPLEMENTATION_STATUS.md`

## Working Rules

- Prefer the smallest correct patch.
- Preserve the Node -> bridge -> UXP plugin execution model.
- Treat live InDesign behavior as unverified until it has been exercised against a real bridge/plugin/InDesign session.
- Keep docs aligned with the current server architecture and transport.
- Update docs when changing tool behavior, setup, or validation status.
- For editable derivative work, prefer exported preview checkpoints over live screenshots for document truth.
- Use low-cost preview checkpoints by default: `previewQuality: "checkpoint"` unless review/final proof needs more detail.
- Run `diagnose_visual_mismatch` only when preview evidence and structured inspection materially disagree.
- Use `set_item_layer` or explicit z-order tools for layer repairs; do not make layer debugging a default loop.
- Do not call `update_text_slot` with `fit:true`; change text first, inspect/export, then call `fit_text_to_frame` separately if needed.
- If `fit_text_to_frame` fails with a runtime or syntax error in a live session, stop using fit/autoFit paths in that session and repair via frame geometry instead.

## Verification

Run the smallest relevant check for the files you changed:

- `node tests/test-uxp-handlers.js`
- `node tests/test-all-handlers.js`
- `node tests/test-mcp-live-regressions.js`

Some flows require a live Mac/InDesign/UXP environment. If that environment is unavailable, say so plainly rather than implying live coverage.

## Repo-Local Skill

Repo-specific opencode guidance lives here:

- `.codex/skills/indesign-mcp-repo/SKILL.md`
- `.codex/skills/indesign-template-agent/SKILL.md`
- `.codex/skills/indesign-template-orchestrator/SKILL.md`
- `.opencode/skills/indesign-mcp-repo/SKILL.md`
- `.opencode/skills/indesign-template-agent/SKILL.md`
