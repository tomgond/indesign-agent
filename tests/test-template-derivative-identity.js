import assert from 'node:assert/strict';
import fs from 'node:fs';

import { templateToolDefinitions } from '../src/types/toolDefinitionsTemplate.js';

const source = fs.readFileSync(new URL('../src/handlers/templateHandlers.js', import.meta.url), 'utf8');
const byName = new Map(templateToolDefinitions.map((tool) => [tool.name, tool]));

assert.match(source, /static async resolveDerivativeTarget\(args = \{\}\)/);

const buildSlice = source.slice(source.indexOf('static build_derivative_from_recipe'), source.indexOf('static uxpTool'));
assert.match(buildSlice, /create_derivative_page\(args\)/);
assert.match(buildSlice, /resolveDerivativeTarget\(\{ derivativeId: args\.derivativeId \}\)/);
assert.match(buildSlice, /resolvedPage\.pageIndex/);
assert.match(buildSlice, /create_text_slot/);
assert.match(buildSlice, /create_image_slot/);
assert.doesNotMatch(buildSlice, /createTextFrameRaw\(/);
assert.doesNotMatch(buildSlice, /createImageFrameRaw\(/);

assert.equal(byName.get('duplicate_items_to_page').inputSchema.properties.textDuplicateMode.default, 'skip');
assert.equal(byName.get('create_derivative_page').inputSchema.properties.textDuplicateMode.default, 'skip');
assert.equal(byName.get('create_text_slot').inputSchema.anyOf.some((entry) => entry.required?.includes('derivativeId')), true);
assert.equal(byName.get('create_image_slot').inputSchema.anyOf.some((entry) => entry.required?.includes('derivativeId')), true);
assert.equal(byName.get('create_vector_motif').inputSchema.anyOf.some((entry) => entry.required?.includes('derivativeId')), true);
assert.equal(byName.get('create_vector_motif').inputSchema.required.includes('motifId'), true);
assert.equal(byName.get('create_vector_motif').inputSchema.required.includes('shapes'), true);

assert.match(String(byName.get('create_text_slot').description), /derivativeId/i);
assert.match(String(byName.get('create_image_slot').description), /derivativeId/i);
assert.match(String(byName.get('create_vector_motif').description), /derivativeId/i);
assert.match(String(byName.get('apply_layout_recipe').description), /safe replacement/i);
assert.match(String(byName.get('move_resize_items').description), /derivativeId/i);

console.log('Template derivative identity tests passed');
