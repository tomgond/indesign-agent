import assert from 'node:assert/strict';
import fs from 'node:fs';

import { templateToolDefinitions } from '../src/types/toolDefinitionsTemplate.js';

const source = fs.readFileSync(new URL('../src/handlers/templateHandlers.js', import.meta.url), 'utf8');

function getTool(name) {
    const tool = templateToolDefinitions.find((entry) => entry.name === name);
    assert.ok(tool, `missing tool definition: ${name}`);
    return tool;
}

function sliceBetween(text, startMarker, endMarker) {
    const start = text.indexOf(startMarker);
    assert.ok(start >= 0, `missing marker: ${startMarker}`);
    const end = endMarker ? text.indexOf(endMarker, start) : text.length;
    assert.ok(end >= 0, `missing end marker after ${startMarker}`);
    return text.slice(start, end);
}

{
    const inspectPageItems = getTool('inspect_page_items_v2');
    const inspectDocumentBundle = getTool('inspect_document_bundle');
    const inspectLayers = getTool('inspect_layers');
    const inspectParentPages = getTool('inspect_parent_pages');
    const oversetCheck = getTool('check_overset_text');
    const hiddenLockedCheck = getTool('check_hidden_or_locked_problem_items');

    assert.equal(inspectPageItems.inputSchema.properties.limit.default, 200);
    assert.equal(inspectPageItems.inputSchema.properties.offset.default, 0);
    assert.equal(inspectPageItems.inputSchema.properties.detailLevel.default, 'summary');
    assert.equal(inspectPageItems.inputSchema.properties.includeTextExcerpt.default, false);
    assert.equal(inspectPageItems.inputSchema.properties.includeImageMetadata.default, false);
    assert.equal(inspectPageItems.inputSchema.properties.includeTextMetadata.default, false);
    assert.equal(inspectPageItems.inputSchema.properties.includePathPoints.default, false);

    assert.equal(inspectDocumentBundle.inputSchema.properties.includeTextExcerpt.default, false);
    assert.equal(inspectLayers.inputSchema.properties.includeItemCounts.default, false);
    assert.equal(inspectParentPages.inputSchema.properties.includePageItems.default, false);
    assert.equal(oversetCheck.inputSchema.properties.includeTextExcerpt.default, false);
    assert.equal(oversetCheck.inputSchema.properties.allowHeavyInspection.default, false);
    assert.equal(hiddenLockedCheck.inputSchema.properties.allowHeavyInspection.default, false);
}

{
    const pageItemsBranch = sliceBetween(
        source,
        "if (${q(name)} === 'inspect_page_items_v2')",
        "if (${q(name)} === 'inspect_document_bundle')"
    );
    const boundedHelper = sliceBetween(
        source,
        'function inspectPageItemsBounded(options){',
        'function getItemCandidates(options, warnings){'
    );
    const textHelper = sliceBetween(
        source,
        'function textInfoForItem(it, options){',
        'function imageInfoForItem(it, options){'
    );
    const imageHelper = sliceBetween(
        source,
        'function imageInfoForItem(it, options){',
        'function shapeInfoForItem(it, options){'
    );
    const shapeHelper = sliceBetween(
        source,
        'function shapeInfoForItem(it, options){',
        'function baseItemInfo(it,i, options){'
    );

    assert.ok(pageItemsBranch.includes('inspectPageItemsBounded(args)'));
    assert.ok(!pageItemsBranch.includes('arr(itemSource(), args.detailLevel === \'summary\' ? itemInfoSummary : itemInfoForDetailLevel)'));
    assert.ok(!pageItemsBranch.includes('visibleItems = inspectedItems.filter'));

    assert.ok(boundedHelper.includes('limit'));
    assert.ok(boundedHelper.includes('offset'));
    assert.ok(boundedHelper.includes('pagination'));
    assert.ok(boundedHelper.includes('totalMatched'));
    assert.ok(boundedHelper.includes('hasMore'));
    assert.ok(boundedHelper.includes('itemMatchesCheapFilters'));
    assert.ok(textHelper.includes('includeTextExcerpt === true'));
    assert.ok(textHelper.includes('includeTextMetadata === true'));
    assert.ok(textHelper.includes('it.contents'));
    assert.ok(textHelper.includes('textStyleRanges'));
    assert.ok(textHelper.includes('characters'));
    assert.ok(imageHelper.includes('includeImageMetadata === true'));
    assert.ok(imageHelper.includes('itemLink'));
    assert.ok(imageHelper.includes('effectivePpi'));
    assert.ok(imageHelper.includes('actualPpi'));
    assert.ok(shapeHelper.includes('includePathPoints === true'));
    assert.ok(shapeHelper.includes('pathPoints'));
}

{
    const stylesBranch = sliceBetween(source, 'function inspectStyles(){', 'function inspectSwatches(){');
    const swatchesBranch = sliceBetween(source, 'function inspectSwatches(){', 'function inspectLayers(options){');
    const layersBranch = sliceBetween(source, 'function inspectLayers(options){', 'function inspectParentPages(options){');
    const parentToolBranch = sliceBetween(source, "if (${q(name)} === 'inspect_parent_pages') {", "if (${q(name)} === 'check_missing_links')");
    const parentInfoHelper = sliceBetween(source, 'function parentPageInfo(m,i, options){', 'function itemTypeName(it){');
    const linksBranch = sliceBetween(source, 'function checkMissingLinks(){', 'function checkMissingFonts(){');
    const fontsBranch = sliceBetween(source, 'function checkMissingFonts(){', 'function checkOversetText(options){');

    assert.ok(!stylesBranch.includes('doc.allPageItems'));
    assert.ok(!stylesBranch.includes('doc.pages'));
    assert.ok(!stylesBranch.includes('doc.spreads'));
    assert.ok(!stylesBranch.includes('itemSource()'));

    assert.ok(!swatchesBranch.includes('doc.allPageItems'));
    assert.ok(!swatchesBranch.includes('doc.pages'));
    assert.ok(!swatchesBranch.includes('doc.spreads'));
    assert.ok(!swatchesBranch.includes('doc.paragraphStyles'));

    assert.ok(!layersBranch.includes('itemSource()'));
    assert.ok(!layersBranch.includes('doc.allPageItems'));
    assert.ok(layersBranch.includes('includeItemCounts'));

    assert.ok(parentToolBranch.includes('includePageItems === true'));
    assert.ok(parentToolBranch.includes('inspectParentPages(args)'));
    assert.ok(!parentToolBranch.includes('pageItemsSummary'));
    assert.ok(parentInfoHelper.includes('pageItemsSummary'));
    assert.ok(parentInfoHelper.includes('pageItemsPagination'));
    assert.ok(parentInfoHelper.includes('includePageItems'));

    assert.ok(linksBranch.includes('check:\'missing_links\''));
    assert.ok(!linksBranch.includes('inspectedItems'));
    assert.ok(fontsBranch.includes('check:\'missing_fonts\''));
    assert.ok(!fontsBranch.includes('inspectedItems'));
}

{
    const bundleBranch = sliceBetween(
        source,
        "if (${q(name)} === 'inspect_document_bundle')",
        "if (${q(name)} === 'inspect_styles')"
    );
    assert.ok(bundleBranch.includes('includePageItems === true'));
    assert.ok(bundleBranch.includes('includeParentPageItems === true'));
    assert.ok(bundleBranch.includes('allowHeavyInspection=true when includePageItems=true'));
    assert.ok(bundleBranch.includes('allowHeavyInspection=true when includeParentPageItems=true'));
    assert.ok(bundleBranch.includes('includeStyles !== false'));
    assert.ok(bundleBranch.includes('includeSwatches !== false'));
    assert.ok(bundleBranch.includes('includeLayers !== false'));
    assert.ok(bundleBranch.includes('includeParents !== false'));
}

console.log('Template inspection bounds tests passed');
