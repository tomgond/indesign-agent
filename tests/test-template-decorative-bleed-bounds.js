import assert from 'node:assert/strict';
import fs from 'node:fs';

import { templateToolDefinitions } from '../src/types/toolDefinitionsTemplate.js';

const source = fs.readFileSync(new URL('../src/handlers/templateHandlers.js', import.meta.url), 'utf8');
const byName = new Map(templateToolDefinitions.map((tool) => [tool.name, tool]));

assert.match(source, /const decorative = !!\(args && \(args\.decorative === true \|\| args\.allowBleed === true \|\| args\.role === 'decorative'\)\)/);
assert.match(source, /const maxOutsideRatio = args && args\.maxOutsidePageRatio == null \? \(decorative \? 0\.85 : 0\.25\) : Number\(args\.maxOutsidePageRatio\)/);
assert.match(source, /const requirePageIntersection = !\(args && args\.requirePageIntersection === false\)/);

assert.equal(byName.get('create_vector_motif').inputSchema.properties.allowBleed.default, false);
assert.equal(byName.get('create_vector_motif').inputSchema.properties.decorative.default, false);
assert.equal(byName.get('create_vector_motif').inputSchema.properties.requirePageIntersection.default, true);
assert.equal(byName.get('create_derivative_page').inputSchema.properties.textDuplicateMode.default, 'skip');
assert.equal(byName.get('build_derivative_from_recipe').inputSchema.properties.textDuplicateMode.default, 'skip');

const recipeItem = byName.get('build_derivative_from_recipe').inputSchema.properties.items.items;
assert.equal(recipeItem.properties.allowBleed.type, 'boolean');
assert.equal(recipeItem.properties.decorative.type, 'boolean');
assert.equal(recipeItem.properties.requirePageIntersection.type, 'boolean');

assert.equal(byName.get('create_text_slot').inputSchema.properties.rejectOutOfPageBounds.default, true);
assert.equal(byName.get('create_image_slot').inputSchema.properties.rejectOutOfPageBounds.default, true);
assert.equal(byName.get('create_shape').inputSchema.properties.maxOutsidePageRatio.default, 0.25);

console.log('Template decorative bleed tests passed');
