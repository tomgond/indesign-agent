import assert from 'node:assert/strict';
import fs from 'node:fs';

import { templateToolDefinitions } from '../src/types/toolDefinitionsTemplate.js';

const source = fs.readFileSync(new URL('../src/handlers/templateHandlers.js', import.meta.url), 'utf8');
const byName = new Map(templateToolDefinitions.map((tool) => [tool.name, tool]));

assert.match(source, /static async resolveDerivativeTarget\(args = \{\}\)/);

const createDerivativeSlice = source.slice(source.indexOf('static create_derivative_page'), source.indexOf('static resolve_derivative_page'));
assert.match(createDerivativeSlice, /unwrapToolResult\(await this\.duplicate_items_to_page/);
assert.match(createDerivativeSlice, /duplicatedMotifs = dupe\.duplicatedObjects \|\| \[\]/);
assert.match(createDerivativeSlice, /skippedMotifs = dupe\.skippedObjects \|\| \[\]/);
assert.match(createDerivativeSlice, /duplicateWarnings = dupe\.warnings \|\| \[\]/);

const buildSlice = source.slice(source.indexOf('static build_derivative_from_recipe'), source.indexOf('static uxpTool'));
assert.match(buildSlice, /create_derivative_page\(args\)/);
assert.match(buildSlice, /resolveDerivativeTarget\(\{ derivativeId: args\.derivativeId \}\)/);
assert.match(buildSlice, /resolvedPage\.pageIndex/);
assert.match(buildSlice, /unwrapToolResult\(await this\.create_text_slot/);
assert.match(buildSlice, /unwrapToolResult\(await this\.create_image_slot/);
assert.match(buildSlice, /if \(result\?\.objectId != null\) createdObjectIds\.push\(result\.objectId\)/);
assert.match(buildSlice, /else if \(Array\.isArray\(result\?\.objectIds\)\) createdObjectIds\.push\(\.\.\.result\.objectIds\)/);
assert.match(buildSlice, /Recipe item did not return objectId\/objectIds/);
assert.doesNotMatch(buildSlice, /createTextFrameRaw\(/);
assert.doesNotMatch(buildSlice, /createImageFrameRaw\(/);

const duplicateSlice = source.slice(source.indexOf('static duplicate_items_to_page'), source.indexOf('static create_text_slot'));
assert.match(duplicateSlice, /duplicateBounds = clone\(safe\(\(\)=>duplicate\.geometricBounds, null\)\)/);
assert.match(duplicateSlice, /transformBounds\(duplicateBounds\)/);
assert.match(duplicateSlice, /duplicate = source\.duplicate\(targetPage\);\s*const duplicateBounds = clone\(safe\(\(\)=>duplicate\.geometricBounds, null\)\);\s*const transformed = transformBounds\(duplicateBounds\);/);

assert.equal(byName.get('duplicate_items_to_page').inputSchema.properties.textDuplicateMode.default, 'skip');
assert.equal(byName.get('create_derivative_page').inputSchema.properties.textDuplicateMode.default, 'skip');
assert.equal(byName.get('create_text_slot').inputSchema.anyOf.some((entry) => entry.required?.includes('derivativeId')), true);
assert.equal(byName.get('create_image_slot').inputSchema.anyOf.some((entry) => entry.required?.includes('derivativeId')), true);
assert.equal(byName.get('create_vector_motif').inputSchema.anyOf.some((entry) => entry.required?.includes('derivativeId')), true);
assert.equal(byName.get('create_vector_motif').inputSchema.required.includes('motifId'), true);
assert.equal(byName.get('create_vector_motif').inputSchema.required.includes('shapes'), true);
assert.equal(byName.get('export_derivative_preview').inputSchema.anyOf.some((entry) => entry.required?.includes('derivativeId')), true);
assert.equal(byName.get('export_derivative_preview').inputSchema.anyOf.some((entry) => entry.required?.includes('pageIndex')), true);

assert.match(String(byName.get('create_text_slot').description), /derivativeId/i);
assert.match(String(byName.get('create_image_slot').description), /derivativeId/i);
assert.match(String(byName.get('create_vector_motif').description), /derivativeId/i);
assert.match(String(byName.get('apply_layout_recipe').description), /safe replacement/i);
assert.match(String(byName.get('move_resize_items').description), /derivativeId/i);

console.log('Template derivative identity tests passed');
