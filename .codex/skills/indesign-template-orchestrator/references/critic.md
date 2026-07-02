# Critic

Use this reference for preview-driven derivative review. Judge from exported preview evidence plus structured inspection without mutating the document.

## Truth And Context

Validate `derivativeId`, preview ID, objective, and acceptance criteria. Inspect the derivative when inspection evidence is missing. If no preview exists, return `re_export_preview`.

- Exported preview is document/export/layout truth.
- Structured inspection is object/layer/text/geometry truth.
- Screenshots are only viewport/focus/UI diagnosis.
- If preview and inspection disagree, set `productionRisk` to warning or fail and recommend `diagnose_visual_mismatch` before content edits.

## Structured Design-Quality Rubric

Every substantive preview review must produce this `designQualityRubric` and pass it to `record_visual_review`:

```yaml
schemaVersion: "1.0"
overallStatus: pass | needs_repair | blocked
confidence: low | medium | high
summary: string
sourceEvidence:
  derivativeId: string
  previewId: string or null
  indesignPreviewId: string or null
  targetPreviewId: string or null
  inspectionId: string or null
  pageIndex: integer or null
  toolEvidence: [inspect_derivative, compare_derivative_state, run_derivative_checks]
  sourceBasePreviewId: string or null
categories:
  hierarchy: categoryResult
  alignment: categoryResult
  spacing: categoryResult
  typography: categoryResult
  contrastColor: categoryResult
  imageUse: categoryResult
  styleConsistency: categoryResult
  editability: categoryResult
  productionRisk: categoryResult
highSeverityIssues: []
blockers: []
warnings: []
recommendedNextBatch: object or null
doNotChange: []
```

Each category result must contain:

```yaml
rating: pass | warning | fail
severity: none | low | medium | high
score: 0 | 1 | 2 | 3
evidence: concise preview or inspection observation
affectedObjects: []
repairSuggestion: string
suggestedToolCalls: []
acceptanceImpact: none | readability | editability | productionSafety | userAcceptanceCriteria | visualQualityOnly
blocksFinalization: boolean
```

Use `3` for strong/pass, `2` for acceptable, `1` for warning, and `0` for fail. Every warning/fail needs evidence and a scoped repair suggestion. High-severity issues must state whether the impact is readability, editability, production safety, or stated user acceptance criteria. A `visualQualityOnly` finding is a warning and does not block finalization unless it clearly violates the user request or makes the design unreadable or unusable.

`recommendedNextBatch` is nullable. When present, it must identify issue IDs or categories and contain at most one bounded repair batch, never a free-form redesign. Preserve acceptance criteria and `doNotChange`.

## Review Flow

1. Validate context and gather missing structured inspection.
2. Load the exported preview; compare prior state when useful.
3. Build all nine category results from preview plus inspection evidence.
4. Produce at most one bounded repair batch.
5. Call `record_visual_review` with `derivativeId`, preview IDs, legacy fields when useful, and the full `designQualityRubric`.
6. Return the rubric, recording result, and verdict.

## Repair Constraints

- Do not suggest arbitrary code, rasterizing the final design, deleting large unknown object sets, replacing live text with an image, using a reference underlay as final artwork, or modifying the original file.
- Do not recommend `update_text_slot` with `fit:true`; change text, inspect/export, then fit separately if needed.
- Prefer labels over raw object IDs when available.
- For blank, solid-color, or incomplete previews with structured objects present, recommend `diagnose_visual_mismatch`, `set_item_layer`, `send_to_back`, or `bring_to_front` before content edits.
- Do not mutate known-good text for geometry repair.
- If one diagnosis and one repair batch are unlikely to help, or two targeted repair loops failed, recommend replan, rollback, or rebuild.

## Verdict Mapping

- `pass` normally maps to `preflight` or `accept`.
- `needs_repair` maps to `repair` only when the repair is bounded.
- `blocked` maps to `replan`, `rollback`, or `re_export_preview` according to the evidence.
- `accept` or `preflight` requires no high-severity blocker affecting readability, editability, production safety, or user acceptance criteria.
