import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { InDesignMCPServer } from '../src/core/InDesignMCPServer.js';

function firstImageFile(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const nested = firstImageFile(full);
            if (nested) return nested;
        } else if (/\.(png|jpe?g|tif|tiff)$/i.test(entry.name)) {
            return full;
        }
    }
    return null;
}

async function call(server, name, args = {}) {
    const result = await server.handleToolCall(name, args);
    assert.equal(result.success, true, `${name} failed: ${JSON.stringify(result)}`);
    return result;
}

export async function runTemplateMvpFlow({ fixtureInddPath, workspaceRoot, assetsDir }) {
    assert.ok(fixtureInddPath, 'fixtureInddPath is required');
    assert.ok(fs.existsSync(fixtureInddPath), 'fixtureInddPath must exist');

    const server = new InDesignMCPServer();
    const workspaceAssetDir = path.join(workspaceRoot, 'assets');
    const sourceImage = assetsDir ? firstImageFile(assetsDir) : null;

    await call(server, 'init_template_workspace', { originalInddPath: fixtureInddPath, workspaceRoot, overwriteExistingWorkspace: true });
    if (sourceImage) {
        fs.mkdirSync(workspaceAssetDir, { recursive: true });
        fs.copyFileSync(sourceImage, path.join(workspaceAssetDir, path.basename(sourceImage)));
    }

    await call(server, 'open_working_copy');
    await call(server, 'inspect_document_bundle');
    await call(server, 'inspect_page_items_v2', { pageIndex: 0, includeHidden: true });

    const baseMotif = await call(server, 'create_vector_motif', {
        derivativeId: 'base_seed',
        pageIndex: 0,
        motifId: 'base_motif',
        group: true,
        shapes: [
            { shapeType: 'rectangle', bounds: [36, 36, 96, 156], fillSwatch: 'Black' },
            { shapeType: 'oval', bounds: [54, 174, 114, 234], fillSwatch: 'Black' }
        ],
        label: { slot: 'motif', editable: true }
    });
    assert.ok(baseMotif.objectIds.length >= 2, 'base motif should create at least two vector objects');

    const derivatives = [];
    for (const derivativeId of ['derivative_a5', 'derivative_square', 'derivative_a3']) {
        const pageSize = derivativeId === 'derivative_square' ? 'social_square' : derivativeId === 'derivative_a3' ? 'A3' : 'A5';
        const derivative = await call(server, 'create_derivative_page', { derivativeId, pageSize, basePageIndex: 0 });
        derivatives.push(derivative);

        const duplicated = await call(server, 'duplicate_items_to_page', {
            sourceLabelQueries: [{ motifId: 'base_motif' }],
            targetPageIndex: derivative.pageIndex,
            offset: [24, 24],
            preserveRelativePositions: true,
            labelPatch: { derivativeId }
        });
        assert.ok(duplicated.duplicatedObjects.length >= 1, 'must duplicate at least one base motif object');

        const textSlot = await call(server, 'create_text_slot', {
            derivativeId,
            role: 'headline',
            slot: 'headline',
            pageIndex: derivative.pageIndex,
            bounds: [120, 60, 220, 420],
            text: `Headline for ${derivativeId}`,
            autoFit: true
        });

        const imageSlot = await call(server, 'create_image_slot', {
            derivativeId,
            role: 'hero',
            slot: 'hero_image',
            pageIndex: derivative.pageIndex,
            bounds: [240, 60, 520, 420],
            imagePath: sourceImage ? path.join(workspaceAssetDir, path.basename(sourceImage)) : undefined,
            placeholder: !sourceImage,
            fitMode: 'fillProportionally'
        });

        const vectorSlot = await call(server, 'create_vector_motif', {
            derivativeId,
            pageIndex: derivative.pageIndex,
            motifId: `${derivativeId}_motif`,
            group: false,
            shapes: [{ shapeType: 'rectangle', bounds: [540, 60, 590, 180], fillSwatch: 'Black' }],
            label: { slot: 'accent', editable: true }
        });

        await call(server, 'apply_layout_recipe', {
            derivativeId,
            edits: [
                { objectId: textSlot.objectId, setText: `${derivativeId} updated headline`, labelPatch: { updated: true } },
                { objectId: imageSlot.objectId, zOrder: 'front' },
                { objectId: vectorSlot.objectIds[0], setBounds: [540, 80, 600, 220] }
            ]
        });

        await call(server, 'fit_text_to_frame', { objectId: textSlot.objectId, minPointSize: 8, allowTrackingTighten: true, minTracking: -20 });
        const preview = await call(server, 'export_derivative_preview', { derivativeId, pageIndex: derivative.pageIndex, format: 'png', overwrite: true });
        assert.ok(preview.path.includes(`${path.sep}previews${path.sep}`), 'preview must stay inside workspace previews/');

        const inspection = await call(server, 'inspect_derivative', { derivativeId, includeChecks: true, includeObjectDetails: true, includePreviewHistory: true });
        assert.ok(inspection.objects.length >= 3, 'inspection should include created objects');

        await call(server, 'run_derivative_checks', { derivativeId, requireNoVisibleReferenceUnderlay: true });
        await call(server, 'save_version', { derivativeId, label: `after_${derivativeId}` });
    }

    assert.equal(derivatives.length, 3, 'must create three derivative pages');
    return { success: true, derivativesCreated: derivatives.length };
}

if (process.env.RUN_TEMPLATE_LIVE === '1') {
    const workspaceRoot = process.env.TEMPLATE_WORKSPACE_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'indesign-template-live-'));
    const assetsDir = process.env.TEMPLATE_ASSETS_DIR || path.dirname(process.env.TEMPLATE_BASE_INDD || '');
    await runTemplateMvpFlow({ fixtureInddPath: process.env.TEMPLATE_BASE_INDD, workspaceRoot, assetsDir });
    console.log('Template MVP live flow passed');
} else {
    console.log('Template MVP live flow skipped. Set RUN_TEMPLATE_LIVE=1 with TEMPLATE_BASE_INDD and a live InDesign bridge/plugin session.');
}
