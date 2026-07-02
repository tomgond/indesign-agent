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
12. Prefer exported previews for document truth, structured inspection for object/layer/text/geometry truth, and live screenshots only for viewport or UI diagnosis.
13. Do not run layer debugging by default. Use `diagnose_visual_mismatch` only on preview/inspection contradiction.
14. Never call `update_text_slot` with `fit:true`; treat content mutation and fitting as separate steps.
15. Treat `derivativeId` as the durable derivative target. Do not carry raw `pageIndex` forward when a page can be resolved again before mutation.
16. If `fit_text_to_frame` is needed, inspect the result fields and do not treat it as a story/thread repair.
17. Preserve known-good text before risky edits and do not use text mutation for geometry repair. Raw duplicated or threaded/shared text frames are not normal editable text.
18. Decorative bleed is opt-in. Keep normal content slots strict unless a call explicitly sets `allowBleed` or `decorative`.
19. If one or two targeted repairs fail to improve the page, rollback/replan instead of compounding salvage edits.
20. Use the shared structured `designQualityRubric` for visual review: `hierarchy`, `alignment`, `spacing`, `typography`, `contrastColor`, `imageUse`, `styleConsistency`, `editability`, and `productionRisk`.

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

## CSV/Table Template Fill Flow

When the request is "duplicate this finished page for each CSV/table row and change only text," use the simpler deterministic path instead of the creative derivative workflow:

1. Validate/open the workspace working copy and inspect the source page slots.
2. Let `scripts/fill_template_from_csv.py` read exact local CSV values; the model supplies only configuration and slot mapping.
3. Call `duplicate_template_page` once per row. Do not substitute `create_derivative_page`, which only creates a new page and optionally copies labeled editable motifs.
4. Update each field with `update_text_slot` targeted by `{ derivativeId, slot }`, never by selected frame/current page and never with `fit:true`.
5. Stop on duplicate slots or threaded/shared/raw text safety refusals. Fit separately only when explicitly configured and inspect the result.
6. Inspect/check the derivatives, sample checkpoint previews for large batches, and save the working copy/version.

The source slots should be labeled like `{ "slot": "name", "role": "title", "editable": true }`; duplication patches in the row's `derivativeId`. Completion requires the runner to report all selected rows processed with no row/slot errors. Visual completion still requires preview and structured inspection evidence. See `docs/template-generation/csv-template-fill.md`.

Live validation on 2026-06-29 covered the real Mac/InDesign/UXP path for full-page duplication, exact CSV transfer, isolated text replacement, separate fit repair, preview checkpoints, layer moves, asset placement, and derivative identity/page-index drift. Refer to `docs/live-mcp-validation.md` for the canonical evidence table.

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

Use `analyze_design_system` as bounded heuristic evidence, not truth. Call it page-scoped by default with an explicit `pageIndex`. Use summary or standard detail for planning, and reserve `allowHeavyInspection=true` for explicit multi-page or document-wide analysis. Do not request path points, image metadata, text excerpts, hidden items, or deep detail by default. Expect bounded signals such as `typeScale`, `fontUsage`, `colorRoles`, `spacingScale`, `marginHints`, `gridHints`, `motifCandidates`, `imageRoles`, `warnings`, `confidence`, and `provenance`. Confirm important conclusions from real page items and previews.

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

For repair planning, consume the latest rubric as constraints, preserve `doNotChange`, cite issue IDs/categories in each batch, and do not introduce unrelated redesign. Replan/rebuild on structural failure or after two failed targeted repair loops.

### 4. Execute

Load [references/executor.md](references/executor.md) and run one derivative or repair batch at a time.

- Validate the working copy before any mutation batch.
- Stop on the first unexpected mutating failure.
- Export preview and inspect after the batch when required.
- Use `checkpoint` previews for normal mutation batches and only raise preview quality for review/final proof.
- If a page looks blank, solid, or missing expected motifs while inspection still shows objects, run `diagnose_visual_mismatch` before changing content.
- Pick one explicit layer strategy before a derivative build:
  - generated objects on `AGENT_WORK` with backgrounds behind foreground content
  - duplicated source motifs/text on a known target layer with generated background behind them
  - source layers untouched with only safe editable overlays
- Do not place full-page backgrounds above source text, source motifs, or duplicated content.
- After visible mutation batches, require preview plus structured inspection agreement before continuing.
- Execute only plan-scoped or rubric-scoped repair calls, report addressed issue IDs/categories, preserve `doNotChange`, and stop for critic/planner review if the preview worsens or disagrees with inspection.

### 5. Critique

Load [references/critic.md](references/critic.md) after preview export.

- If the verdict is `repair`, execute only the critic's concrete repair batch.
- If the verdict is `replan` or two repair loops fail, return to planning instead of compounding edits.
- Do not claim visual quality without preview evidence.
- If one diagnosis plus one repair batch does not resolve a preview/inspection mismatch, replan or rebuild instead of compounding salvage edits.
- If known-good text became damaged or fitting failed with tool instability, prefer rollback/rebuild over more salvage edits.
- Require all nine rubric categories and call `record_visual_review` with the structured rubric for substantive review.

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
- Once text or content is correct and visible, avoid destructive text updates, risky fit paths, or unnecessary text-layer moves.
- Read the latest visual review when available. High-severity design issues block only for user acceptance criteria, readability, editability, or production safety; `visualQualityOnly` warnings do not block unless explicitly promoted into acceptance criteria.

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
