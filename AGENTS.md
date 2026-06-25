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

## Verification

Run the smallest relevant check for the files you changed:

- `node tests/test-uxp-handlers.js`
- `node tests/test-all-handlers.js`
- `node tests/test-mcp-live-regressions.js`

Some flows require a live Mac/InDesign/UXP environment. If that environment is unavailable, say so plainly rather than implying live coverage.

## Repo-Local Skill

Repo-specific opencode guidance lives here:

- `.opencode/skills/indesign-mcp-repo/SKILL.md`
- `.opencode/skills/indesign-template-agent/SKILL.md`
