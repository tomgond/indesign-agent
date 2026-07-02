import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initWorkspace, loadWorkspace, attachWorkspace, clearActiveWorkspace, activeWorkspaceStatePath, readActiveWorkspaceRoot, fileStatEvidence, upsertDerivativePage } from '../src/core/workspaceState.js';
import { assertWorkspacePath } from '../src/utils/pathGuard.js';
import { UtilityHandlers } from '../src/handlers/utilityHandlers.js';
import { TemplateHandlers, resolvePreviewExportSettings } from '../src/handlers/templateHandlers.js';
import { InDesignMCPServer } from '../src/core/InDesignMCPServer.js';
import { ScriptExecutor } from '../src/core/scriptExecutor.js';
import { templateToolDefinitions } from '../src/types/toolDefinitionsTemplate.js';
import { getToolDefinitionsForProfile } from '../src/types/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'indesign-template-unit-'));
const original = path.join(root, 'base.indd');
const workspaceRoot = path.join(root, 'workspace');
const activeStatePath = activeWorkspaceStatePath();
const priorActiveState = fs.existsSync(activeStatePath) ? fs.readFileSync(activeStatePath) : null;
fs.writeFileSync(original, 'fake-indd-bytes');
const templateHandlerSource = fs.readFileSync(new URL('../src/handlers/templateHandlers.js', import.meta.url), 'utf8');
const originalEnsureTemplateReady = TemplateHandlers.ensureTemplateReady;
const originalResolveDerivativeTarget = TemplateHandlers.resolveDerivativeTarget;
const originalExecuteViaUXP = ScriptExecutor.executeViaUXP;
const originalInspectLayoutGrid = TemplateHandlers.inspect_layout_grid;
const originalUxpTool = TemplateHandlers.uxpTool;

try {
    const manifest = initWorkspace({ originalSourcePath: original, workspaceRoot });
    assert.equal(fs.existsSync(path.join(workspaceRoot, 'manifest.json')), true);
    assert.equal(fs.existsSync(path.join(workspaceRoot, 'input', 'base-copy.indd')), true);
    assert.equal(fs.existsSync(path.join(workspaceRoot, 'work', 'current.indd')), true);
    assert.equal(readActiveWorkspaceRoot(), workspaceRoot);
    assert.equal(fs.existsSync(activeWorkspaceStatePath()), true);
    assert.equal(fileStatEvidence(manifest.workingCopyPath).sizeBytes > 0, true);

    assert.equal(loadWorkspace(workspaceRoot).workingCopyPath, manifest.workingCopyPath);
    clearActiveWorkspace();
    assert.equal(attachWorkspace(workspaceRoot).workingCopyPath, manifest.workingCopyPath);
    assert.equal(loadWorkspace().workingCopyPath, manifest.workingCopyPath);
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

    const assetDir = path.join(workspaceRoot, 'assets', 'imports', 'unit-test');
    const assetPath = path.join(assetDir, 'asset.svg');
    const outsideAssetPath = path.join(root, 'outside.svg');
    const svgText = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 12h18"/></svg>';
    fs.mkdirSync(assetDir, { recursive: true });
    fs.writeFileSync(assetPath, svgText);
    fs.writeFileSync(outsideAssetPath, svgText);

    const textSlotSchema = templateToolDefinitions.find((tool) => tool.name === 'create_text_slot');
    assert.ok(textSlotSchema, 'create_text_slot schema must exist');
    assert.deepEqual(textSlotSchema.inputSchema.required, ['role', 'slot', 'bounds', 'text']);
    assert.equal(textSlotSchema.inputSchema.anyOf.some((entry) => entry.required?.includes('derivativeId')), true);
    assert.equal(textSlotSchema.inputSchema.anyOf.some((entry) => entry.required?.includes('pageIndex')), true);
    assert.equal(templateToolDefinitions.find((tool) => tool.name === 'align_items').inputSchema.properties.alignTo.enum.includes('referenceObject'), true);
    assert.ok(templateToolDefinitions.find((tool) => tool.name === 'attach_template_workspace'));
    assert.ok(templateToolDefinitions.find((tool) => tool.name === 'resolve_derivative_page'));
    assert.ok(templateToolDefinitions.find((tool) => tool.name === 'verify_template_roundtrip'));
    assert.ok(templateToolDefinitions.find((tool) => tool.name === 'diagnose_visual_mismatch'));
    assert.ok(templateToolDefinitions.find((tool) => tool.name === 'set_item_layer'));
    assert.equal(templateToolDefinitions.find((tool) => tool.name === 'export_derivative_preview').inputSchema.properties.previewQuality.default, 'checkpoint');
    assert.equal(templateToolDefinitions.find((tool) => tool.name === 'export_page_preview').inputSchema.properties.previewQuality.default, 'checkpoint');
    assert.equal(templateToolDefinitions.find((tool) => tool.name === 'export_spread_preview').inputSchema.properties.previewQuality.default, 'checkpoint');
    assert.equal(templateToolDefinitions.find((tool) => tool.name === 'export_page_preview').inputSchema.properties.returnImage.default, true);
    assert.equal(templateToolDefinitions.find((tool) => tool.name === 'export_spread_preview').inputSchema.properties.returnImage.default, true);
    assert.equal(templateToolDefinitions.find((tool) => tool.name === 'return_preview_as_image').inputSchema.properties.returnImage.default, false);
    assert.match(String(templateToolDefinitions.find((tool) => tool.name === 'update_text_slot').inputSchema.properties.fit.description), /deprecated|reject/i);
    assert.match(String(templateToolDefinitions.find((tool) => tool.name === 'create_text_slot').inputSchema.properties.autoFit.description), /risky|avoid|instability/i);
    assert.equal(templateToolDefinitions.find((tool) => tool.name === 'duplicate_items_to_page').inputSchema.properties.textDuplicateMode.default, 'skip');
    const analyzeDesignSystemSchema = templateToolDefinitions.find((tool) => tool.name === 'analyze_design_system').inputSchema;
    assert.equal(analyzeDesignSystemSchema.properties.pageIndex.type, 'integer');
    assert.equal(analyzeDesignSystemSchema.properties.pageIndexes.type, 'array');
    assert.equal(analyzeDesignSystemSchema.properties.maxPages.default, 1);
    assert.equal(analyzeDesignSystemSchema.properties.maxItems.default, 100);
    assert.equal(analyzeDesignSystemSchema.properties.maxItems.maximum, 500);
    assert.equal(analyzeDesignSystemSchema.properties.detailLevel.default, 'summary');
    assert.equal(analyzeDesignSystemSchema.properties.includeHidden.default, false);
    assert.equal(analyzeDesignSystemSchema.properties.includeTextExcerpt.default, false);
    assert.equal(analyzeDesignSystemSchema.properties.includeImageMetadata.default, false);
    assert.equal(analyzeDesignSystemSchema.properties.includePathPoints.default, false);
    assert.equal(analyzeDesignSystemSchema.properties.includeTextMetadata.default, true);
    assert.equal(analyzeDesignSystemSchema.properties.includeSwatches.default, true);
    assert.equal(analyzeDesignSystemSchema.properties.includeStyles.default, true);
    assert.equal(analyzeDesignSystemSchema.properties.allowHeavyInspection.default, false);
    const visualReviewSchema = templateToolDefinitions.find((tool) => tool.name === 'record_visual_review').inputSchema;
    assert.ok(visualReviewSchema.properties.designQualityRubric);
    assert.ok(visualReviewSchema.properties.designQualityRubric.properties.categories.properties.productionRisk);
    assert.equal(visualReviewSchema.properties.designQualityRubric.properties.categories.required, undefined);
    const sourceEvidenceSchema = visualReviewSchema.properties.designQualityRubric.properties.sourceEvidence;
    for (const field of ['previewId', 'indesignPreviewId', 'targetPreviewId', 'inspectionId', 'pageIndex', 'sourceBasePreviewId']) {
        assert.equal(sourceEvidenceSchema.properties[field].type.includes('null'), true, `${field} must accept null`);
    }

    const categoryNames = [
        'hierarchy', 'alignment', 'spacing', 'typography', 'contrastColor', 'imageUse',
        'styleConsistency', 'editability', 'productionRisk'
    ];
    const passingCategory = (evidence) => ({
        rating: 'pass', severity: 'none', score: 3, evidence, affectedObjects: [],
        repairSuggestion: '', suggestedToolCalls: [], acceptanceImpact: 'none', blocksFinalization: false
    });

    const legacyReview = await TemplateHandlers.record_visual_review({
        derivativeId: 'derivative_001',
        brief: 'Legacy review',
        issues: [{ id: 'legacy-1' }, { id: 'legacy-2' }],
        suggestedFixes: [{ tool: 'set_bounds' }]
    });
    assert.equal(legacyReview.success, true);
    assert.equal(legacyReview.result.issues.length, 2);
    assert.equal(legacyReview.result.rubricCompleteness, 'none');
    assert.equal(loadWorkspace(workspaceRoot).derivatives.find((item) => item.derivativeId === 'derivative_001').outstandingIssueCount, 2);

    const nullableEvidence = {
        derivativeId: 'derivative_001',
        previewId: null,
        indesignPreviewId: null,
        targetPreviewId: null,
        inspectionId: null,
        pageIndex: null,
        sourceBasePreviewId: null,
        toolEvidence: []
    };
    const partialReview = await TemplateHandlers.record_visual_review({
        derivativeId: 'derivative_001',
        designQualityRubric: {
            sourceEvidence: nullableEvidence,
            categories: {
                hierarchy: passingCategory('Heading dominates.'),
                alignment: passingCategory('Primary edges align.')
            }
        }
    });
    assert.equal(partialReview.success, true);
    assert.deepEqual(partialReview.result.sourceEvidence, nullableEvidence);
    assert.equal(partialReview.result.rubricCompleteness, 'partial');
    assert.deepEqual(partialReview.result.presentCategories, ['hierarchy', 'alignment']);
    assert.deepEqual(partialReview.result.missingCategories, categoryNames.slice(2));
    assert.equal(Object.hasOwn(partialReview.result.designQualityRubric.categories, 'spacing'), false);

    const completeCategories = Object.fromEntries(categoryNames.map((name) => [name, passingCategory(`${name} evidence`)]));
    const completeRubric = {
        schemaVersion: '1.0',
        overallStatus: 'pass',
        confidence: 'high',
        summary: 'All rubric categories reviewed.',
        sourceEvidence: nullableEvidence,
        categories: completeCategories
    };
    const completeReview = await TemplateHandlers.record_visual_review({ derivativeId: 'derivative_001', designQualityRubric: completeRubric });
    assert.equal(completeReview.success, true);
    assert.equal(completeReview.result.rubricCompleteness, 'complete');
    assert.deepEqual(completeReview.result.missingCategories, []);
    let reviewedDerivative = loadWorkspace(workspaceRoot).derivatives.find((item) => item.derivativeId === 'derivative_001');
    assert.equal(reviewedDerivative.latestDesignRubricCompleteness, 'complete');
    assert.deepEqual(reviewedDerivative.latestDesignMissingCategories, []);

    const categoryBlockerReview = await TemplateHandlers.record_visual_review({
        derivativeId: 'derivative_001',
        designQualityRubric: {
            overallStatus: 'blocked',
            categories: {
                editability: {
                    rating: 'fail', severity: 'high', score: 0, evidence: 'Title is not live text.',
                    affectedObjects: [{ labelQuery: { slot: 'title' } }], repairSuggestion: 'Restore a live text slot.',
                    suggestedToolCalls: [], acceptanceImpact: 'editability', blocksFinalization: true
                }
            }
        }
    });
    assert.equal(categoryBlockerReview.success, true);
    reviewedDerivative = loadWorkspace(workspaceRoot).derivatives.find((item) => item.derivativeId === 'derivative_001');
    assert.equal(reviewedDerivative.unresolvedDesignBlockerCount, 1);
    assert.equal(reviewedDerivative.outstandingIssueCount, 1);

    const subjectiveReview = await TemplateHandlers.record_visual_review({
        derivativeId: 'derivative_001',
        designQualityRubric: {
            categories: {
                styleConsistency: {
                    rating: 'fail', severity: 'high', score: 0, evidence: 'Accent treatment is subjective.',
                    affectedObjects: [], repairSuggestion: 'Consider adjusting the accent.', suggestedToolCalls: [],
                    acceptanceImpact: 'visualQualityOnly', blocksFinalization: true
                }
            }
        }
    });
    assert.equal(subjectiveReview.success, true);
    reviewedDerivative = loadWorkspace(workspaceRoot).derivatives.find((item) => item.derivativeId === 'derivative_001');
    assert.equal(reviewedDerivative.unresolvedDesignBlockerCount, 0);
    assert.equal(reviewedDerivative.outstandingIssueCount, 0);

    const normalizedBlockerReview = await TemplateHandlers.record_visual_review({
        derivativeId: 'derivative_001',
        designQualityRubric: {
            categories: {
                productionRisk: {
                    rating: 'fail', severity: 'high', acceptanceImpact: 'productionSafety', blocksFinalization: true
                }
            },
            blockers: [
                { id: 'production-open', category: 'productionRisk', status: 'open' },
                { id: 'production-resolved', category: 'productionRisk', status: 'resolved' }
            ],
            highSeverityIssues: [
                { id: 'editability-open', category: 'editability', acceptanceImpact: 'editability', resolved: false },
                { id: 'subjective-open', category: 'styleConsistency', acceptanceImpact: 'visualQualityOnly', resolved: false }
            ]
        }
    });
    assert.equal(normalizedBlockerReview.success, true);
    reviewedDerivative = loadWorkspace(workspaceRoot).derivatives.find((item) => item.derivativeId === 'derivative_001');
    assert.equal(reviewedDerivative.unresolvedDesignBlockerCount, 2);
    assert.equal(reviewedDerivative.outstandingIssueCount, 2);

    const aliasCategories = { hierarchy: passingCategory('Alias hierarchy evidence.') };
    const aliasReview = await TemplateHandlers.record_visual_review({ derivativeId: 'derivative_001', categoryRatings: aliasCategories });
    assert.equal(aliasReview.success, true);
    assert.deepEqual(aliasReview.result.designQualityRubric.categories, aliasCategories);
    assert.deepEqual(aliasReview.result.categoryRatings, aliasCategories);

    const nestedCategories = { spacing: passingCategory('Nested spacing evidence.') };
    const divergentReview = await TemplateHandlers.record_visual_review({
        derivativeId: 'derivative_001',
        designQualityRubric: { categories: nestedCategories },
        categoryRatings: aliasCategories
    });
    assert.equal(divergentReview.success, true);
    assert.deepEqual(divergentReview.result.designQualityRubric.categories, nestedCategories);
    assert.deepEqual(divergentReview.result.categoryRatings, nestedCategories);
    assert.equal(divergentReview.result.schemaWarnings.some((warning) => /differed from categoryRatings/i.test(warning)), true);

    const listedReviews = await TemplateHandlers.list_visual_reviews({ derivativeId: 'derivative_001' });
    assert.equal(listedReviews.success, true);
    assert.equal(listedReviews.result.length, 8);
    assert.equal(listedReviews.result[0].issues.length, 2);
    assert.equal(listedReviews.result.at(-1).rubricCompleteness, 'partial');

    assert.deepEqual(resolvePreviewExportSettings({}), { previewQuality: 'checkpoint', resolution: 48 });
    assert.deepEqual(resolvePreviewExportSettings({ previewQuality: 'review' }), { previewQuality: 'review', resolution: 96 });
    assert.deepEqual(resolvePreviewExportSettings({ previewQuality: 'final' }), { previewQuality: 'final', resolution: 150 });
    assert.deepEqual(resolvePreviewExportSettings({ previewQuality: 'final', resolution: 72 }), { previewQuality: 'final', resolution: 72 });
    assert.ok(templateHandlerSource.includes('const maxPointSize = Number(args.maxPointSize ?? (before.pointSize || 72));'));
    assert.ok(!templateHandlerSource.includes('const maxPointSize = Number(args.maxPointSize ?? before.pointSize || 72);'));
    assert.ok(templateHandlerSource.includes('let cleanArgs = trace ? { ...args } : args;'));
    assert.ok(!templateHandlerSource.includes('const cleanArgs = trace ? { ...args } : args;'));

    delete process.env.INDESIGN_TOOL_PROFILE;
    const defaultProfileTools = getToolDefinitionsForProfile().map((tool) => tool.name);
    assert.equal(defaultProfileTools.includes('open_document'), false);
    assert.equal(defaultProfileTools.includes('save_document'), false);
    assert.equal(defaultProfileTools.includes('attach_template_workspace'), true);

    delete process.env.ALLOW_EXECUTE_INDESIGN_CODE;
    const denied = await UtilityHandlers.executeInDesignCode({
        code: 'return { success:true }',
        dangerousConfirmation: 'I understand this executes arbitrary InDesign code'
    });
    assert.equal(denied.success, false);
    assert.match(String(denied.result), /disabled by default/);

    const server = new InDesignMCPServer();
    const attach = await server.handleToolCall('attach_template_workspace', { workspaceRoot });
    assert.equal(attach.success, true);
    assert.equal(attach.workspaceRoot || attach.result?.workspaceRoot, workspaceRoot);

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

    let executeCalls = 0;
    TemplateHandlers.ensureTemplateReady = async () => ({ success: true });
    ScriptExecutor.executeViaUXP = async () => {
        executeCalls += 1;
        return { success: true };
    };
    const rejectedFit = await TemplateHandlers.update_text_slot({ objectId: 123, text: 'mutate me', fit: true });
    assert.equal(rejectedFit.success, false);
    assert.match(String(rejectedFit.result), /no longer supports fit=true/);
    assert.equal(executeCalls, 0);

    TemplateHandlers.ensureTemplateReady = async () => ({ success: true });
    ScriptExecutor.executeViaUXP = async () => {
        throw new Error('executeViaUXP should not be called for rejected image paths');
    };
    await assert.rejects(
        Promise.resolve().then(() => TemplateHandlers.uxpTool('create_image_frame', {
            pageIndex: 1,
            bounds: [0, 0, 40, 40],
            unit: 'pt',
            imagePath: outsideAssetPath,
            name: 'unit__icon__image_frame',
            label: { derivativeId: 'derivative_001', role: 'icon', slot: 'unit' }
        })),
        /Path must stay inside workspaceRoot|inside workspace assets|inside workspace input/
    );
    await assert.rejects(
        Promise.resolve().then(() => TemplateHandlers.uxpTool('create_image_frame', {
            pageIndex: 1,
            bounds: [0, 0, 40, 40],
            unit: 'pt',
            filePath: original,
            name: 'unit__icon__image_frame',
            label: { derivativeId: 'derivative_001', role: 'icon', slot: 'unit' }
        })),
        /Refusing to write\/read original source path|inside workspaceRoot/
    );
    assert.equal(executeCalls, 0);

    let capturedScript = '';
    TemplateHandlers.ensureTemplateReady = async () => ({ success: true });
    ScriptExecutor.executeViaUXP = async (script) => {
        capturedScript = script;
        executeCalls += 1;
        return {
            success: true,
            objectId: 999,
            name: 'unit__icon__image_frame',
            bounds: [0, 0, 40, 40],
            pageIndex: 1,
            hasPlacedGraphic: true,
            link: { path: assetPath, status: 'normal' },
            warnings: []
        };
    };

    const rawFrame = await TemplateHandlers.uxpTool('create_image_frame', {
        pageIndex: 1,
        bounds: [0, 0, 40, 40],
        unit: 'pt',
        imagePath: assetPath,
        name: 'unit__icon__image_frame',
        label: { derivativeId: 'derivative_001', role: 'icon', slot: 'unit' }
    });
    assert.equal(rawFrame.success, true);
    assert.equal(rawFrame.objectId, 999);
    assert.equal(executeCalls, 1);
    assert.match(capturedScript, /create_image_frame/);
    assert.match(capturedScript, /imagePath/);
    assert.doesNotMatch(capturedScript, /Assignment to constant variable/);

    TemplateHandlers.resolveDerivativeTarget = async () => ({
        success: true,
        derivativeId: 'derivative_001',
        pageIndex: 1,
        pageId: 12345,
        resolvedBy: 'pageId',
        warnings: []
    });
    ScriptExecutor.executeViaUXP = async () => ({
        success: true,
        objectId: 999,
        name: 'unit__icon__image_frame',
        bounds: [0, 0, 40, 40],
        pageIndex: 1,
        hasPlacedGraphic: true,
        link: { path: assetPath, status: 'normal' },
        warnings: []
    });

    const slotResult = await TemplateHandlers.create_image_slot({
        derivativeId: 'derivative_001',
        role: 'icon',
        slot: 'unit',
        bounds: [0, 0, 40, 40],
        imagePath: assetPath
    });
    assert.equal(slotResult.success, true);
    assert.equal(slotResult.result.objectId, 999);
    assert.equal(slotResult.result.derivativeId, 'derivative_001');
    assert.equal(slotResult.result.pageIndex, 1);
    assert.equal(slotResult.result.pageId, 12345);
    assert.equal(slotResult.result.resolvedBy, 'pageId');
    assert.deepEqual(slotResult.result.warnings, []);
    assert.equal(slotResult.result.hasPlacedGraphic, true);
    assert.equal(slotResult.result.link.path, assetPath);
    assert.equal(slotResult.result.link.status, 'normal');
    assert.equal(slotResult.result.warnings.some((warning) => /Assignment to constant variable/i.test(String(warning))), false);

    const analyzeCallLog = [];
    const analyzePageItems = {
        0: [
            {
                objectId: 11,
                name: 'headline',
                type: 'TextFrame',
                pageIndex: 0,
                bounds: [12, 18, 42, 198],
                geometricBounds: [12, 18, 42, 198],
                visible: true,
                locked: false,
                label: { role: 'title', editable: true, motifId: 'motif-title', source: 'base' },
                text: { overset: false, fontFamily: 'Inter', fontStyle: 'Bold', pointSize: 32, paragraphStyle: 'Headline', characterStyle: 'Headline Char' },
                image: null,
                fillColor: { name: 'None' },
                strokeColor: { name: 'None' },
                strokeWeight: 0
            },
            {
                objectId: 12,
                name: 'subhead',
                type: 'TextFrame',
                pageIndex: 0,
                bounds: [50, 18, 70, 180],
                geometricBounds: [50, 18, 70, 180],
                visible: true,
                locked: false,
                label: { role: 'subtitle', editable: true },
                text: { overset: false, fontFamily: 'Inter', fontStyle: 'Medium', pointSize: 18, paragraphStyle: 'Subhead', characterStyle: 'Subhead Char' },
                image: null,
                fillColor: { name: 'None' },
                strokeColor: { name: 'None' },
                strokeWeight: 0
            },
            {
                objectId: 13,
                name: 'body',
                type: 'TextFrame',
                pageIndex: 0,
                bounds: [78, 18, 140, 180],
                geometricBounds: [78, 18, 140, 180],
                visible: true,
                locked: false,
                label: { role: 'body', editable: true },
                text: { overset: false, fontFamily: 'Inter', fontStyle: 'Regular', pointSize: 11, paragraphStyle: 'Body', characterStyle: 'Body Char' },
                image: null,
                fillColor: { name: 'None' },
                strokeColor: { name: 'None' },
                strokeWeight: 0
            },
            {
                objectId: 14,
                name: 'hero',
                type: 'Rectangle',
                pageIndex: 0,
                bounds: [22, 198, 120, 320],
                geometricBounds: [22, 198, 120, 320],
                visible: true,
                locked: false,
                label: { role: 'hero', editable: false },
                text: null,
                image: { hasPlacedGraphic: true, linkName: 'hero.jpg', linkPath: '/workspace/assets/hero.jpg', linkStatus: 'Normal', effectivePpi: { x: 300, y: 300 }, actualPpi: { x: 300, y: 300 } },
                fillColor: { name: 'Paper' },
                strokeColor: { name: 'None' },
                strokeWeight: 0
            }
        ],
        1: [
            {
                objectId: 21,
                name: 'support',
                type: 'TextFrame',
                pageIndex: 1,
                bounds: [18, 18, 50, 170],
                geometricBounds: [18, 18, 50, 170],
                visible: true,
                locked: false,
                label: { role: 'supporting', editable: true },
                text: { overset: false, fontFamily: 'Inter', fontStyle: 'Regular', pointSize: 11, paragraphStyle: 'Body', characterStyle: 'Body Char' },
                image: null,
                fillColor: { name: 'None' },
                strokeColor: { name: 'None' },
                strokeWeight: 0
            },
            {
                objectId: 22,
                name: 'accent-line',
                type: 'Line',
                pageIndex: 1,
                bounds: [60, 20, 61, 200],
                geometricBounds: [60, 20, 61, 200],
                visible: true,
                locked: false,
                label: { role: 'divider', editable: true, motifId: 'divider-1', source: 'base' },
                text: null,
                image: null,
                fillColor: { name: 'None' },
                strokeColor: { name: 'Accent Blue' },
                strokeWeight: 2
            }
        ],
        2: [
            {
                objectId: 31,
                name: 'caption',
                type: 'TextFrame',
                pageIndex: 2,
                bounds: [16, 18, 30, 120],
                geometricBounds: [16, 18, 30, 120],
                visible: true,
                locked: false,
                label: { role: 'caption', editable: true },
                text: { overset: false, fontFamily: 'Inter', fontStyle: 'Regular', pointSize: 8, paragraphStyle: 'Caption', characterStyle: 'Caption Char' },
                image: null,
                fillColor: { name: 'None' },
                strokeColor: { name: 'None' },
                strokeWeight: 0
            }
        ]
    };
    TemplateHandlers.uxpTool = async (name, args = {}) => {
        analyzeCallLog.push({ name, args: JSON.parse(JSON.stringify(args)) });
        if (name === 'inspect_document_bundle') {
            return {
                success: true,
                pages: [
                    { index: 0, bounds: [0, 0, 200, 320], marginPreferences: { top: 12, left: 18, bottom: 18, right: 18 } },
                    { index: 1, bounds: [0, 0, 200, 320], marginPreferences: { top: 10, left: 20, bottom: 20, right: 20 } },
                    { index: 2, bounds: [0, 0, 200, 320], marginPreferences: { top: 14, left: 16, bottom: 16, right: 16 } }
                ],
                swatches: [
                    { name: 'Paper' },
                    { name: 'Accent Blue' },
                    { name: 'Black' }
                ],
                styles: {
                    paragraph: [
                        { name: 'Headline', fillColor: { name: 'Paper' } },
                        { name: 'Subhead', fillColor: { name: 'Accent Blue' } },
                        { name: 'Body', fillColor: { name: 'Black' } },
                        { name: 'Caption', fillColor: { name: 'Black' } }
                    ],
                    character: [
                        { name: 'Headline Char', fillColor: { name: 'Paper' } },
                        { name: 'Subhead Char', fillColor: { name: 'Accent Blue' } },
                        { name: 'Body Char', fillColor: { name: 'Black' } },
                        { name: 'Caption Char', fillColor: { name: 'Black' } }
                    ],
                    object: []
                },
                layers: [
                    { name: 'AGENT_WORK' },
                    { name: 'BASE' }
                ],
                fonts: [
                    { name: 'Inter\tRegular', fontFamily: 'Inter', fontStyle: 'Regular', status: 'normal' },
                    { name: 'Inter\tBold', fontFamily: 'Inter', fontStyle: 'Bold', status: 'normal' }
                ],
                warnings: []
            };
        }
        if (name === 'inspect_page_items_v2') {
            const items = analyzePageItems[args.pageIndex] || [];
            const limit = args.limit ?? 500;
            const sliced = items.slice(0, limit);
            return {
                success: true,
                items: sliced,
                pagination: {
                    totalMatched: items.length,
                    returned: sliced.length,
                    offset: 0,
                    limit,
                    hasMore: items.length > sliced.length
                },
                warnings: []
            };
        }
        throw new Error(`Unexpected tool call: ${name}`);
    };
    TemplateHandlers.inspect_layout_grid = async (gridArgs = {}) => {
        analyzeCallLog.push({ name: 'inspect_layout_grid', args: JSON.parse(JSON.stringify(gridArgs)) });
        return {
            success: true,
            source: 'derived_from_page_item_bounds',
            pageIndex: gridArgs.pageIndex ?? 0,
            margins: { top: 12, left: 18, bottom: 18, right: 18 },
            commonX: [18, 198],
            commonY: [12, 50, 78, 120],
            commonWidths: [162, 180],
            commonHeights: [14, 20, 30, 62, 98],
            spacingRhythm: [8, 10, 18, 20],
            likelyGrid: { columns: 2, rows: 3, confidence: 0.7, evidenceObjectIds: [11, 12, 13, 14] },
            warnings: ['Heuristic only; derived from page item bounds, not native grid metadata']
        };
    };

    const defaultAnalysis = await TemplateHandlers.analyze_design_system({
        pageIndex: 0,
        includeGrid: true,
        includeItems: false,
        limit: 4
    });
    assert.equal(defaultAnalysis.success, true);
    assert.equal(defaultAnalysis.result.source, 'heuristic_bounded_design_system_analysis');
    assert.equal(defaultAnalysis.result.pageScope.requestedPageIndex, 0);
    assert.deepEqual(defaultAnalysis.result.pageScope.requestedPageIndexes, [0]);
    assert.deepEqual(defaultAnalysis.result.pageScope.analyzedPageIndexes, [0]);
    assert.equal(defaultAnalysis.result.pageScope.defaultedPageIndex, false);
    assert.equal(defaultAnalysis.result.pageScope.allowHeavyInspection, false);
    assert.equal(defaultAnalysis.result.limits.maxPages, 1);
    assert.equal(defaultAnalysis.result.limits.maxItems, 4);
    assert.equal(defaultAnalysis.result.limits.detailLevel, 'standard');
    assert.equal(defaultAnalysis.result.limits.includeHidden, false);
    assert.equal(defaultAnalysis.result.limits.includeTextExcerpt, false);
    assert.equal(defaultAnalysis.result.limits.includeImageMetadata, false);
    assert.equal(defaultAnalysis.result.limits.includePathPoints, false);
    assert.equal(defaultAnalysis.result.limits.includeTextMetadata, true);
    assert.equal(defaultAnalysis.result.truncated, false);
    assert.match(defaultAnalysis.result.confidence, /^(low|medium|high)$/);
    assert.ok(defaultAnalysis.result.signals.typeScale.length >= 3);
    assert.ok(defaultAnalysis.result.signals.fontUsage.families.length >= 1);
    assert.ok(defaultAnalysis.result.signals.colorRoles.length >= 1);
    assert.ok(defaultAnalysis.result.signals.spacingScale.commonGaps.length >= 1);
    assert.ok(defaultAnalysis.result.signals.marginHints.length >= 1);
    assert.ok(defaultAnalysis.result.signals.gridHints.length >= 1);
    assert.ok(defaultAnalysis.result.signals.motifCandidates.length >= 1);
    assert.ok(defaultAnalysis.result.signals.imageRoles.length >= 1);
    assert.ok(defaultAnalysis.result.provenance.sourcePages.includes(0));
    assert.equal(defaultAnalysis.result.provenance.bundleIncluded, true);
    assert.equal(defaultAnalysis.result.provenance.gridIncluded, true);
    assert.equal(defaultAnalysis.result.provenance.swatchesIncluded, true);
    assert.equal(defaultAnalysis.result.provenance.stylesIncluded, true);
    assert.equal(defaultAnalysis.result.items, undefined);
    assert.equal(Array.isArray(defaultAnalysis.result.itemEvidenceSample), true);
    assert.equal(defaultAnalysis.result.itemEvidenceSample.length, 0);

    const bundleCall = analyzeCallLog.find((entry) => entry.name === 'inspect_document_bundle');
    const itemCall = analyzeCallLog.find((entry) => entry.name === 'inspect_page_items_v2');
    const gridCall = analyzeCallLog.find((entry) => entry.name === 'inspect_layout_grid');
    assert.ok(bundleCall);
    assert.ok(itemCall);
    assert.ok(gridCall);
    assert.equal(bundleCall.args.includePageItems, false);
    assert.equal(bundleCall.args.includeParentPageItems, false);
    assert.equal(bundleCall.args.includeTextExcerpt, false);
    assert.equal(bundleCall.args.includeStyles, true);
    assert.equal(bundleCall.args.includeSwatches, true);
    assert.equal(itemCall.args.pageIndex, 0);
    assert.equal(itemCall.args.includeHidden, false);
    assert.equal(itemCall.args.includeParentItems, false);
    assert.equal(itemCall.args.limit, 4);
    assert.equal(itemCall.args.offset, 0);
    assert.equal(itemCall.args.includeImageMetadata, false);
    assert.equal(itemCall.args.includeTextMetadata, true);
    assert.equal(itemCall.args.includeTextExcerpt, false);
    assert.equal(itemCall.args.includePathPoints, false);
    assert.equal(itemCall.args.detailLevel, 'standard');
    assert.equal(gridCall.args.pageIndex, 0);
    assert.equal(gridCall.args.includeHidden, false);
    assert.equal(gridCall.args.limit, 4);

    analyzeCallLog.length = 0;
    const sampledAnalysis = await TemplateHandlers.analyze_design_system({
        pageIndex: 0,
        includeItems: true,
        includeGrid: false,
        limit: 4
    });
    assert.equal(sampledAnalysis.success, true);
    assert.ok(sampledAnalysis.result.itemEvidenceSample.length > 0);
    assert.ok(sampledAnalysis.result.itemEvidenceSample.length <= 16);
    assert.equal(sampledAnalysis.result.itemEvidenceSample[0].text?.excerpt, undefined);
    assert.equal(sampledAnalysis.result.items, undefined);

    const multiPageRefusal = await TemplateHandlers.analyze_design_system({
        pageIndexes: [0, 1]
    });
    assert.equal(multiPageRefusal.success, false);
    assert.match(String(multiPageRefusal.result), /allowHeavyInspection=true/);

    const heavyAnalysis = await TemplateHandlers.analyze_design_system({
        pageIndexes: [0, 1, 2],
        allowHeavyInspection: true,
        maxPages: 2,
        maxItems: 3,
        includeGrid: false
    });
    assert.equal(heavyAnalysis.success, true);
    assert.deepEqual(heavyAnalysis.result.pageScope.analyzedPageIndexes, [0, 1]);
    assert.equal(heavyAnalysis.result.truncated, true);
    assert.equal(heavyAnalysis.result.provenance.truncated, true);
    assert.equal(heavyAnalysis.result.limits.maxPages, 2);
    assert.equal(heavyAnalysis.result.limits.maxItems, 3);
    assert.equal(heavyAnalysis.result.provenance.limitsApplied.perPageBudgets.length, 2);
    assert.equal(heavyAnalysis.result.provenance.limitsApplied.perPageBudgets[0], 2);
    assert.equal(heavyAnalysis.result.provenance.limitsApplied.perPageBudgets[1], 1);

    const cappedItems = await TemplateHandlers.analyze_design_system({
        pageIndex: 0,
        maxItems: 999,
        includeGrid: false
    });
    assert.equal(cappedItems.success, true);
    assert.equal(cappedItems.result.limits.maxItems, 500);

    const pathPointsRefusal = await TemplateHandlers.analyze_design_system({
        pageIndex: 0,
        includePathPoints: true
    });
    assert.equal(pathPointsRefusal.success, false);
    assert.match(String(pathPointsRefusal.result), /includePathPoints requires allowHeavyInspection=true/);

    console.log('Template unit tests passed');
} finally {
    TemplateHandlers.ensureTemplateReady = originalEnsureTemplateReady;
    TemplateHandlers.resolveDerivativeTarget = originalResolveDerivativeTarget;
    ScriptExecutor.executeViaUXP = originalExecuteViaUXP;
    TemplateHandlers.inspect_layout_grid = originalInspectLayoutGrid;
    TemplateHandlers.uxpTool = originalUxpTool;
    clearActiveWorkspace();
    if (priorActiveState) fs.writeFileSync(activeStatePath, priorActiveState);
    else fs.rmSync(activeStatePath, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
}
