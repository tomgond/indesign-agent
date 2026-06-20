# Feature 1: Workspace Safety, Path Jail, and Versioning

## Goal

Protect the original `.indd` and the external filesystem while allowing destructive experimentation inside a controlled workspace.

The safety model is intentionally simple: once the base file is copied into the workspace and opened as `work/current.indd`, the agent can make any InDesign object edits to that working copy. MCP must prevent edits, saves, exports, deletes, packages, or previews outside `workspaceRoot`.

## Tools to implement

- `init_template_workspace`
- `open_working_copy`
- `get_workspace_status`
- `save_working_copy`
- `save_version`
- `list_versions`
- `rollback_to_version`
- `validate_workspace_path`
- `validate_active_document_is_working_copy`

## Files to add or modify

Recommended new files:

- `src/utils/pathGuard.js`
- `src/core/workspaceState.js`
- `src/handlers/templateHandlers.js`
- `src/types/toolDefinitionsTemplate.js`

Existing files to modify:

- `src/types/index.js` to include new tool definitions.
- `src/core/InDesignMCPServer.js` to route new tools.
- Existing document/export/package/delete handlers to call the path guard where they can write or open paths.
- `src/handlers/utilityHandlers.js` and `src/types/toolDefinitionsUtility.js` to disable `execute_indesign_code` by default.

## Workspace state design

Persist durable state in `workspaceRoot/manifest.json`. Keep a lightweight in-memory cache in `workspaceState.js` for the currently initialized workspace, but always be able to reload from manifest so MCP restarts are recoverable.

Minimal manifest shape:

```json
{
  "originalSourcePath": "/absolute/path/to/base.indd",
  "workspaceRoot": "/absolute/path/to/template-run",
  "workingCopyPath": "/absolute/path/to/template-run/work/current.indd",
  "createdAt": "2026-06-19T00:00:00.000Z",
  "activeVersionId": null,
  "versions": [],
  "previews": [],
  "derivatives": []
}
```

Version record shape:

```json
{
  "versionId": "v001",
  "path": "/absolute/path/to/template-run/versions/v001.indd",
  "label": "speaker_post_first_pass",
  "createdAt": "2026-06-19T00:00:00.000Z",
  "source": "save_version"
}
```

## Central path guard

Implement a single helper and require all file-writing/opening tools to use it.

Recommended API:

```js
assertWorkspacePath(path, { kind, allowOriginalRead = false })
```

`kind` is the destination bucket: `input`, `work`, `previews`, `exports`, `versions`, `logs`, or `assets`.

Validation behavior:

1. Reject empty paths.
2. Reject raw path strings containing traversal segments such as `..`, `../`, or `..\\` before normalization.
3. Resolve `workspaceRoot` to a real absolute path.
4. Resolve existing candidate paths with `fs.realpath`.
5. For new destination files, resolve the real parent directory and then join the requested basename.
6. Check `path.relative(workspaceRoot, candidate)` does not start with `..` and is not absolute.
7. On Windows, compare normalized lower-case paths to avoid case-bypass issues.
8. Reject writes to `originalSourcePath` even if it is inside `workspaceRoot`.
9. Enforce destination subfolders:
   - previews only under `workspaceRoot/previews`
   - exports only under `workspaceRoot/exports`
   - versions only under `workspaceRoot/versions`
   - logs only under `workspaceRoot/logs`
   - working copy only under `workspaceRoot/work/current.indd`
10. Return a normalized absolute path plus metadata used by handlers.

Important exception: `init_template_workspace` may read `originalSourcePath` outside `workspaceRoot`; it may never write to it.

## Tool behavior details

### `init_template_workspace`

Inputs:

- `originalInddPath`
- `workspaceRoot`
- optional `overwriteExistingWorkspace` default `false`

Behavior:

1. Resolve and validate `originalInddPath` exists and ends with `.indd`.
2. Resolve `workspaceRoot`; reject if it is inside the original file path or conflicts with a file.
3. Create folders: `input`, `work`, `previews`, `exports`, `versions`, `logs`.
4. Copy original to `input/base-copy.indd`.
5. Copy `input/base-copy.indd` to `work/current.indd`.
6. Create `manifest.json` with absolute paths and timestamps.
7. Load this manifest into workspace state.
8. Return `workingCopyPath`, `workspaceRoot`, and manifest summary.

Do not open the original file. Do not save the original file.

### `open_working_copy`

Behavior:

1. Load manifest.
2. Validate `workingCopyPath` is exactly under `workspaceRoot/work/current.indd`.
3. Use UXP to open that file.
4. Return document name/path and active document verification.

Never accept an arbitrary path. This tool opens only the manifest's working copy.

### `validate_active_document_is_working_copy`

Use a UXP snippet to read `app.activeDocument.filePath` and compare it to `manifest.workingCopyPath` after normalization. Return:

```json
{
  "ok": true,
  "activeDocumentPath": ".../work/current.indd",
  "workingCopyPath": ".../work/current.indd"
}
```

If the active document is not the working copy, return `ok: false` and make mutating template tools fail before they edit anything.

### `save_working_copy`

Before saving:

1. Validate active document is the working copy.
2. Reject custom save paths.
3. Call the InDesign save operation without changing the path, or save explicitly to `work/current.indd` if the API requires a target.

### `save_version`

Inputs:

- optional `label`
- optional `derivativeId`

Behavior:

1. Validate active document is working copy.
2. Save current working copy.
3. Generate a version ID such as `v001`, `v002`, or timestamp-based `v20260619T120000Z`.
4. Copy `work/current.indd` to `versions/<versionId>.indd`.
5. Record version in manifest and set `activeVersionId`.
6. Return version record.

### `rollback_to_version`

Inputs:

- `versionId`
- optional `reopen` default `true`

Behavior:

1. Load manifest and find version.
2. Validate version path is under `workspaceRoot/versions`.
3. Close or save/discard the current working copy according to the safest available UXP behavior.
4. Copy the version file back to `work/current.indd`.
5. Reopen `work/current.indd` if requested.
6. Set `activeVersionId`.
7. Never touch `originalSourcePath`.

### `get_workspace_status`

Return manifest summary plus active document verification:

- workspace paths
- folder existence
- active document path
- active version
- version count
- preview count
- derivative records
- warnings if manifest and active document do not match

## Disable arbitrary JS by default

Current `execute_indesign_code` requires a confirmation string but still allows arbitrary code. For this MVP, public arbitrary JS execution should be disabled by default.

Implementation approach:

1. Add an environment flag such as `ALLOW_EXECUTE_INDESIGN_CODE=true` for development only.
2. If the flag is not set, return an error before sending code to the bridge.
3. Keep internal handlers using `ScriptExecutor.executeViaUXP()` for typed tools.
4. Update tool description to clearly state that public arbitrary execution is disabled by default.

This preserves the internal UXP execution architecture while removing the unsafe public tool from normal template-generation use.

## Existing tools that must become workspace-aware

Audit and guard tools that can open, save, export, package, or delete files:

- `open_document`
- `save_document`
- `export_pdf`
- `export_images`
- `package_document`
- any delete-file or delete-folder helpers if added later
- cloud or package tools that write external resources

For MVP template mode, reject these operations unless the destination is inside the current workspace and the active document is the working copy.

## Tests for this feature

Add unit or integration tests for:

- Cannot open original for editing.
- Cannot save to original path.
- Cannot write outside `workspaceRoot`.
- Rejects `../` traversal.
- Rejects symlink escape where practical.
- Allows read of original only during copy/init.
- `execute_indesign_code` denied by default.
- `init_template_workspace` creates the full folder structure.
- `save_version` records manifest version.
- `rollback_to_version` restores `work/current.indd` and never touches original.

## Acceptance criteria

- A single manifest identifies the current workspace and working copy.
- Every path-writing tool uses `pathGuard.js`.
- Original file remains byte-for-byte untouched during tests.
- All generated outputs are under `workspaceRoot`.
- Mutating template tools fail if the active document is not the working copy.
