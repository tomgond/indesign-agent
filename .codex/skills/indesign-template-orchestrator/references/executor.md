# Executor

Use this reference for deterministic MCP mutation batches.

## Mission

Execute an approved batch against the workspace working copy and report exact evidence.

## Hard Rules

1. Validate the active working copy before any mutating tool.
2. Never mutate the original INDD.
3. Never use arbitrary code tools for normal template generation.
4. Never add extra design changes outside the provided batch.
5. Stop on the first unexpected mutating failure unless the batch is explicitly best-effort.
6. Export a preview when the batch requires one.
7. Inspect the derivative after preview export when `derivativeId` is known.
8. Prefer labels and names over raw object IDs for follow-up edits.
9. If target selection is ambiguous, stop and report candidates.
10. If a derivative build results in zero items, mark the batch failed.
11. Use `previewQuality: "checkpoint"` for normal checkpoints unless review/final proof needs higher resolution.
12. Do not call `update_text_slot` with `fit:true`; export/inspect after text mutation, then fit separately only if needed.
13. Use `set_item_layer`, `send_to_back`, or `bring_to_front` for explicit stacking repairs after diagnosis.
14. Do not treat object creation as visibility success; require preview plus structured inspection after visible mutation batches.
15. Once text or content is correct and visible, avoid destructive text updates and risky fit paths.

## Protocol

1. Validate with `get_workspace_status` and `validate_active_document_is_working_copy`.
2. Execute exactly one ordered batch of tool calls.
3. Run checkpoints as requested:
   - preview export
   - derivative inspection
   - derivative checks
   - version save
4. After derivative creation, after adding a full-page background, after duplicating source motifs/text, and after layer/z-order repair, export a checkpoint preview before more mutation.
5. If preview and inspection disagree after a visible mutation batch, stop normal editing and route through `diagnose_visual_mismatch` before more content changes.
6. If one or two targeted repairs do not improve the preview, or known-good text becomes uncertain, recommend rollback or replan instead of more salvage.
7. Return tool-by-tool results, created and modified objects, checkpoint artifacts, errors, and the recommended next step.

## Rubric-Scoped Repairs

- Execute repair tool calls only when explicitly scoped by the approved plan or a structured rubric issue/category.
- Do not improvise unrelated visual changes.
- Preserve every `doNotChange` constraint.
- Report the rubric issue IDs/categories each repair attempted to address.
- After every visible repair batch, checkpoint with exported preview plus structured inspection.
- If the preview worsens or preview and inspection disagree, stop and route back to critic/planner; do not continue content mutation.

## Failure Handling

- Validation failure: stop.
- Mutating-tool failure: stop and mark the batch failed.
- Ambiguous target: stop and report candidates.
- Missing page index: fail and route back to inspection or planning.
- Out-of-page bounds: fail and report the offending bounds for planner repair.
- If `fit_text_to_frame` fails with a runtime or syntax error, stop using fit or autoFit paths in the current session and route repairs to geometry/layer changes instead.
- If a preview turns blank, solid-color, or missing expected motifs while objects still exist, stop content edits and use only targeted visibility/layer/z-order repair.

Return `success` only when all planned tool calls and required checkpoints succeed.
