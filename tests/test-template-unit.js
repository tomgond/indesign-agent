import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initWorkspace, loadWorkspace, upsertDerivativePage } from '../src/core/workspaceState.js';
import { assertWorkspacePath } from '../src/utils/pathGuard.js';
import { UtilityHandlers } from '../src/handlers/utilityHandlers.js';
import { InDesignMCPServer } from '../src/core/InDesignMCPServer.js';
import { templateToolDefinitions } from '../src/types/toolDefinitionsTemplate.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'indesign-template-unit-'));
const original = path.join(root, 'base.indd');
const workspaceRoot = path.join(root, 'workspace');
fs.writeFileSync(original, 'fake-indd-bytes');

const manifest = initWorkspace({ originalSourcePath: original, workspaceRoot });
assert.equal(fs.existsSync(path.join(workspaceRoot, 'manifest.json')), true);
assert.equal(fs.existsSync(path.join(workspaceRoot, 'input', 'base-copy.indd')), true);
assert.equal(fs.existsSync(path.join(workspaceRoot, 'work', 'current.indd')), true);

assert.equal(loadWorkspace(workspaceRoot).workingCopyPath, manifest.workingCopyPath);
assert.equal(assertWorkspacePath(path.join(workspaceRoot, 'previews', 'ok.png'), { kind: 'previews' }).kind, 'previews');
assert.throws(() => assertWorkspacePath(path.join(workspaceRoot, '..', 'escape.png'), { kind: 'previews' }), /traversal|inside workspaceRoot/);
assert.throws(() => assertWorkspacePath(path.join(workspaceRoot, 'exports', 'wrong.png'), { kind: 'previews' }), /previews/);
assert.throws(() => assertWorkspacePath(original, { kind: 'assets' }), /inside workspaceRoot|original/);

const derivative = upsertDerivativePage(loadWorkspace(workspaceRoot), 'derivative_001', {
    pageIndex: 1,
    name: 'Derivative 001',
    format: 'A5',
    pageSize: { width: 420, height: 595, unit: 'pt' }
});
assert.equal(derivative.derivativeId, 'derivative_001');
assert.equal(derivative.pageIndex, 1);
assert.deepEqual(derivative.previewIds, []);

const textSlotSchema = templateToolDefinitions.find((tool) => tool.name === 'create_text_slot');
assert.ok(textSlotSchema, 'create_text_slot schema must exist');
assert.deepEqual(textSlotSchema.inputSchema.required, ['derivativeId', 'role', 'slot', 'pageIndex', 'bounds', 'text']);
assert.equal(templateToolDefinitions.find((tool) => tool.name === 'align_items').inputSchema.properties.alignTo.enum.includes('referenceObject'), true);

delete process.env.ALLOW_EXECUTE_INDESIGN_CODE;
const denied = await UtilityHandlers.executeInDesignCode({
    code: 'return { success:true }',
    dangerousConfirmation: 'I understand this executes arbitrary InDesign code'
});
assert.equal(denied.success, false);
assert.match(String(denied.result), /disabled by default/);

const server = new InDesignMCPServer();
const openOriginal = await server.handleToolCall('open_document', { filePath: original });
assert.equal(openOriginal.success, false);
assert.match(String(openOriginal.result), /open_working_copy/);

const customSave = await server.handleToolCall('save_document', { filePath: path.join(workspaceRoot, 'exports', 'copy.indd') });
assert.equal(customSave.success, false);
assert.match(String(customSave.result), /custom save paths/);

const unsafeClose = await server.handleToolCall('close_document', { saveOptions: 'SAVE' });
assert.equal(unsafeClose.success, false);
assert.match(String(unsafeClose.result), /save_working_copy/);

const xmlEscape = await server.handleToolCall('export_document_xml', { filePath: path.join(root, 'out.xml') });
assert.equal(xmlEscape.success, false);
assert.match(String(xmlEscape.result), /workspaceRoot/);

const imageEscape = await server.handleToolCall('place_image', { objectId: 1, imagePath: original });
assert.equal(imageEscape.success, false);
assert.match(String(imageEscape.result), /inside workspaceRoot|original/);

const replaceEscape = await server.handleToolCall('replace_image_in_frame', { objectId: 1, imagePath: original });
assert.equal(replaceEscape.success, false);
assert.match(String(replaceEscape.result), /inside workspaceRoot|original/);

const underlayEscape = await server.handleToolCall('create_reference_underlay', { pageIndex: 0, bounds: [0, 0, 10, 10], imagePath: original });
assert.equal(underlayEscape.success, false);
assert.match(String(underlayEscape.result), /inside workspaceRoot|original/);

fs.rmSync(root, { recursive: true, force: true });
console.log('Template unit tests passed');
