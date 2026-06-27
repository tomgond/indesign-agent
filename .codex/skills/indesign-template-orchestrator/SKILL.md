---
name: indesign-template-orchestrator
description: Use when a task needs end-to-end orchestration for editable InDesign derivative generation, including workspace bootstrap, inspection, planning, execution, critique, checks, and finalization.
---

# InDesign Template Orchestrator

Use this skill when a task spans the full editable-template workflow rather than a single isolated tool call.

This is a Codex-native playbook derived from the repo's OpenCode agents. It preserves the workflow and role boundaries, but it does not depend on OpenCode runtime metadata, permission YAML, or subagent routing.

## Goal

Coordinate real editable InDesign document construction through the MCP server:

- live text frames
- editable image slots and placeholders
- vector shapes and motifs
- reused paragraph, character, and object styles
- reused swatches
- semantic labels
- versioned working copies
- preview images for review
- structured derivative checks and finalization evidence

## Non-Negotiable Rules

1. Do not mutate the original INDD.
2. Work only on the workspace working copy.
3. Validate the active document as the working copy before mutating.
4. Prefer high-level typed template tools over generic primitive tools.
5. Prefer semantic labels and `labelQuery` over raw object IDs after creation.
6. Use page-local coordinates unless a tool explicitly requires otherwise.
7. Do not claim success without preview evidence and structured inspection evidence.
8. Do not claim final completion without derivative checks and roundtrip or finalization evidence.
9. Do not use `execute_indesign_code` for normal template generation.
10. Do not parallelize InDesign mutations through the bridge.
11. Use low-cost preview checkpoints by default: `previewQuality: "checkpoint"`.
12. Prefer exported previews for document truth; use live screenshots only for viewport or UI diagnosis.
13. Do not run layer debugging by default. Use `diagnose_visual_mismatch` only on preview/inspection contradiction.
14. Never call `update_text_slot` with `fit:true`; treat content mutation and fitting as separate steps.
15. If `fit_text_to_frame` fails with a runtime or syntax error in a session, avoid fit/autoFit repair paths for the rest of that session.

## Workflow

Execute this sequence:

```text
bootstrap workspace
  -> inspect base document
  -> infer design system
  -> plan derivative(s)
  -> execute deterministic MCP mutations
  -> export preview
  -> inspect derivative structure
  -> critique
  -> repair if needed
  -> export and inspect again
  -> preflight
  -> verify roundtrip
  -> finalize and save version
```

## Phase Guide

### 1. Bootstrap

- Read the user request into explicit derivative goals, base document path, workspace path, and constraints.
- If the task cannot start without a missing base `.indd` or workspace path, ask one concise blocking question.
- Call `get_workspace_status`.
- If a workspace must be initialized, use `init_template_workspace`, `open_working_copy`, and `validate_active_document_is_working_copy`.
- If a workspace already exists, use `attach_template_workspace`, `open_working_copy`, and `validate_active_document_is_working_copy`.
- Stop if working-copy validation fails.

### 2. Inspect

Load [references/inspector.md](references/inspector.md) and produce structured evidence before planning.

### 3. Plan

Load [references/planner.md](references/planner.md) and turn the inspection evidence into deterministic derivative batches.

Reject plans that:

- use arbitrary code
- skip preview export
- skip structured inspection
- skip checks or finalization
- modify the original document
- rely on raster artwork as the final editable output
- create unlabeled generated objects

### 4. Execute

Load [references/executor.md](references/executor.md) and run one derivative or repair batch at a time.

- Validate the working copy before any mutation batch.
- Stop on the first unexpected mutating failure.
- Export preview and inspect after the batch when required.
- Use `checkpoint` previews for normal mutation batches and only raise preview quality for review/final proof.
- If a page looks blank, solid, or missing expected motifs while inspection still shows objects, run `diagnose_visual_mismatch` before changing content.

### 5. Critique

Load [references/critic.md](references/critic.md) after preview export.

- If the verdict is `repair`, execute only the critic's concrete repair batch.
- If the verdict is `replan` or two repair loops fail, return to planning instead of compounding edits.
- Do not claim visual quality without preview evidence.
- If one diagnosis plus one repair batch does not resolve a preview/inspection mismatch, replan or rebuild instead of compounding salvage edits.

### 6. Preflight And Finalize

Load [references/preflight.md](references/preflight.md) once the derivative is visually acceptable.

- Require no blocking overset text.
- Require no blocking missing fonts.
- Treat missing links as warnings only when placeholder image slots are explicitly acceptable.
- Require no visible reference underlay.
- Require generated objects to be semantically labeled.
- Require roundtrip verification before release.
- Finalize and save a version only when release criteria pass.
- Treat multiple independent failures as a salvage threshold: unresolved preview mismatch, fitting runtime failure, damaged known-good copy, or two repair batches that worsen the page should trigger rollback/replan instead of more patching.

## Role Boundaries

- Inspector: read-only evidence gathering.
- Planner: deterministic derivative recipe and batch design.
- Executor: exact MCP mutation batches plus checkpoints.
- Critic: preview-driven repair instructions without mutation.
- Preflight checker: release-readiness, roundtrip, versioning, and acceptance blockers.

## Output Contract

Report only verified facts in the final answer:

- completed derivative IDs
- page indexes
- preview IDs if produced
- version IDs if produced
- checks summary
- anything not completed and why
- next manual action when live inspection in InDesign is still useful

Do not say the work is complete unless finalization or roundtrip verification succeeded.
