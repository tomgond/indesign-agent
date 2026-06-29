import assert from 'node:assert/strict';
import fs from 'node:fs';

import { templateToolDefinitions } from '../src/types/toolDefinitionsTemplate.js';

const source = fs.readFileSync(new URL('../src/handlers/templateHandlers.js', import.meta.url), 'utf8');
const byName = new Map(templateToolDefinitions.map((tool) => [tool.name, tool]));
const definition = byName.get('duplicate_template_page');

assert.ok(definition, 'duplicate_template_page must be in the template tool profile');
assert.deepEqual(definition.inputSchema.required, ['derivativeId', 'sourcePageIndex']);
assert.equal(definition.inputSchema.properties.relabelSlots.default, true);
assert.equal(definition.inputSchema.properties.copyPageLabel.default, false);
assert.equal(definition.inputSchema.properties.requireUniqueSlots.default, true);
assert.equal(definition.inputSchema.properties.textSafetyMode.default, 'preserve_but_guard');

const duplicateStart = source.indexOf('static duplicate_template_page');
const duplicateEnd = source.indexOf('static resolve_derivative_page', duplicateStart);
assert.ok(duplicateStart >= 0 && duplicateEnd > duplicateStart, 'duplicate_template_page handler missing');
const duplicateSlice = source.slice(duplicateStart, duplicateEnd);

assert.match(duplicateSlice, /sourcePage\.duplicate\(\)/);
assert.match(duplicateSlice, /this\.createDerivativePageMarker/);
assert.match(duplicateSlice, /upsertDerivativePage/);
assert.match(duplicateSlice, /source:\s*'duplicate_template_page'/);
assert.match(duplicateSlice, /Object\.assign\(\{\}, label, \{/);
assert.match(duplicateSlice, /derivativeId:\s*args\.derivativeId/);
assert.match(duplicateSlice, /copiedSlotItems/);
assert.match(duplicateSlice, /slot:\s*label\.slot/);
assert.match(duplicateSlice, /textFrameDiagnostics/);
assert.match(duplicateSlice, /Duplicate text slot names/);
assert.match(duplicateSlice, /createdPage\.remove\(\)/);

const updateStart = source.indexOf('static update_text_slot');
const updateEnd = source.indexOf('static move_resize_items', updateStart);
const updateSlice = source.slice(updateStart, updateEnd);
assert.match(updateSlice, /update_text_slot no longer supports fit=true/);
assert.match(updateSlice, /replaceTextFrameContentsSafely/);
assert.doesNotMatch(duplicateSlice, /replaceTextFrameContentsSafely/);

console.log('Template page duplication tests passed');
