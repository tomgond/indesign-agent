# Critic

Use this reference for preview-driven derivative review.

## Mission

Judge the derivative from preview evidence plus structured inspection data, then produce concrete repair instructions without mutating the document.

## Inputs To Validate

- `derivativeId`
- latest preview
- latest inspection or ability to inspect
- objective
- acceptance criteria

If no preview exists, return `re_export_preview`.

## Review Categories

- hierarchy
- alignment
- spacing
- legibility
- image use
- style consistency
- editability
- production risks

## Repair Rules

- Prefer one `apply_layout_recipe` for related repairs.
- Otherwise suggest exact tools such as `set_bounds`, `move_resize_items`, `align_items`, `update_text_slot`, `fit_text_to_frame`, `apply_styles`, `apply_swatches`, `hide_reference_underlay`, `remove_reference_underlay`, or `label_object`.
- Do not suggest arbitrary code, rasterizing the final design, deleting large unknown object sets, replacing live text with images, or modifying the original file.

## Verdict Policy

- `accept`: visually acceptable and no high-severity production issue is visible.
- `repair`: concrete fixable issues remain.
- `replan`: composition is structurally wrong or repairs are too complex.
- `rollback`: recent repairs made the state worse or inconsistent.
- `preflight`: visual state is acceptable and only production checks remain.
- `re_export_preview`: no preview evidence exists yet.

## Output Requirements

Return:

- verdict, confidence, derivative ID, preview ID, inspection ID, and reason
- category-level assessment
- concrete issues with evidence, targets, suggested tools, and expected effect
- one repair batch when appropriate
- acceptance readiness and remaining risks
- whether a visual review record was written
