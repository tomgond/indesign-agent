import assert from 'node:assert/strict';
import fs from 'node:fs';

import { templateToolDefinitions } from '../src/types/toolDefinitionsTemplate.js';

const source = fs.readFileSync(new URL('../src/handlers/templateHandlers.js', import.meta.url), 'utf8');
const byName = new Map(templateToolDefinitions.map((tool) => [tool.name, tool]));

function sliceBetween(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.ok(start >= 0, `${startMarker} missing`);
    const end = source.indexOf(endMarker, start);
    assert.ok(end >= 0, `${endMarker} missing after ${startMarker}`);
    return source.slice(start, end);
}

const updateTextSlice = sliceBetween('static update_text_slot', 'static move_resize_items');
assert.match(updateTextSlice, /replaceTextFrameContentsSafely/);
assert.doesNotMatch(updateTextSlice, /it\.contents\s*=\s*String\(args\.text\)/);

const applyLayoutSlice = sliceBetween('static apply_layout_recipe', 'static set_bounds');
assert.match(applyLayoutSlice, /replaceTextFrameContentsSafely/);
assert.doesNotMatch(applyLayoutSlice, /it\.contents\s*=\s*String\(edit\.setText\)/);

const geometrySlice = sliceBetween("if (n === 'set_text_content')", "if (n === 'set_bounds' || n === 'resize_item')");
assert.match(geometrySlice, /replaceTextFrameContentsSafely/);
assert.doesNotMatch(geometrySlice, /it\.contents\s*=\s*args\.text/);

assert.match(source, /previousTextFrameId/);
assert.match(source, /nextTextFrameId/);
assert.match(source, /parentStoryId/);
assert.match(source, /threaded\/shared/);
assert.match(source, /isolatedOnly/);
assert.match(source, /resolved:\s*after\.overset\s*===\s*false/);
assert.match(source, /stillOverset:\s*after\.overset\s*===\s*true/);
assert.match(source, /const explicitOldExcerpt = options && options\.expectedOldTextExcerpt != null/);
assert.match(source, /const oldExcerptCheck = explicitOldExcerpt/);
assert.match(source, /const oldExcerptRequiredGone = !!oldExcerptCheck && nextText\.indexOf\(oldExcerptCheck\) === -1/);
assert.match(source, /nextText\.length === 0 \? observedExcerpt\.length === 0 : observedExcerpt\.length > 0 && requestedExcerpt\.startsWith\(observedExcerpt\)/);
assert.match(source, /replacementVerified = newTextPrefixOk && oldGoneOk/);
assert.doesNotMatch(source, /options && options\.expectedOldTextExcerpt != null \? String\(options\.expectedOldTextExcerpt\) : oldFrameExcerpt/);
assert.doesNotMatch(source, /excerptText\(nextText,\s*after\.frameExcerpt\.length\)/);
assert.match(source, /observedExcerpt\.length > 0/);
assert.match(source, /nextText\.length === 0/);

assert.equal(byName.get('update_text_slot').inputSchema.properties.textReplacePolicy.default, 'isolatedOnly');
assert.equal(byName.get('fit_text_to_frame').inputSchema.properties.allowThreadedText.default, false);
assert.match(source, /fit_text_to_frame/);

console.log('Template safe text mutation tests passed');
