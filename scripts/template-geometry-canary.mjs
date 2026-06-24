import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { InDesignMCPServer } from '../src/core/InDesignMCPServer.js';

async function call(server, name, args = {}) {
    const result = await server.handleToolCall(name, args);
    assert.equal(result.success, true, `${name} failed: ${JSON.stringify(result)}`);
    return result.result || result;
}

const derivativeId = 'geometry_canary_001';
const workspaceRoot = process.env.TEMPLATE_WORKSPACE_ROOT || path.join(os.tmpdir(), 'indesign-geometry-canary');
const fixtureInddPath = process.env.TEMPLATE_BASE_INDD;

if (process.env.RUN_TEMPLATE_LIVE !== '1') {
    console.log('template_geometry_canary skipped. Set RUN_TEMPLATE_LIVE=1 with TEMPLATE_BASE_INDD and a live InDesign bridge/plugin session.');
    process.exit(0);
}

if (!fixtureInddPath || !fs.existsSync(fixtureInddPath)) throw new Error('TEMPLATE_BASE_INDD must point to a real .indd file');

const server = new InDesignMCPServer();

await call(server, fs.existsSync(path.join(workspaceRoot, 'manifest.json')) ? 'attach_template_workspace' : 'init_template_workspace', fs.existsSync(path.join(workspaceRoot, 'manifest.json'))
    ? { workspaceRoot }
    : { originalInddPath: fixtureInddPath, workspaceRoot, overwriteExistingWorkspace: true });
await call(server, 'open_working_copy');
await call(server, 'validate_active_document_is_working_copy');
await call(server, 'inspect_document_bundle');
await call(server, 'inspect_page_geometry', { pageIndex: 0 });

await call(server, 'build_derivative_from_recipe', {
    derivativeId,
    name: 'Geometry Canary',
    width: 1080,
    height: 1080,
    unit: 'pt',
    coordinateSpace: 'page',
    items: [
        { type: 'shape', role: 'marker', motifId: 'top_left', shapeType: 'rectangle', bounds: [0, 0, 40, 40], fillSwatch: 'Black' },
        { type: 'shape', role: 'marker', motifId: 'top_right', shapeType: 'rectangle', bounds: [0, 1040, 40, 1080], fillSwatch: 'Black' },
        { type: 'shape', role: 'marker', motifId: 'bottom_left', shapeType: 'rectangle', bounds: [1040, 0, 1080, 40], fillSwatch: 'Black' },
        { type: 'shape', role: 'marker', motifId: 'bottom_right', shapeType: 'rectangle', bounds: [1040, 1040, 1080, 1080], fillSwatch: 'Black' },
        { type: 'shape', role: 'marker', motifId: 'center', shapeType: 'rectangle', bounds: [500, 400, 580, 680], fillSwatch: 'Black' },
        { type: 'text', role: 'label', slot: 'center_text', bounds: [500, 420, 560, 660], text: 'CANARY' }
    ],
    exportPreview: true,
    saveVersion: true,
    versionLabel: 'geometry canary'
});

await call(server, 'attach_template_workspace', { workspaceRoot });
await call(server, 'open_working_copy');
await call(server, 'resolve_derivative_page', { derivativeId });
const inspection = await call(server, 'inspect_derivative', { derivativeId, includeObjectDetails: true });
assert.ok(inspection.objectCount >= 5, 'geometry canary should create at least five visible objects');
const preview = await call(server, 'export_derivative_preview', { derivativeId, overwrite: true });
assert.ok(preview.widthPx > 0 && preview.heightPx > 0, 'preview must have nonzero dimensions');
const roundtrip = await call(server, 'verify_template_roundtrip', { derivativeId, expectedMinItems: 5, requirePreview: true });
assert.equal(roundtrip.ok, true, `roundtrip failed: ${JSON.stringify(roundtrip)}`);

console.log(JSON.stringify({ derivativeId, previewPath: preview.path, roundtrip }, null, 2));
