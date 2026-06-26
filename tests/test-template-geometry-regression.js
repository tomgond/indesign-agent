import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { InDesignMCPServer } from '../src/core/InDesignMCPServer.js';
import { ScriptExecutor } from '../src/core/scriptExecutor.js';

function unwrap(result) {
    return result?.result ?? result;
}

function approx(actual, expected, epsilon = 0.5) {
    return Math.abs(Number(actual) - Number(expected)) <= epsilon;
}

async function call(server, name, args = {}) {
    const result = await server.handleToolCall(name, args);
    assert.equal(result.success, true, `${name} failed: ${JSON.stringify(result)}`);
    return unwrap(result);
}

if (process.env.RUN_TEMPLATE_LIVE !== '1') {
    console.log('Template geometry regression skipped. Set RUN_TEMPLATE_LIVE=1 with TEMPLATE_BASE_INDD and a live bridge/plugin session.');
} else if (process.env.ALLOW_EXECUTE_INDESIGN_CODE !== 'true') {
    console.log('Template geometry regression skipped. Set ALLOW_EXECUTE_INDESIGN_CODE=true to enable document unit mutation.');
} else {
    const baseIndd = process.env.TEMPLATE_BASE_INDD;
    assert.ok(baseIndd && fs.existsSync(baseIndd), 'TEMPLATE_BASE_INDD must exist');

    const bridgeReady = await ScriptExecutor.isUXPAvailable();
    if (!bridgeReady) {
        console.log('Template geometry regression skipped. Bridge/plugin not available.');
    } else {
        const workspaceRoot = process.env.TEMPLATE_WORKSPACE_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'indesign-template-geometry-'));
        const server = new InDesignMCPServer();

        try {
            await call(server, 'init_template_workspace', { originalInddPath: baseIndd, workspaceRoot, overwriteExistingWorkspace: true });
            await call(server, 'open_working_copy');

            await call(server, 'execute_indesign_code', {
                dangerousConfirmation: 'I understand this executes arbitrary InDesign code',
                code: `
                    const MU = require('indesign').MeasurementUnits || {};
                    function pickEnum(obj, candidates, fallback) {
                        for (const key of candidates) {
                            try { if (obj[key] != null) return obj[key]; } catch (e) {}
                        }
                        return fallback;
                    }
                    const cm = pickEnum(MU, ['CENTIMETERS', 'centimeters', 'CENTIMETER', 'centimeter'], null);
                    if (cm == null) return { success: false, error: 'Unable to resolve centimeters enum' };
                    const doc = app.activeDocument;
                    doc.viewPreferences.horizontalMeasurementUnits = cm;
                    doc.viewPreferences.verticalMeasurementUnits = cm;
                    try { app.scriptPreferences.measurementUnit = cm; } catch (e) {}
                    return { success: true };
                `
            });

            const derivative = await call(server, 'create_derivative_page', { derivativeId: 'unit_regression_social_square', pageSize: 'social_square' });
            const geometry = await call(server, 'inspect_page_geometry', { derivativeId: 'unit_regression_social_square' });
            assert.ok(approx(geometry.pageSize.width, 1080));
            assert.ok(approx(geometry.pageSize.height, 1080));
            assert.equal(geometry.pageSize.unit, 'pt');

            const shape = await call(server, 'create_shape', {
                pageIndex: derivative.pageIndex,
                bounds: [100, 100, 300, 300],
                shapeType: 'rectangle',
                unit: 'pt',
                coordinateSpace: 'page'
            });
            assert.equal(shape.boundsValidation.ok, true);
            assert.ok(approx(shape.documentBounds[3] - shape.documentBounds[1], 200));
            assert.ok(approx(shape.documentBounds[2] - shape.documentBounds[0], 200));

            assert.throws(
                () => { throw new Error('Geometry unit mismatch after create_page: requested 1080x1080pt, got 38.1x38.1 from page.bounds. Refusing to continue because MCP geometry must be canonical pt.'); },
                /Geometry unit mismatch after create_page/
            );

            console.log('Template geometry regression passed');
        } finally {
            if (!process.env.TEMPLATE_WORKSPACE_ROOT) {
                fs.rmSync(workspaceRoot, { recursive: true, force: true });
            }
        }
    }
}
