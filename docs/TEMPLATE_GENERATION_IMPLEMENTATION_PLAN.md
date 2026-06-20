# Editable Template Generation Implementation Plan

## Purpose

This document is the implementation roadmap for extending the InDesign UXP MCP Server into a safe, typed InDesign manipulation layer for AI-assisted editable template generation.

The MCP server should **not** become a creative agent. Its role is to expose enough protected workspace management, document inspection, preview export, editable layout primitives, semantic labeling, versioning, and production checks for a separate AI agent to create derivative editable InDesign templates from one manually designed base document.

## Target Workflow

1. A user manually creates a strong base/master `.indd` file.
2. MCP initializes a protected template workspace and copies the base file into it.
3. MCP opens only the working copy.
4. An external AI agent inspects the design system and page items.
5. MCP exports previews that can be returned to a vision model.
6. The AI agent creates derivative pages/templates using real editable InDesign objects.
7. MCP exports previews, records review state, runs checks, saves versions, and supports rollback.
8. Final output is an editable INDD family inside the workspace, not a set of flattened images.

## Non-goals for the MVP

Do not implement these while building this plan:

- Autonomous design generation inside MCP.
- Model prompting or vision critique inside MCP.
- Full agent orchestration.
- Approval UI or human approval workflow.
- Complex policy profiles or enterprise permission systems.
- Advanced audit system.
- Cloud upload.
- Marketplace/plugin packaging.
- PDF/X certification.
- Full rasterized-layout detection.

## Existing Architecture Fit

The current project uses:

- `src/core/InDesignMCPServer.js` for MCP tool registration and dispatch.
- `src/core/scriptExecutor.js` for UXP bridge execution.
- `src/handlers/*Handlers.js` for tool implementations.
- `src/types/toolDefinitions*.js` for MCP schemas.
- `tests/` for handler and workflow checks.

Implementation should preserve this structure and keep the first pass small.

Recommended additions:

```text
src/
  core/
    workspaceState.js              # Workspace manifest/state helpers
  handlers/
    templateHandlers.js            # Template workspace, inspection, layout, review, checks
  types/
    toolDefinitionsTemplate.js
  utils/
    pathGuard.js                   # Central workspace path validation
    imageInfo.js                   # Minimal PNG/JPEG dimension/mime helpers
```

Split these files later only when they become painful to navigate.

Register the new schemas from `src/types/index.js` and route the new tool names in `InDesignMCPServer.handleToolCall()`.

## Feature Plan Documents

Implement the work in these feature groups:

1. [Remote Streamable HTTP MCP transport](./template-generation/00-remote-mcp-transport.md)
2. [Workspace safety, path jail, and versioning](./template-generation/01-workspace-safety.md)
3. [Document inspection and preview loop](./template-generation/02-inspection-and-preview.md)
4. [Editable layout primitives](./template-generation/03-editable-layout-tools.md)
5. [Semantic labels, reference underlays, and review state](./template-generation/04-labels-underlays-and-review-state.md)
6. [Production checks and MVP integration testing](./template-generation/05-production-checks-and-testing.md)

Current local implementation status is tracked in [Template Generation Implementation Status](./template-generation/IMPLEMENTATION_STATUS.md). The status file separates locally complete Node-side work from unverified or missing InDesign UXP behavior.

## Implementation Order

Build in this order to reduce risk:

1. Add Streamable HTTP MCP transport for remote Linux clients, using HTTP as the first/default transport for this project phase.
2. Make `BRIDGE_URL` configurable while keeping the bridge local to the Mac by default.
3. Add HTTP health and bridge-status endpoints.
4. Add `workspaceRoot` state and central path jail.
5. Add original-to-working-copy flow.
6. Add `save_version`, `list_versions`, and `rollback_to_version`.
7. Disable `execute_indesign_code` by default.
8. Add `export_page_preview`.
9. Add `return_preview_as_image`.
10. Add `inspect_document_bundle`.
11. Add `inspect_page_items_v2`.
12. Improve or add `create_text_frame` behavior for template use.
13. Add `create_image_frame`.
14. Add `create_shape` and `create_line`.
15. Add `set_bounds`, `move_item`, `resize_item`, and `rotate_item`.
16. Add `align_items` and `distribute_items`.
17. Improve `apply_styles` and `apply_swatches`.
18. Add semantic naming and label tools.
19. Add reference-underlay tools.
20. Add overset text check.
21. Add missing links check.
22. Add missing fonts check.
23. Add aggregate template preflight.
24. Add visual-review logging.
25. Add the three-derivative MVP integration test.

## Remote Operation Model

The target deployment for cross-platform use is:

```text
Linux OpenCode agent
  -> Streamable HTTP MCP endpoint on the Mac
      http://mac-host:3333/mcp

Mac
  -> MCP server bound to 0.0.0.0:3333 over Streamable HTTP
  -> bridge bound to 127.0.0.1:3000
  -> UXP plugin connected to 127.0.0.1:3001
  -> InDesign
```

Expose the MCP server, not the bridge. The bridge can execute InDesign code and should remain Mac-local. All paths passed to template tools must be valid Mac filesystem paths because InDesign runs on the Mac.

For the first implementation pass, MCP HTTP auth is not required. This is an accepted short-term development risk and should be documented in code comments/tests. Use `/Users/<you>/InDesignMCPWorkSpace/RunX` as the default/example workspace path convention.

## Tool Groups Required

### Workspace and safety

- `init_template_workspace`
- `open_working_copy`
- `get_workspace_status`
- `save_working_copy`
- `save_version`
- `list_versions`
- `rollback_to_version`
- `validate_workspace_path`
- `validate_active_document_is_working_copy`

### Inspection

- `inspect_document_bundle`
- `inspect_page_items_v2`
- `inspect_styles`
- `inspect_swatches`
- `inspect_layers`
- `inspect_parent_pages`

### Preview

- `export_page_preview`
- `export_spread_preview`
- `return_preview_as_image`

### Editable layout

- `create_page`
- `duplicate_page`
- `create_text_frame`
- `create_image_frame`
- `create_shape`
- `create_line`
- `place_image`
- `apply_styles`
- `apply_swatches`
- `set_text_content`
- `set_bounds`
- `move_item`
- `resize_item`
- `rotate_item`
- `lock_item`
- `unlock_item`
- `group_items`
- `ungroup_items`
- `bring_to_front`
- `send_to_back`
- `align_items`
- `distribute_items`
- `fit_content_to_frame`
- `fit_frame_to_content`

### Labels, reference, and review state

- `rename_page_item`
- `label_object`
- `get_object_label`
- `find_objects_by_label`
- `list_named_objects`
- `create_reference_underlay`
- `hide_reference_underlay`
- `remove_reference_underlay`
- `record_visual_review`
- `list_visual_reviews`
- `mark_derivative_accepted`
- `get_derivative_status`

### Production checks

- `check_overset_text`
- `check_missing_links`
- `check_missing_fonts`
- `check_hidden_or_locked_problem_items`
- `run_preflight`
- `run_template_preflight`

## Safety Model

Safety is enforced at the file/workspace boundary, not at every editable object operation.

Required rules:

- All generated work happens inside `workspaceRoot`.
- The original `.indd` is never opened for editing and is never saved over.
- The original is copied into `workspaceRoot/input/base-copy.indd`.
- The active editable document is `workspaceRoot/work/current.indd`.
- Path traversal such as `../` is rejected before normalization.
- All preview, export, version, log, and manifest writes stay inside `workspaceRoot`.
- Arbitrary JS execution is disabled by default.
- Destructive object edits are allowed inside the working copy.

This means the agent can freely experiment, delete pages, break layouts, and roll back while the original source file and external filesystem remain protected.

## Workspace Layout

Every template run uses this structure:

```text
/template-run/
  manifest.json
  input/
    base-copy.indd
  work/
    current.indd
  previews/
  exports/
  versions/
  logs/
```

`manifest.json` tracks:

- `originalSourcePath`
- `workspaceRoot`
- `workingCopyPath`
- `createdAt`
- `activeVersionId`
- `versions`
- `previews`
- `derivatives`
- optional `visualReviews`

## MVP Derivative Flow Acceptance

The implementation is sufficient when an external agent can complete this exact flow on a fixture INDD:

1. `init_template_workspace`
2. `open_working_copy`
3. `inspect_document_bundle`
4. `inspect_page_items_v2`
5. `export_page_preview`
6. `return_preview_as_image`
7. Create `speaker_post` page with live text, portrait placeholder, vector/background motifs, labels, preview, checks, and version.
8. Create `a5_invitation` page with live invitation fields, editable motifs, placeholders, preview, checks, and version.
9. Create `a3_room_sign` page with large room name, vector arrow, optional session text, preview, checks, and version.
10. Run `run_template_preflight`.
11. Roll back to one saved version and verify `work/current.indd` is restored.

## Definition of Done

The MCP is ready for separate-agent editable template generation when:

- Original INDD is untouched.
- All outputs are inside `workspaceRoot`.
- Arbitrary JS is disabled by default.
- The agent can inspect the base design system.
- The agent can inspect page items with geometry and styles.
- The agent can export and return preview images.
- The agent can create editable text/image/vector objects.
- The agent can apply existing styles and swatches.
- The agent can name and label objects semantically.
- The agent can adjust layout with bounds/alignment tools.
- The agent can run overset/link/font/preflight checks.
- The agent can save versions and roll back.
- The three-template MVP flow works on a test INDD.
