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

    console.log('Template unit tests passed');
} finally {
    TemplateHandlers.ensureTemplateReady = originalEnsureTemplateReady;
    TemplateHandlers.resolveDerivativeTarget = originalResolveDerivativeTarget;
    ScriptExecutor.executeViaUXP = originalExecuteViaUXP;
    clearActiveWorkspace();
    if (priorActiveState) fs.writeFileSync(activeStatePath, priorActiveState);
    else fs.rmSync(activeStatePath, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
}
