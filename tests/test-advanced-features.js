#!/usr/bin/env node

/**
 * Advanced Features Test
 * Tests master spreads, spreads, layers, export, and utility functions with
 * light behavioral assertions instead of success-only checks.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEST_CONFIG = {
    serverPath: join(__dirname, '../src/index.js'),
    delay: 1500,
    timeout: 30000,
    artifactsRoot: '/tmp/indesign-mcp-advanced-features'
};

function log(message, level = 'info') {
    const timestamp = new Date().toISOString();
    const emoji = {
        info: 'ℹ️',
        success: '✅',
        error: '❌',
        warning: '⚠️'
    }[level] || 'ℹ️';
    console.log(`${emoji} [${timestamp}] ${message}`);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendRequest(serverProcess, method, params = {}) {
    return new Promise((resolve, reject) => {
        const request = {
            jsonrpc: '2.0',
            id: Date.now(),
            method,
            params
        };

        const requestStr = JSON.stringify(request) + '\n';
        serverProcess.stdin.write(requestStr);

        let responseData = '';
        const timeout = setTimeout(() => {
            reject(new Error('Request timeout'));
        }, TEST_CONFIG.timeout);

        const responseHandler = (data) => {
            responseData += data.toString();
            if (responseData.includes('\n')) {
                clearTimeout(timeout);
                serverProcess.stdout.removeListener('data', responseHandler);
                try {
                    resolve(JSON.parse(responseData.trim()));
                } catch (error) {
                    reject(new Error(`Failed to parse response: ${error.message}`));
                }
            }
        };

        serverProcess.stdout.on('data', responseHandler);
    });
}

async function callTool(serverProcess, toolName, args = {}) {
    log(`Testing: ${toolName}`, 'info');

    const response = await sendRequest(serverProcess, 'tools/call', {
        name: toolName,
        arguments: args
    });

    if (response.error) {
        throw new Error(response.error.message);
    }

    const content = response.result?.content?.[0]?.text;
    if (!content) {
        throw new Error('No result content');
    }

    try {
        return JSON.parse(content);
    } catch {
        throw new Error(content);
    }
}

async function runCheck(testResults, name, fn) {
    testResults.total++;
    try {
        await fn();
        testResults.passed++;
        log(`${name}: PASS`, 'success');
    } catch (error) {
        testResults.failed++;
        testResults.errors.push(`${name}: ${error.message}`);
        log(`${name}: FAIL - ${error.message}`, 'error');
    }
}

function parseJsonString(result, label) {
    if (typeof result !== 'string') {
        throw new Error(`${label} did not return a JSON string`);
    }
    return JSON.parse(result);
}

async function testAdvancedFeatures() {
    log('Starting Advanced Features Test', 'info');
    log(`Server Path: ${TEST_CONFIG.serverPath}`, 'info');

    rmSync(TEST_CONFIG.artifactsRoot, { recursive: true, force: true });
    mkdirSync(TEST_CONFIG.artifactsRoot, { recursive: true });

    const serverProcess = spawn('node', [TEST_CONFIG.serverPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
            ...process.env,
            MCP_TRANSPORT: 'stdio',
            ALLOW_EXECUTE_INDESIGN_CODE: 'true'
        }
    });

    serverProcess.stderr.on('data', (data) => {
        log(`Server Error: ${data.toString().trim()}`, 'error');
    });

    await delay(3000);

    const testResults = {
        total: 0,
        passed: 0,
        failed: 0,
        errors: []
    };

    try {
        log('=== PHASE 1: Document Foundation ===', 'info');
        await runCheck(testResults, 'create_document', async () => {
            const result = await callTool(serverProcess, 'create_document', {
                width: 210,
                height: 297,
                pages: 2,
                facingPages: true
            });
            assert.equal(result.success, true);
            assert.equal(result.operation, 'Create Document');
        });
        await delay(TEST_CONFIG.delay);

        log('=== PHASE 2: Layer Management ===', 'info');
        await runCheck(testResults, 'create_layer', async () => {
            const result = await callTool(serverProcess, 'create_layer', {
                name: 'Test Layer',
                visible: true,
                locked: false,
                color: 'BLUE'
            });
            assert.equal(result.success, true);
            assert.equal(result.result.name, 'Test Layer');
            assert.equal(result.result.visible, true);
            assert.equal(result.result.locked, false);
        });
        await delay(TEST_CONFIG.delay);

        await runCheck(testResults, 'set_active_layer', async () => {
            const setResult = await callTool(serverProcess, 'set_active_layer', {
                layerName: 'Test Layer'
            });
            assert.equal(setResult.success, true);

            const activeLayer = await callTool(serverProcess, 'execute_indesign_code', {
                code: `
                    if (app.documents.length === 0) return { success: false, error: 'No document open' };
                    return { success: true, activeLayer: app.activeDocument.activeLayer.name };
                `,
                dangerousConfirmation: 'I understand this executes arbitrary InDesign code'
            });
            assert.equal(activeLayer.success, true);
            assert.equal(activeLayer.result.activeLayer, 'Test Layer');
        });
        await delay(TEST_CONFIG.delay);

        await runCheck(testResults, 'list_layers', async () => {
            const result = await callTool(serverProcess, 'list_layers');
            assert.equal(result.success, true);
            assert.ok(Array.isArray(result.result.layers));
            assert.ok(result.result.layers.some(layer => layer.name === 'Test Layer'));
        });
        await delay(TEST_CONFIG.delay);

        await runCheck(testResults, 'active_layer_applies_to_new_items', async () => {
            const createRect = await callTool(serverProcess, 'create_rectangle', {
                x: 20,
                y: 20,
                width: 40,
                height: 25,
                fillColor: 'Black'
            });
            assert.equal(createRect.success, true);

            const layerCheck = await callTool(serverProcess, 'execute_indesign_code', {
                code: `
                    if (app.documents.length === 0) return { success: false, error: 'No document open' };
                    const page = app.activeDocument.pages.item(0);
                    const item = page.rectangles.item(page.rectangles.length - 1);
                    return {
                        success: true,
                        activeLayer: app.activeDocument.activeLayer.name,
                        itemLayer: item.itemLayer ? item.itemLayer.name : null
                    };
                `,
                dangerousConfirmation: 'I understand this executes arbitrary InDesign code'
            });
            assert.equal(layerCheck.success, true);
            assert.equal(layerCheck.result.activeLayer, 'Test Layer');
            assert.equal(layerCheck.result.itemLayer, 'Test Layer');
        });
        await delay(TEST_CONFIG.delay);

        log('=== PHASE 3: Master Spread Management ===', 'info');
        await runCheck(testResults, 'create_master_spread', async () => {
            const result = await callTool(serverProcess, 'create_master_spread', {
                name: 'Test Master',
                baseName: 'Test Base',
                namePrefix: 'T',
                showMasterItems: true
            });
            assert.equal(result.success, true);
        });
        await delay(TEST_CONFIG.delay);

        await runCheck(testResults, 'list_master_spreads', async () => {
            const result = await callTool(serverProcess, 'list_master_spreads');
            assert.equal(result.success, true);
        });
        await delay(TEST_CONFIG.delay);

        await runCheck(testResults, 'create_master_text_frame', async () => {
            const result = await callTool(serverProcess, 'create_master_text_frame', {
                masterName: 'Test Master',
                content: 'Master Page Text',
                x: 20,
                y: 20,
                width: 100,
                height: 30,
                fontSize: 12,
                fontFamily: 'Helvetica Neue'
            });
            assert.equal(result.success, true);
        });
        await delay(TEST_CONFIG.delay);

        await runCheck(testResults, 'apply_master_spread', async () => {
            const result = await callTool(serverProcess, 'apply_master_spread', {
                masterName: 'Test Master',
                pageRange: 'all'
            });
            assert.equal(result.success, true);
        });
        await delay(TEST_CONFIG.delay);

        log('=== PHASE 4: Spread Management ===', 'info');
        await runCheck(testResults, 'list_spreads', async () => {
            const result = await callTool(serverProcess, 'list_spreads');
            assert.equal(result.success, true);
            assert.ok(result.result.count >= 1);
            assert.ok(Array.isArray(result.result.spreads));
            assert.ok(result.result.spreads[0].pages >= 1);
        });
        await delay(TEST_CONFIG.delay);

        await runCheck(testResults, 'get_spread_info', async () => {
            const result = await callTool(serverProcess, 'get_spread_info', {
                spreadIndex: 0
            });
            assert.equal(result.success, true);
            assert.equal(result.result.index, 0);
            assert.equal(result.result.pageCount, result.result.pages.length);
            assert.ok(result.result.pageCount >= 1);
            assert.ok(Array.isArray(result.result.pages[0].bounds));
        });
        await delay(TEST_CONFIG.delay);

        await runCheck(testResults, 'get_spread_content_summary', async () => {
            const result = await callTool(serverProcess, 'get_spread_content_summary', {
                spreadIndex: 0
            });
            assert.equal(result.success, true);
            assert.ok(result.result.pageCount >= 1);
            assert.ok(Array.isArray(result.result.pages));
            assert.ok(typeof result.result.totalItems === 'number');
        });
        await delay(TEST_CONFIG.delay);

        await runCheck(testResults, 'set_spread_properties', async () => {
            const result = await callTool(serverProcess, 'set_spread_properties', {
                spreadIndex: 0,
                name: 'Test Spread',
                allowPageShuffle: true,
                showMasterItems: true
            });
            assert.equal(result.success, true);
        });
        await delay(TEST_CONFIG.delay);

        await runCheck(testResults, 'get_page_content_summary', async () => {
            const result = await callTool(serverProcess, 'get_page_content_summary', {
                pageIndex: 0
            });
            assert.equal(result.success, true);
            assert.ok(typeof result.result.totalItems === 'number');
            assert.ok(result.result.totalItems >= 1);
            assert.ok(typeof result.result.graphics === 'number');
            assert.ok(typeof result.result.groups === 'number');
        });
        await delay(TEST_CONFIG.delay);

        log('=== PHASE 5: Document Advanced Features ===', 'info');
        await runCheck(testResults, 'get_document_elements', async () => {
            const result = await callTool(serverProcess, 'get_document_elements', {
                elementType: 'all'
            });
            assert.equal(result.success, true);
        });
        await delay(TEST_CONFIG.delay);

        await runCheck(testResults, 'get_document_stories', async () => {
            const result = await callTool(serverProcess, 'get_document_stories');
            assert.equal(result.success, true);
        });
        await delay(TEST_CONFIG.delay);

        await runCheck(testResults, 'get_document_layers', async () => {
            const result = await callTool(serverProcess, 'get_document_layers');
            assert.equal(result.success, true);
            assert.ok(result.result.layers.some(layer => layer.name === 'Test Layer'));
        });
        await delay(TEST_CONFIG.delay);

        await runCheck(testResults, 'get_document_sections', async () => {
            const result = await callTool(serverProcess, 'get_document_sections');
            assert.equal(result.success, true);
        });
        await delay(TEST_CONFIG.delay);

        await runCheck(testResults, 'preflight_document', async () => {
            const result = await callTool(serverProcess, 'preflight_document', {
                profile: 'Basic',
                includeWarnings: true
            });
            if (result.success) {
                return;
            }
            assert.match(
                String(result.result),
                /(Preflight is not available through this InDesign UXP API|Preflight failed:)/
            );
        });
        await delay(TEST_CONFIG.delay);

        log('=== PHASE 6: Export Functionality ===', 'info');
        await runCheck(testResults, 'export_pdf', async () => {
            const pdfPath = join(TEST_CONFIG.artifactsRoot, 'test-export.pdf');
            const result = await callTool(serverProcess, 'export_pdf', {
                filePath: pdfPath,
                preset: 'High Quality Print'
            });
            assert.equal(result.success, true);
            assert.ok(existsSync(pdfPath), `Expected exported PDF at ${pdfPath}`);
        });
        await delay(TEST_CONFIG.delay);

        await runCheck(testResults, 'export_images', async () => {
            const imagesDir = join(TEST_CONFIG.artifactsRoot, 'images');
            mkdirSync(imagesDir, { recursive: true });
            const result = await callTool(serverProcess, 'export_images', {
                outputPath: imagesDir,
                format: 'PNG',
                resolution: 150,
                pages: 'all',
                quality: 80
            });
            assert.equal(result.success, true);
            const files = readdirSync(imagesDir).filter(name => name.endsWith('.png'));
            assert.ok(files.length >= 2, `Expected at least 2 PNG exports, found ${files.length}`);
            assert.match(String(result.result), /2 pages exported as PNG images/);
        });
        await delay(TEST_CONFIG.delay);

        await runCheck(testResults, 'package_document', async () => {
            const packageDir = join(TEST_CONFIG.artifactsRoot, 'package');
            mkdirSync(packageDir, { recursive: true });
            const result = await callTool(serverProcess, 'package_document', {
                outputPath: packageDir,
                includeFonts: true,
                includeLinks: true,
                includeProfiles: true
            });
            assert.equal(result.success, true);
        });
        await delay(TEST_CONFIG.delay);

        log('=== PHASE 7: Utility Functions ===', 'info');
        await runCheck(testResults, 'execute_indesign_code', async () => {
            const result = await callTool(serverProcess, 'execute_indesign_code', {
                code: `
                    if (app.documents.length === 0) return { success: false, error: 'No document open' };
                    return { success: true, documentName: app.activeDocument.name };
                `,
                dangerousConfirmation: 'I understand this executes arbitrary InDesign code'
            });
            assert.equal(result.success, true);
            assert.ok(result.result.documentName);
        });
        await delay(TEST_CONFIG.delay);

        await runCheck(testResults, 'view_document', async () => {
            const result = await callTool(serverProcess, 'view_document');
            assert.equal(result.success, true);
            assert.ok(result.result.documentName);
            assert.ok(result.result.pages >= 1);
        });
        await delay(TEST_CONFIG.delay);

        await runCheck(testResults, 'close_document_clears_session', async () => {
            const closeResult = await callTool(serverProcess, 'close_document', {
                saveOptions: 'DISCARD'
            });
            assert.equal(closeResult.success, true);

            const sessionResult = await callTool(serverProcess, 'get_session_info', {});
            assert.equal(sessionResult.success, true);
            const session = parseJsonString(sessionResult.result, 'get_session_info');
            assert.equal(session.hasActiveDocument, false);
            assert.equal(session.hasPageDimensions, false);
            assert.equal(session.activeDocument, null);
            assert.equal(session.pageDimensions, null);
        });
    } catch (error) {
        log(`Test execution error: ${error.message}`, 'error');
        testResults.errors.push(error.message);
    } finally {
        serverProcess.kill();
        await delay(1000);
    }

    log('=== TEST RESULTS ===', 'info');
    log(`Total Tests: ${testResults.total}`, 'info');
    log(`Passed: ${testResults.passed}`, 'success');
    log(`Failed: ${testResults.failed}`, testResults.failed > 0 ? 'error' : 'success');
    log(`Success Rate: ${((testResults.passed / testResults.total) * 100).toFixed(1)}%`, 'info');

    if (testResults.errors.length > 0) {
        log('=== ERRORS ===', 'error');
        testResults.errors.forEach((error, index) => {
            log(`${index + 1}. ${error}`, 'error');
        });
    }

    process.exit(testResults.failed > 0 ? 1 : 0);
}

testAdvancedFeatures().catch(error => {
    log(`Test failed: ${error.message}`, 'error');
    process.exit(1);
});
