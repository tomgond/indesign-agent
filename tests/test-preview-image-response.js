import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { formatResponse } from '../src/utils/stringUtils.js';
import { formatMcpContent } from '../src/core/InDesignMCPServer.js';
import { ScreenshotHandlers } from '../src/handlers/screenshotHandlers.js';
import { TemplateHandlers, normalizePreviewOutputName, resolvePreviewExportSettings } from '../src/handlers/templateHandlers.js';
import { PageHandlers } from '../src/handlers/pageHandlers.js';
import { DocumentHandlers } from '../src/handlers/documentHandlers.js';
import { ScriptExecutor } from '../src/core/scriptExecutor.js';
import { initWorkspace, loadWorkspace, saveWorkspace, clearActiveWorkspace } from '../src/core/workspaceState.js';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3+J0cAAAAASUVORK5CYII=';

function writePng(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(PNG_BASE64, 'base64'));
}

function assertTextOnly(content) {
    assert.equal(content.length, 1);
    assert.equal(content[0].type, 'text');
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'indesign-preview-response-'));
const original = path.join(root, 'base.indd');
const workspaceRoot = path.join(root, 'workspace');
fs.writeFileSync(original, 'fake-indd');

const originalCaptureOSScreen = ScreenshotHandlers.captureOSScreen;
const originalCaptureScreenPreview = ScreenshotHandlers.captureScreenPreview;
const originalNavigateToPage = PageHandlers.navigateToPage;
const originalZoomToPage = DocumentHandlers.zoomToPage;
const originalExecuteViaUXP = ScriptExecutor.executeViaUXP;
const originalEnsureTemplateReady = TemplateHandlers.ensureTemplateReady;
const originalResolveDerivativePage = TemplateHandlers.resolve_derivative_page;

try {
    const manifest = initWorkspace({
        originalSourcePath: original,
        workspaceRoot,
        overwriteExistingWorkspace: true
    });
    manifest.derivatives = [
        {
            derivativeId: 'invite_poster_a4',
            pageIndex: 8,
            previewIds: [],
            latestPreviewId: null,
            createdAt: new Date().toISOString()
        }
    ];
    saveWorkspace(manifest);

    // formatMcpContent
    {
        const imageResponse = formatResponse({
            success: true,
            previewId: 'preview_001',
            path: '/workspace/previews/preview_001.png',
            mcpImage: { mimeType: 'image/png', data: PNG_BASE64 }
        }, 'Preview');
        const imageContent = formatMcpContent(imageResponse);
        assert.equal(imageContent[0].type, 'image');
        assert.equal(imageContent[0].mimeType, 'image/png');
        assert.equal(imageContent[1].type, 'text');
        assert.ok(!imageContent[1].text.includes('mcpImage'));
        assert.ok(!imageContent[1].text.includes(PNG_BASE64.slice(0, 16)));

        const textContent = formatMcpContent(formatResponse({ ok: true }, 'Plain'));
        assertTextOnly(textContent);
        assert.ok(textContent[0].text.includes('"ok": true'));
    }

    // Screenshot handlers default to MCP images
    {
        const outputPath = path.join(root, 'screen-preview.png');
        ScreenshotHandlers.captureOSScreen = async (filePath) => writePng(filePath);

        const response = await ScreenshotHandlers.captureScreenPreview({ outputPath, delayMs: 0 });
        const content = formatMcpContent(response);
        assert.equal(content[0].type, 'image');
        assert.equal(content[0].mimeType, 'image/png');
        assert.equal(content.length, 2);
        assert.ok(response.result.mcpImage);
        assert.ok(!content[1].text.includes('"mcpImage"'));
        assert.ok(!content[1].text.includes(PNG_BASE64.slice(0, 16)));

        const metadataOnly = await ScreenshotHandlers.captureScreenPreview({ outputPath: path.join(root, 'screen-preview-no-image.png'), delayMs: 0, returnImage: false });
        const metadataOnlyContent = formatMcpContent(metadataOnly);
        assertTextOnly(metadataOnlyContent);
        assert.ok(!metadataOnly.result.mcpImage);
    }

    // capture_indesign_screen_preview passes returnImage through
    {
        let captureArgs = null;
        PageHandlers.navigateToPage = async () => ({ success: true });
        DocumentHandlers.zoomToPage = async () => ({ success: true });
        ScreenshotHandlers.captureScreenPreview = async (args) => {
            captureArgs = args;
            return formatResponse({ success: true, path: args.outputPath }, 'Capture Screen Preview');
        };

        const response = await ScreenshotHandlers.captureInDesignScreenPreview({
            outputPath: path.join(root, 'in-design-screen-preview.png'),
            pageIndex: 0,
            zoomMode: 'none',
            delayMs: 0,
            returnImage: false
        });
        assert.equal(response.success, true);
        assert.equal(captureArgs.returnImage, false);
    }

    // normalizePreviewOutputName
    {
        assert.equal(normalizePreviewOutputName('x', 'png', 'fallback'), 'x.png');
        assert.equal(normalizePreviewOutputName('x.png', 'png', 'fallback'), 'x.png');
        assert.throws(() => normalizePreviewOutputName('x.jpg', 'png', 'fallback'), /does not match format png/);
        assert.throws(() => normalizePreviewOutputName('../x', 'png', 'fallback'), /basename inside the workspace/);
    }

    // Preview export normalization and registry wiring
    {
        ScreenshotHandlers.captureOSScreen = originalCaptureOSScreen;
        ScreenshotHandlers.captureScreenPreview = originalCaptureScreenPreview;
        PageHandlers.navigateToPage = originalNavigateToPage;
        DocumentHandlers.zoomToPage = originalZoomToPage;

        TemplateHandlers.ensureTemplateReady = async () => ({ success: true });
        TemplateHandlers.resolve_derivative_page = async () => ({
            success: true,
            pageIndex: 8,
            pageId: 108,
            spreadIndex: 2,
            pageName: 'Page 9',
            pageBounds: [0, 0, 100, 100],
            pageSize: { width: 100, height: 100, unit: 'pt' },
            resolvedBy: 'test',
            warnings: []
        });
        const seenResolutions = [];
        ScriptExecutor.executeViaUXP = async (code) => {
            const match = code.match(/const out = (".*?");/s);
            assert.ok(match, 'expected export code to contain an output path');
            const out = Function(`return (${match[1]});`)();
            const resolutionMatch = code.match(/const resolution = (\d+);/);
            assert.ok(resolutionMatch, 'expected export code to contain a resolution');
            seenResolutions.push(Number(resolutionMatch[1]));
            writePng(out);
            return { success: true, path: out };
        };

        const pagePreview = await TemplateHandlers.export_page_preview({
            pageIndex: 0,
            outputName: 'invite-poster-a4-manual',
            format: 'png',
            overwrite: true
        });
        assert.equal(pagePreview.success, true);
        assert.ok(pagePreview.result.path.endsWith(`${path.sep}previews${path.sep}invite-poster-a4-manual.png`));
        assert.ok(pagePreview.result.mcpImage);
        assert.equal(pagePreview.result.previewQuality, 'checkpoint');
        assert.equal(pagePreview.result.resolution, 48);

        const pagePreviewExact = await TemplateHandlers.export_page_preview({
            pageIndex: 0,
            outputName: 'invite-poster-a4-manual.png',
            format: 'png',
            previewQuality: 'review',
            overwrite: true
        });
        assert.equal(pagePreviewExact.success, true);
        assert.ok(pagePreviewExact.result.path.endsWith('invite-poster-a4-manual.png'));
        assert.equal(pagePreviewExact.result.previewQuality, 'review');
        assert.equal(pagePreviewExact.result.resolution, 96);

        const mismatch = await TemplateHandlers.export_page_preview({
            pageIndex: 0,
            outputName: 'invite-poster-a4-manual.jpg',
            format: 'png',
            overwrite: true
        });
        assert.equal(mismatch.success, false);
        assert.match(mismatch.result, /does not match format png/);

        const derivativePreview = await TemplateHandlers.export_derivative_preview({
            derivativeId: 'invite_poster_a4',
            pageIndex: 8,
            format: 'png',
            overwrite: true
        });
        assert.equal(derivativePreview.success, true);
        assert.equal(derivativePreview.result.previewId, 'preview_invite_poster_a4_001');
        assert.ok(derivativePreview.result.path.endsWith(`${path.sep}previews${path.sep}invite_poster_a4__8__preview_001.png`));
        assert.ok(derivativePreview.result.mcpImage);
        assert.equal(derivativePreview.result.previewQuality, 'checkpoint');
        assert.equal(derivativePreview.result.resolution, 48);

        const updatedManifest = loadWorkspace();
        const storedPreview = updatedManifest.previews.find((preview) => preview.previewId === 'preview_invite_poster_a4_001');
        assert.ok(storedPreview);
        assert.ok(!('mcpImage' in storedPreview));
        assert.equal(storedPreview.previewQuality, 'checkpoint');
        assert.equal(storedPreview.resolution, 48);
        const derivativeRecord = updatedManifest.derivatives.find((item) => item.derivativeId === 'invite_poster_a4');
        assert.equal(derivativeRecord.latestPreviewId, 'preview_invite_poster_a4_001');
        assert.ok(derivativeRecord.previewIds.includes('preview_invite_poster_a4_001'));

        const resolvedPreview = await TemplateHandlers.return_preview_as_image({
            previewId: 'preview_invite_poster_a4_001'
        });
        assert.equal(resolvedPreview.success, true);
        assert.equal(resolvedPreview.result.previewId, 'preview_invite_poster_a4_001');
        assert.equal(resolvedPreview.result.path, derivativePreview.result.path);
        assert.ok(resolvedPreview.result.mcpImage);
        assert.ok(!('dataBase64' in resolvedPreview.result));

        const resolvedContent = formatMcpContent(resolvedPreview);
        assert.equal(resolvedContent[0].type, 'image');
        assert.equal(resolvedContent[0].mimeType, 'image/png');
        assert.equal(resolvedContent[1].type, 'text');
        assert.ok(!resolvedContent[1].text.includes('"mcpImage"'));
        assert.ok(!resolvedContent[1].text.includes(PNG_BASE64.slice(0, 16)));

        fs.rmSync(derivativePreview.result.path);
        const missingFile = await TemplateHandlers.return_preview_as_image({
            previewId: 'preview_invite_poster_a4_001'
        });
        assert.equal(missingFile.success, false);
        assert.match(missingFile.result, /previewId preview_invite_poster_a4_001/);
        assert.match(missingFile.result, new RegExp(derivativePreview.result.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        writePng(derivativePreview.result.path);

        const legacy = await TemplateHandlers.return_preview_as_image({
            previewId: 'preview_invite_poster_a4_001',
            legacyDataBase64: true,
            returnImage: false
        });
        assert.ok(!legacy.result.mcpImage);
        assert.ok(legacy.result.dataBase64);

        const tooLarge = await TemplateHandlers.return_preview_as_image({
            previewId: 'preview_invite_poster_a4_001',
            maxInlineBytes: 1
        });
        assert.equal(tooLarge.success, false);
        assert.match(String(tooLarge.result), /maxInlineBytes/);
        assert.deepEqual(seenResolutions, [48, 96, 48]);
    }

    {
        assert.deepEqual(resolvePreviewExportSettings({}), { previewQuality: 'checkpoint', resolution: 48 });
        assert.deepEqual(resolvePreviewExportSettings({ previewQuality: 'review' }), { previewQuality: 'review', resolution: 96 });
        assert.deepEqual(resolvePreviewExportSettings({ previewQuality: 'final' }), { previewQuality: 'final', resolution: 150 });
        assert.deepEqual(resolvePreviewExportSettings({ previewQuality: 'checkpoint', resolution: 110 }), { previewQuality: 'checkpoint', resolution: 110 });
    }

    console.log('Preview image response tests passed');
} finally {
    ScreenshotHandlers.captureOSScreen = originalCaptureOSScreen;
    ScreenshotHandlers.captureScreenPreview = originalCaptureScreenPreview;
    PageHandlers.navigateToPage = originalNavigateToPage;
    DocumentHandlers.zoomToPage = originalZoomToPage;
    ScriptExecutor.executeViaUXP = originalExecuteViaUXP;
    TemplateHandlers.ensureTemplateReady = originalEnsureTemplateReady;
    TemplateHandlers.resolve_derivative_page = originalResolveDerivativePage;
    clearActiveWorkspace();
    fs.rmSync(root, { recursive: true, force: true });
}
