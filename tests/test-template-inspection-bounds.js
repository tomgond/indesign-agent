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

function labelMatch(label, query) {
    const keys = Object.keys(query || {});
    return keys.length > 0 && keys.every((key) => {
        const expected = query[key];
        const actual = label ? label[key] : undefined;
        if (expected && typeof expected === 'object' && !Array.isArray(expected)) return labelMatch(actual || {}, expected);
        return actual === expected;
    });
}

function compileInspectionHelpers() {
    const start = source.indexOf('function clampInt');
    const end = source.indexOf('    `;', start);
    assert.ok(start >= 0 && end > start, 'missing inspection helper block');
    const helperCode = source.slice(start, end);
    const factory = new Function(
        'doc',
        'safe',
        'len',
        'arr',
        'at',
        'idOf',
        'collectionIndexById',
        'readLabel',
        'labelMatches',
        `${helperCode}; return { getItemCandidates, itemMatchesCheapFilters, itemMatchesNonVisibilityFilters, checkOversetText, checkHiddenOrLockedProblemItems, inspectPageItemsBounded };`
    );

    return (doc) => factory(
        doc,
        (fn, fallback = null) => {
            try { return fn(); } catch { return fallback; }
        },
        (value) => {
            try { return value.length || 0; } catch { return 0; }
        },
        (collection, fn) => {
            const out = [];
            for (let i = 0; i < (collection ? collection.length || 0 : 0); i++) out.push(fn(collection[i], i));
            return out;
        },
        (collection, index) => collection[index],
        (item) => item?.id ?? null,
        (collection, obj) => {
            const id = obj && obj.id;
            if (id == null) return null;
            for (let i = 0; i < (collection ? collection.length || 0 : 0); i++) {
                if (collection[i] && collection[i].id === id) return i;
            }
            return null;
        },
        (item) => item?.label || {},
        labelMatch
    );
}

{
    const inspectPageItems = getTool('inspect_page_items_v2');
    const inspectDocumentBundle = getTool('inspect_document_bundle');
    const inspectLayers = getTool('inspect_layers');
    const inspectParentPages = getTool('inspect_parent_pages');
    const inspectLayoutGrid = getTool('inspect_layout_grid');
    const analyzeDesignSystem = getTool('analyze_design_system');
    const oversetCheck = getTool('check_overset_text');
    const hiddenLockedCheck = getTool('check_hidden_or_locked_problem_items');

    assert.equal(inspectPageItems.inputSchema.properties.limit.default, 200);
    assert.equal(inspectPageItems.inputSchema.properties.limit.maximum, 500);
    assert.equal(inspectPageItems.inputSchema.properties.offset.default, 0);
    assert.equal(inspectPageItems.inputSchema.properties.detailLevel.default, 'summary');
    assert.deepEqual(inspectPageItems.inputSchema.properties.detailLevel.enum, ['summary', 'standard', 'deep']);
    assert.equal(inspectPageItems.inputSchema.properties.includeTextExcerpt.default, false);
    assert.equal(inspectPageItems.inputSchema.properties.includeImageMetadata.default, false);
    assert.equal(inspectPageItems.inputSchema.properties.includeTextMetadata.default, false);
    assert.equal(inspectPageItems.inputSchema.properties.includePathPoints.default, false);
    assert.equal(inspectPageItems.inputSchema.properties.includeParentItems.default, false);
    assert.equal(inspectPageItems.inputSchema.properties.allowHeavyInspection.default, false);

    assert.equal(inspectDocumentBundle.inputSchema.properties.includePageItems.default, false);
    assert.equal(inspectDocumentBundle.inputSchema.properties.includeParentPageItems.default, false);
    assert.equal(inspectDocumentBundle.inputSchema.properties.allowHeavyInspection.default, false);
    assert.equal(inspectDocumentBundle.inputSchema.properties.limit.maximum, 500);
    assert.equal(inspectDocumentBundle.inputSchema.properties.includeTextExcerpt.default, false);
    assert.equal(inspectLayers.inputSchema.properties.includeItemCounts.default, false);
    assert.equal(inspectParentPages.inputSchema.properties.includePageItems.default, false);
    assert.equal(inspectParentPages.inputSchema.properties.allowHeavyInspection.default, false);
    assert.equal(inspectParentPages.inputSchema.properties.limit.maximum, 500);
    assert.equal(oversetCheck.inputSchema.properties.includeTextExcerpt.default, false);
    assert.equal(oversetCheck.inputSchema.properties.allowHeavyInspection.default, false);
    assert.equal(oversetCheck.inputSchema.properties.limit.maximum, 500);
    assert.equal(hiddenLockedCheck.inputSchema.properties.allowHeavyInspection.default, false);
    assert.equal(hiddenLockedCheck.inputSchema.properties.limit.maximum, 500);
    assert.equal(inspectLayoutGrid.inputSchema.properties.limit.default, 500);
    assert.equal(inspectLayoutGrid.inputSchema.properties.limit.maximum, 500);
    assert.equal(analyzeDesignSystem.inputSchema.properties.limit.default, 500);
    assert.equal(analyzeDesignSystem.inputSchema.properties.limit.maximum, 500);
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
    const candidateHelper = sliceBetween(
        source,
        'function getItemCandidates(options, warnings){',
        'function inspectStyles(){'
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
    assert.ok(candidateHelper.includes('page.allPageItems || page.pageItems'));
    assert.ok(!candidateHelper.includes('page.pageItems || page.allPageItems'));

    assert.ok(boundedHelper.includes('limit'));
    assert.ok(boundedHelper.includes('offset'));
    assert.ok(boundedHelper.includes('pagination'));
    assert.ok(boundedHelper.includes('totalMatched'));
    assert.ok(boundedHelper.includes('hasMore'));
    assert.ok(boundedHelper.includes('itemMatchesCheapFilters'));
    assert.ok(!boundedHelper.includes('DEEP_FIELDS_OMITTED'));
    assert.ok(boundedHelper.includes('const sliced = matched.slice'));
    assert.ok(boundedHelper.includes('sliced.map'));
    assert.ok(boundedHelper.indexOf('const sliced = matched.slice') < boundedHelper.indexOf('sliced.map'));
    assert.equal((source.match(/MASTER_PAGE_ITEMS_OMITTED/g) || []).length, 1);

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
    const designSystemBranch = sliceBetween(source, 'static analyze_design_system(args = {}) {', 'static compare_derivative_state(args = {}) {');

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
    assert.ok(linksBranch.includes('doc.links'));
    assert.ok(fontsBranch.includes('check:\'missing_fonts\''));
    assert.ok(!fontsBranch.includes('inspectedItems'));
    assert.ok(fontsBranch.includes('doc.fonts'));

    assert.ok(designSystemBranch.includes("includeTextMetadata: true"));
    assert.ok(designSystemBranch.includes("detailLevel: 'standard'"));
    assert.ok(designSystemBranch.includes('includeTextExcerpt: false'));
    assert.ok(designSystemBranch.includes('includeImageMetadata: false'));
    assert.ok(designSystemBranch.includes('includePathPoints: false'));
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

{
    const runPreflightBranch = sliceBetween(source, 'function runPreflight(options){', 'if (${q(name)} === \'inspect_page_items_v2\')');
    assert.ok(runPreflightBranch.includes('Heavy item checks were skipped; pass pageIndex, spreadIndex, or allowHeavyInspection=true to run overset and hidden/locked checks.'));
}

{
    const helpers = compileInspectionHelpers();
    const page = {
        id: 10,
        allPageItems: [
            { id: 1, name: 'top', constructor: { name: 'Rectangle' }, visible: true, itemLayer: { name: 'Layer A', visible: true }, parentPage: { id: 10 }, label: {} },
            { id: 2, name: 'nested', constructor: { name: 'TextFrame' }, visible: true, itemLayer: { name: 'Layer A', visible: true }, parentPage: { id: 10 }, label: {} },
            { id: 3, name: 'master-shared', constructor: { name: 'Rectangle' }, visible: true, itemLayer: { name: 'Layer A', visible: true }, parentPage: { id: 10 }, label: {} }
        ],
        pageItems: [
            { id: 1, name: 'top', constructor: { name: 'Rectangle' }, visible: true, itemLayer: { name: 'Layer A', visible: true }, parentPage: { id: 10 }, label: {} }
        ],
        masterPageItems: [
            { id: 3, name: 'master-shared', constructor: { name: 'Rectangle' }, visible: true, itemLayer: { name: 'Layer A', visible: true }, parentPage: { id: 10 }, label: {} },
            { id: 4, name: 'master-only', constructor: { name: 'Rectangle' }, visible: true, itemLayer: { name: 'Layer A', visible: true }, parentPage: { id: 10 }, label: {} }
        ]
    };
    const doc = {
        pages: [page],
        spreads: [{ id: 20, allPageItems: [], pageItems: [] }],
        links: [],
        fonts: [],
        layers: [],
        swatches: [],
        paragraphStyles: [],
        characterStyles: [],
        objectStyles: [],
        tableStyles: [],
        cellStyles: [],
        preflightOptions: { preflightOff: false },
        documentPreferences: {},
        viewPreferences: {}
    };
    const { getItemCandidates } = helpers(doc);
    const candidates = getItemCandidates({ pageIndex: 0, includeParentItems: false }, []);
    assert.equal(candidates.length, 3);
    assert.equal(candidates.some((item) => item.id === 2), true);
    const withParents = getItemCandidates({ pageIndex: 0, includeParentItems: true }, []);
    assert.equal(withParents.some((item) => item.id === 4), true);
    assert.equal(withParents.filter((item) => item.id === 3).length, 1);
}

{
    const helpers = compileInspectionHelpers();
    const hiddenLayer = { name: 'Hidden Layer', visible: false };
    const visibleLayer = { name: 'Visible Layer', visible: true };
    const doc = {
        pages: [{
            id: 10,
            allPageItems: [
                { id: 1, name: 'visible-overset', constructor: { name: 'TextFrame' }, visible: true, overflows: true, contents: 'visible body', itemLayer: visibleLayer, parentPage: { id: 10 }, label: {} },
                { id: 2, name: 'hidden-overset', constructor: { name: 'TextFrame' }, visible: false, overflows: true, contents: 'hidden body', itemLayer: hiddenLayer, parentPage: { id: 10 }, label: {} }
            ]
        }],
        spreads: [{ id: 20, allPageItems: [], pageItems: [] }],
        links: [],
        fonts: [],
        layers: [],
        swatches: [],
        paragraphStyles: [],
        characterStyles: [],
        objectStyles: [],
        tableStyles: [],
        cellStyles: [],
        preflightOptions: { preflightOff: false },
        documentPreferences: {},
        viewPreferences: {}
    };
    const { checkOversetText } = helpers(doc);
    const result = checkOversetText({ pageIndex: 0, includeHidden: false, includeTextExcerpt: false, limit: 10, offset: 0 });
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].objectName, 'visible-overset');
    assert.equal(result.pagination.totalMatched, 1);
    const hiddenIncluded = checkOversetText({ pageIndex: 0, includeHidden: true, includeTextExcerpt: true, limit: 10, offset: 0 });
    assert.equal(hiddenIncluded.issues.length, 2);
    assert.equal(Object.prototype.hasOwnProperty.call(hiddenIncluded.issues[1], 'textExcerpt'), true);
    const emptyPage = checkOversetText({ pageIndex: 0, includeHidden: true, includeTextExcerpt: false, limit: 1, offset: 99 });
    assert.equal(emptyPage.pagination.totalMatched, 2);
    assert.equal(emptyPage.issues.length, 0);
    assert.equal(emptyPage.ok, false);
}

{
    const helpers = compileInspectionHelpers();
    const hiddenLayer = { name: 'Hidden Layer', visible: false };
    const visibleLayer = { name: 'Visible Layer', visible: true };
    const doc = {
        pages: [{
            id: 10,
            allPageItems: [
                { id: 1, name: 'alpha-hidden', constructor: { name: 'Rectangle' }, visible: false, locked: true, itemLayer: hiddenLayer, parentPage: { id: 10 }, label: { source: 'agent_created' } },
                { id: 2, name: 'beta-hidden', constructor: { name: 'Rectangle' }, visible: false, locked: true, itemLayer: visibleLayer, parentPage: { id: 10 }, label: { source: 'agent_created' } }
            ]
        }],
        spreads: [{ id: 20, allPageItems: [], pageItems: [] }],
        links: [],
        fonts: [],
        layers: [],
        swatches: [],
        paragraphStyles: [],
        characterStyles: [],
        objectStyles: [],
        tableStyles: [],
        cellStyles: [],
        preflightOptions: { preflightOff: false },
        documentPreferences: {},
        viewPreferences: {}
    };
    const { checkHiddenOrLockedProblemItems } = helpers(doc);
    const result = checkHiddenOrLockedProblemItems({ pageIndex: 0, includeHidden: false, layerName: 'Visible Layer', limit: 10, offset: 0 });
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].objectName, 'beta-hidden');
    assert.equal(result.pagination.totalMatched, 1);
    const emptyPage = checkHiddenOrLockedProblemItems({ pageIndex: 0, includeHidden: false, layerName: 'Visible Layer', limit: 1, offset: 99 });
    assert.equal(emptyPage.pagination.totalMatched, 1);
    assert.equal(emptyPage.issues.length, 0);
    assert.equal(emptyPage.ok, false);
}

console.log('Template inspection bounds tests passed');
