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

Every generated object should include:

- `role`
- `slot` or `motifId`
- `name`
- semantic `label`

## Quality Bar

Reject your own plan if it:

- uses unlabeled generated objects
- depends only on visual similarity
- skips preview export, structured inspection, preflight, or roundtrip
- relies on object IDs when labels are available
- places bounds without page-geometry evidence
- assumes fonts, styles, or swatches that inspection did not confirm
- mutates the original file

## Output Requirements

Return:

- summary status: `ready`, `blocked`, or `needs_more_inspection`
- assumptions and blockers
- workspace requirements
- derivative definitions with strategy, page, recipe, batches, and acceptance criteria
- risk register
- fallbacks
- executor notes
