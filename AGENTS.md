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
- For editable derivative work, treat exported previews as document/export/layout truth, structured inspection as object/layer/text/geometry truth, and live screenshots as viewport/focus/UI diagnosis only.
- Before planning a derivative from an existing page, validate the working copy, inspect source/base-page geometry and key objects, then export a low-cost checkpoint preview and use that preview as the visual anchor.
- Use low-cost preview checkpoints by default: `previewQuality: "checkpoint"` unless review/final proof needs more detail.
- Pick one explicit layer strategy before building. Do not place full-page backgrounds above source text, source motifs, or duplicated content.
- If an exported preview is blank, solid-color, or missing expected content, stop content mutation and inspect layer/visibility/occlusion first.
- Run `diagnose_visual_mismatch` only when preview evidence and structured inspection materially disagree.
- Use `set_item_layer` or explicit z-order tools for layer repairs; do not make layer debugging a default loop.
- Object creation success is not visibility success. Re-check with preview plus structured inspection after visible mutation batches.
- Do not call `update_text_slot` with `fit:true`; change text first, inspect/export, then call `fit_text_to_frame` separately if needed.
- Do not use `update_text_slot` for geometry or fitting repair. Preserve known-good text before risky edits and do not mutate text that is already correct and visible.
- If `fit_text_to_frame` fails with a runtime or syntax error in a live session, stop using fit/autoFit paths in that session and repair via frame geometry instead.
- If one or two targeted repairs do not improve a preview/inspection mismatch, or known-good text becomes uncertain, rollback/replan instead of compounding salvage edits.

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
