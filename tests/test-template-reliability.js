import assert from 'node:assert/strict';
import fs from 'node:fs';

import { templateToolDefinitions } from '../src/types/toolDefinitionsTemplate.js';
import { resolvePreviewExportSettings } from '../src/handlers/templateHandlers.js';

const source = fs.readFileSync(new URL('../src/handlers/templateHandlers.js', import.meta.url), 'utf8');

const byName = new Map(templateToolDefinitions.map((tool) => [tool.name, tool]));

assert.ok(byName.has('diagnose_visual_mismatch'));
assert.ok(byName.has('set_item_layer'));
assert.ok(byName.has('export_derivative_preview'));
assert.ok(byName.has('fit_text_to_frame'));
assert.ok(byName.has('update_text_slot'));

assert.notDeepEqual(
    byName.get('diagnose_visual_mismatch').inputSchema,
    byName.get('set_item_layer').inputSchema
);
assert.notDeepEqual(
    byName.get('set_item_layer').inputSchema,
    byName.get('export_derivative_preview').inputSchema
);

assert.equal(byName.get('set_item_layer').inputSchema.properties.layerName.minLength, 1);
assert.equal(byName.get('return_preview_as_image').inputSchema.properties.returnImage.default, false);
assert.equal(byName.get('export_derivative_preview').inputSchema.properties.previewQuality.default, 'checkpoint');

assert.deepEqual(resolvePreviewExportSettings({}), { previewQuality: 'checkpoint', resolution: 48 });
assert.deepEqual(resolvePreviewExportSettings({ previewQuality: 'checkpoint' }), { previewQuality: 'checkpoint', resolution: 48 });
assert.deepEqual(resolvePreviewExportSettings({ previewQuality: 'review' }), { previewQuality: 'review', resolution: 96 });
assert.deepEqual(resolvePreviewExportSettings({ previewQuality: 'final' }), { previewQuality: 'final', resolution: 150 });
assert.deepEqual(resolvePreviewExportSettings({ previewQuality: 'review', resolution: 72 }), { previewQuality: 'review', resolution: 72 });
assert.deepEqual(resolvePreviewExportSettings({ previewQuality: 'bogus' }), { previewQuality: 'checkpoint', resolution: 48 });

assert.ok(!source.includes('args.maxPointSize ?? before.pointSize || 72'));
assert.match(source, /args\.maxPointSize\s*\?\?\s*\(before\.pointSize\s*\|\|\s*72\)/);

const updateTextStart = source.indexOf('static update_text_slot');
assert.ok(updateTextStart >= 0, 'update_text_slot handler missing');
const idxGuard = source.indexOf('update_text_slot no longer supports fit=true', updateTextStart);
const idxRunGuarded = source.indexOf('const updated = await runGuarded', updateTextStart);
assert.ok(idxGuard !== -1, 'fit=true rejection message missing');
assert.ok(idxRunGuarded !== -1, 'runGuarded call missing');
assert.ok(idxGuard < idxRunGuarded, 'fit=true guard must run before mutation path');

assert.ok(source.includes('static diagnose_visual_mismatch'));
assert.ok(source.includes('static set_item_layer'));
assert.ok(source.includes('previewQuality: previewSettings.previewQuality'));
assert.ok(source.includes("if (args.returnImage === true)"));

const setLayerStart = source.indexOf('static set_item_layer');
assert.ok(setLayerStart >= 0, 'set_item_layer handler missing');
const idxResolvedItems = source.indexOf('const resolvedItems = ids.map((id) => itemById(id));', setLayerStart);
const idxLayerAdd = source.indexOf('doc.layers.add', setLayerStart);
const idxLayerVisible = source.indexOf('targetLayer.visible = true', setLayerStart);
const idxLayerUnlock = source.indexOf('targetLayer.locked = false', setLayerStart);
const idxItemLayerMutation = source.indexOf('item.itemLayer = targetLayer', setLayerStart);
assert.ok(idxResolvedItems !== -1, 'set_item_layer must pre-resolve object IDs');
assert.ok(idxLayerAdd !== -1, 'set_item_layer layer creation path missing');
assert.ok(idxLayerVisible !== -1, 'set_item_layer visibility mutation path missing');
assert.ok(idxLayerUnlock !== -1, 'set_item_layer unlock mutation path missing');
assert.ok(idxItemLayerMutation !== -1, 'set_item_layer item move path missing');
assert.ok(idxResolvedItems < idxLayerAdd, 'object IDs must resolve before creating target layer');
assert.ok(idxResolvedItems < idxLayerVisible, 'object IDs must resolve before changing layer visibility');
assert.ok(idxResolvedItems < idxLayerUnlock, 'object IDs must resolve before unlocking target layer');
assert.ok(idxResolvedItems < idxItemLayerMutation, 'object IDs must resolve before moving any item');

console.log('Template reliability tests passed');
