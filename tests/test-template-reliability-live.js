import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { InDesignMCPServer } from '../src/core/InDesignMCPServer.js';

async function call(server, name, args = {}) {
    const result = await server.handleToolCall(name, args);
    assert.equal(result.success, true, `${name} failed: ${JSON.stringify(result)}`);
    return result;
}

async function main() {
    if (process.env.RUN_TEMPLATE_LIVE !== '1' || !process.env.TEMPLATE_BASE_INDD) {
        console.log('Template reliability live checks skipped. Set RUN_TEMPLATE_LIVE=1 with TEMPLATE_BASE_INDD and a live InDesign bridge/plugin session.');
        return;
    }

    const workspaceRoot = process.env.TEMPLATE_WORKSPACE_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'indesign-template-reliability-'));
    const server = new InDesignMCPServer();

    await call(server, 'init_template_workspace', {
        originalInddPath: process.env.TEMPLATE_BASE_INDD,
        workspaceRoot,
        overwriteExistingWorkspace: true
    });
    await call(server, 'open_working_copy');

    const derivativeId = 'reliability_probe';
    const derivative = await call(server, 'create_derivative_page', {
        derivativeId,
        pageSize: 'A5',
        basePageIndex: 0
    });

    const headline = await call(server, 'create_text_slot', {
        derivativeId,
        role: 'headline',
        slot: 'headline',
        pageIndex: derivative.pageIndex,
        bounds: [60, 40, 140, 260],
        text: 'Visible headline'
    });

    const occluder = await call(server, 'create_shape', {
        pageIndex: derivative.pageIndex,
        shapeType: 'rectangle',
        bounds: [0, 0, derivative.pageSize.height, derivative.pageSize.width],
        fillSwatch: 'Black',
        name: `${derivativeId}__background__rect`
    });

    const checkpoint = await call(server, 'export_derivative_preview', {
        derivativeId,
        overwrite: true,
        previewQuality: 'checkpoint',
        returnImage: false
    });
    assert.equal(checkpoint.previewQuality, 'checkpoint');
    assert.equal(checkpoint.resolution, 48);

    const diagnosis = await call(server, 'diagnose_visual_mismatch', {
        derivativeId,
        minPageCoverageRatio: 0.5
    });
    assert.ok(diagnosis.likelyCauses.includes('full_page_occluder'));

    const repair = await call(server, 'set_item_layer', {
        objectIds: [occluder.objectId],
        layerName: 'AGENT_BACKGROUND',
        zOrder: 'back'
    });
    assert.equal(repair.items[0].after.layerName, 'AGENT_BACKGROUND');

    const reviewPreview = await call(server, 'export_derivative_preview', {
        derivativeId,
        overwrite: true,
        previewQuality: 'review',
        returnImage: false
    });
    assert.equal(reviewPreview.previewQuality, 'review');
    assert.equal(reviewPreview.resolution, 96);

    const rejectedFit = await server.handleToolCall('update_text_slot', {
        objectId: headline.objectId,
        text: 'Rejected mutation',
        fit: true
    });
    assert.equal(rejectedFit.success, false);

    const updatedText = await call(server, 'update_text_slot', {
        objectId: headline.objectId,
        text: 'Updated headline'
    });
    assert.equal(updatedText.before.excerpt, 'Visible headline');
    assert.equal(updatedText.after.excerpt, 'Updated headline');

    console.log('Template reliability live checks passed');
}

await main();
