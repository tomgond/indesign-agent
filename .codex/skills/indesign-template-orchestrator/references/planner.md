# Planner

Use this reference for deterministic derivative planning.

## Mission

Convert user goals and inspection evidence into a practical MCP execution plan that preserves editability and reuses the base document's design system.

## Planning Priorities

1. Prefer `build_derivative_from_recipe` for the initial complete build.
2. Use `create_derivative_page` plus semantic slot or motif tools for controlled builds.
3. Use `duplicate_page` or `duplicate_items_to_page` only when the base structure is already close.
4. Use primitive tools only when semantic tools cannot express the required object.

## Coordinate Defaults

- `unit: pt`
- `coordinateSpace: page`
- `bounds_order: [top, left, bottom, right]`
- `layerName: AGENT_WORK`
- `rejectOutOfPageBounds: true`
- `maxOutsidePageRatio: 0.25`

Require `inspect_page_geometry` evidence before placing objects on a page.

Before planning a derivative from an existing/source page, require:

- working-copy validation
- source/base-page geometry and key-object inspection
- a source/base-page checkpoint preview used as the visual anchor
- explicit notes on which visible motifs/text are preserved from the source
- one explicit layer strategy for the derivative

## Plan Requirements

Every derivative plan should define:

- `derivativeId`
- page size or dimensions
- `basePageIndex` when relevant
- `designIntent`
- `buildStrategy`
- editable items and motifs
- preview and inspection checkpoints
- derivative checks
- roundtrip or finalization expectations
- rollback/rebuild threshold when salvage would exceed one or two targeted repairs

Every generated object should include:

- `role`
- `slot` or `motifId`
- `name`
- semantic `label`

## Design-Quality Repair Planning

- Read the latest structured `designQualityRubric` before planning a repair.
- Treat rubric findings as constraints, not permission to redesign unrelated elements.
- Preserve `doNotChange` from both the rubric and user acceptance criteria.
- Every repair batch must cite the rubric issue IDs or categories it addresses.
- Do not invent style changes outside the user goal, source/base design evidence, or rubric findings.
- Replan or rebuild for structural failure, or after two targeted repair loops fail, rather than extending salvage work.
- Include design-quality acceptance criteria using the shared category names: `hierarchy`, `alignment`, `spacing`, `typography`, `contrastColor`, `imageUse`, `styleConsistency`, `editability`, and `productionRisk`.

## Quality Bar

Reject your own plan if it:

- uses unlabeled generated objects
- depends only on visual similarity
- skips preview export, structured inspection, preflight, or roundtrip
- relies on object IDs when labels are available
- places bounds without page-geometry evidence
- assumes fonts, styles, or swatches that inspection did not confirm
- mutates the original file
- relies only on copied object IDs or item counts instead of source preview plus inspection
- places full-page backgrounds without an explicit behind-content strategy
- assumes `autoFit` or text mutation is a normal geometry repair path

## Output Requirements

Return:

- summary status: `ready`, `blocked`, or `needs_more_inspection`
- assumptions and blockers
- workspace requirements
- derivative definitions with strategy, page, recipe, batches, and acceptance criteria
- risk register
- fallbacks
- executor notes
