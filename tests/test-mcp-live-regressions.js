#!/usr/bin/env node

/**
 * Focused regression checks for local or remote MCP validation.
 *
 * Modes:
 * - local: spawn `src/index.js` over stdio
 * - remote: connect to `MCP_URL` Streamable HTTP endpoint
 *
 * Optional:
 * - `MCP_EXPORT_DIR`: writable export/package root for live artifact checks
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { spawn } from 'child_process';
import { join } from 'path';

const TEST_CONFIG = {
    serverPath: 'src/index.js',
    delay: 1200,
    timeout: 30000,
    localArtifactsRoot: '/tmp/indesign-mcp-live-regressions'
};

function log(message, level = 'info') {
    const timestamp = new Date().toISOString();
    const prefix = {
        info: 'INFO',
        success: 'PASS',
        error: 'FAIL',
        warning: 'SKIP'
    }[level] || 'INFO';
    console.log(`[${prefix}] [${timestamp}] ${message}`);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeToolPayload(content, toolName) {
    if (!content) {
        throw new Error(`${toolName}: missing result payload`);
    }
    try {
        return JSON.parse(content);
    } catch {
        throw new Error(content);
    }
}

function parseMcpHttpBody(raw) {
    const trimmed = raw.trim();
    if (!trimmed) {
        throw new Error('Empty MCP response body');
    }

    try {
        return JSON.parse(trimmed);
    } catch {}

    const dataLines = trimmed
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => line.slice(6));

    if (dataLines.length > 0) {
        return JSON.parse(dataLines.join('\n'));
    }

    throw new Error(trimmed);
}

class StdioClient {
    constructor(serverPath) {
        this.serverPath = serverPath;
        this.serverProcess = null;
        this.port = 43333;
        this.httpClient = null;
    }

    async start() {
        this.serverProcess = spawn('node', [this.serverPath], {
            stdio: ['ignore', 'ignore', 'pipe'],
            env: {
                ...process.env,
                MCP_TRANSPORT: 'http',
                MCP_HOST: '127.0.0.1',
                MCP_PORT: String(this.port),
                ALLOW_EXECUTE_INDESIGN_CODE: 'true'
            }
        });

        this.serverProcess.stderr.on('data', (data) => {
            log(`Server stderr: ${data.toString().trim()}`, 'warning');
        });

        await delay(1500);
        this.httpClient = new HttpMcpClient(`http://127.0.0.1:${this.port}/mcp`);
        await this.httpClient.initialize();
    }

    async callTool(name, args = {}) {
        return await this.httpClient.callTool(name, args);
    }

    async stop() {
        if (this.serverProcess) this.serverProcess.kill();
    }
}

class HttpMcpClient {
    constructor(url) {
        this.url = url;
        this.sessionId = null;
    }

    async initialize() {
        const response = await fetch(this.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-06-18',
                    capabilities: {},
                    clientInfo: { name: 'test-mcp-live-regressions', version: '0.0.0' }
                }
            }),
            signal: AbortSignal.timeout(TEST_CONFIG.timeout)
        });

        if (!response.ok) {
            throw new Error(`initialize failed: HTTP ${response.status}`);
        }

        this.sessionId = response.headers.get('mcp-session-id');
        if (!this.sessionId) {
            throw new Error('initialize failed: missing mcp-session-id');
        }
        await response.text();
    }

    async callTool(name, args = {}) {
        const response = await fetch(this.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                'mcp-session-id': this.sessionId
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: Date.now(),
                method: 'tools/call',
                params: {
                    name,
                    arguments: args
                }
            }),
            signal: AbortSignal.timeout(TEST_CONFIG.timeout)
        });

        if (!response.ok) {
            throw new Error(`${name}: HTTP ${response.status}`);
        }

        const raw = await response.text();
        const body = parseMcpHttpBody(raw);
        if (body.error) {
            throw new Error(`${name}: ${body.error.message}`);
        }
        return normalizeToolPayload(body.result?.content?.[0]?.text, name);
    }

    async stop() {}
}

function parseSession(result) {
    assert.equal(typeof result.result, 'string');
    return JSON.parse(result.result);
}

function parseCheckResult(name, toolResult) {
    if (toolResult.success) return { status: 'passed' };

    const message = String(toolResult.result || toolResult.error || 'Unknown failure');
    if (message.includes('execute_indesign_code is disabled by default')) {
        return { status: 'unverified', reason: message };
    }

    return { status: 'failed', reason: message };
}

async function runCheck(summary, name, fn) {
    try {
        const maybeResult = await fn();
        if (maybeResult?.status === 'unverified') {
            summary.unverified.push({ name, reason: maybeResult.reason });
            log(`${name}: UNVERIFIED - ${maybeResult.reason}`, 'warning');
            return;
        }
        summary.passed.push(name);
        log(`${name}: PASS`, 'success');
    } catch (error) {
        summary.failed.push({ name, reason: error.message });
        log(`${name}: FAIL - ${error.message}`, 'error');
    }
}

async function ensureExportRoot(mode, requestedRoot) {
    if (!requestedRoot) return null;
    if (mode === 'local') {
        rmSync(requestedRoot, { recursive: true, force: true });
        mkdirSync(requestedRoot, { recursive: true });
    }
    return requestedRoot;
}

async function main() {
    const mcpUrl = process.env.MCP_URL || '';
    const mode = mcpUrl ? 'remote' : 'local';
    const exportRoot = await ensureExportRoot(
        mode,
        process.env.MCP_EXPORT_DIR || (mode === 'local' ? TEST_CONFIG.localArtifactsRoot : '')
    );

    const summary = {
        mode,
        endpoint: mode === 'remote' ? mcpUrl : TEST_CONFIG.serverPath,
        passed: [],
        failed: [],
        unverified: []
    };

    const client = mode === 'remote'
        ? new HttpMcpClient(mcpUrl)
        : new StdioClient(TEST_CONFIG.serverPath);

    try {
        if (mode === 'remote') {
            log(`Connecting to remote MCP endpoint ${mcpUrl}`);
            await client.initialize();
        } else {
            log(`Starting local MCP server from ${TEST_CONFIG.serverPath}`);
            await client.start();
        }

        await runCheck(summary, 'create_document', async () => {
            const result = await client.callTool('create_document', {
                width: 210,
                height: 297,
                pages: 2,
                facingPages: true
            });
            assert.equal(result.success, true);
        });
        await delay(TEST_CONFIG.delay);

        await runCheck(summary, 'create_layer', async () => {
            const result = await client.callTool('create_layer', {
                name: 'Live Validation Layer',
                visible: true,
                locked: false,
                color: 'BLUE'
            });
            assert.equal(result.success, true);
        });
        await delay(TEST_CONFIG.delay);

        await runCheck(summary, 'set_active_layer', async () => {
            const result = await client.callTool('set_active_layer', {
                layerName: 'Live Validation Layer'
            });
            assert.equal(result.success, true);
        });
        await delay(TEST_CONFIG.delay);

        await runCheck(summary, 'active_layer_inspection', async () => {
            const result = await client.callTool('execute_indesign_code', {
                code: `
                    if (app.documents.length === 0) return { success: false, error: 'No document open' };
                    return { success: true, activeLayer: app.activeDocument.activeLayer.name };
                `,
                dangerousConfirmation: 'I understand this executes arbitrary InDesign code'
            });
            const check = parseCheckResult('active_layer_inspection', result);
            if (check.status === 'unverified') return check;
            assert.equal(result.success, true);
            assert.equal(result.result.activeLayer, 'Live Validation Layer');
            return null;
        });
        await delay(TEST_CONFIG.delay);

        await runCheck(summary, 'group_flow_setup', async () => {
            const first = await client.callTool('create_rectangle', {
                x: 20,
                y: 20,
                width: 40,
                height: 25,
                fillColor: 'Black'
            });
            const second = await client.callTool('create_rectangle', {
                x: 80,
                y: 20,
                width: 40,
                height: 25,
                fillColor: 'Red'
            });
            const third = await client.callTool('create_rectangle', {
                x: 140,
                y: 20,
                width: 40,
                height: 25,
                fillColor: 'Green'
            });
            assert.equal(first.success, true);
            assert.equal(second.success, true);
            assert.equal(third.success, true);

            const group = await client.callTool('create_group_from_items', {
                pageIndex: 0,
                itemIndices: [0, 1]
            });
            assert.equal(group.success, true);
        });
        await delay(TEST_CONFIG.delay);

        await runCheck(summary, 'add_item_to_group', async () => {
            const groupsBefore = await client.callTool('list_groups', { pageIndex: 0 });
            assert.equal(groupsBefore.success, true);
            assert.ok(groupsBefore.result.groups.length >= 1);

            const groupIndex = groupsBefore.result.groups[0].pageItemIndex;
            const result = await client.callTool('add_item_to_group', {
                pageIndex: 0,
                groupIndex,
                itemIndex: 2
            });
            assert.equal(result.success, true);
        });
        await delay(TEST_CONFIG.delay);

        await runCheck(summary, 'list_groups', async () => {
            const result = await client.callTool('list_groups', { pageIndex: 0 });
            assert.equal(result.success, true);
            assert.ok(result.result.count >= 1);
            assert.ok(result.result.groups.every(group => Number.isInteger(group.pageItemIndex)));

            const groupIndex = result.result.groups[0].pageItemIndex;
            const groupInfo = await client.callTool('get_group_info', {
                pageIndex: 0,
                groupIndex
            });
            assert.equal(groupInfo.success, true);
            assert.equal(groupInfo.result.itemCount, 3);
        });
        await delay(TEST_CONFIG.delay);

        await runCheck(summary, 'remove_item_from_group', async () => {
            const groups = await client.callTool('list_groups', { pageIndex: 0 });
            assert.equal(groups.success, true);
            const groupIndex = groups.result.groups[0].pageItemIndex;

            const result = await client.callTool('remove_item_from_group', {
                pageIndex: 0,
                groupIndex,
                itemIndex: 2
            });
            assert.equal(result.success, true);
        });
        await delay(TEST_CONFIG.delay);

        if (!exportRoot && mode === 'remote') {
            const reason = 'Set MCP_EXPORT_DIR to a writable remote path to validate export/package artifacts';
            summary.unverified.push({ name: 'export_pdf', reason });
            summary.unverified.push({ name: 'export_images', reason });
            summary.unverified.push({ name: 'package_document', reason });
            log(reason, 'warning');
        } else {
            await runCheck(summary, 'export_pdf', async () => {
                const pdfPath = join(exportRoot, 'exports', 'validation.pdf');
                const result = await client.callTool('export_pdf', {
                    filePath: pdfPath,
                    preset: 'High Quality Print'
                });
                assert.equal(result.success, true);
                if (mode === 'local') {
                    assert.equal(existsSync(pdfPath), true, `Expected PDF at ${pdfPath}`);
                }
            });
            await delay(TEST_CONFIG.delay);

            await runCheck(summary, 'export_images', async () => {
                const imagesDir = join(exportRoot, 'images');
                if (mode === 'local') mkdirSync(imagesDir, { recursive: true });

                const result = await client.callTool('export_images', {
                    outputPath: imagesDir,
                    format: 'PNG',
                    resolution: 150,
                    pages: 'all',
                    quality: 80
                });
                assert.equal(result.success, true);
                if (mode === 'local') {
                    const files = readdirSync(imagesDir).filter(file => file.endsWith('.png'));
                    assert.ok(files.length >= 2, `expected at least 2 PNG exports, found ${files.length}`);
                }
            });
            await delay(TEST_CONFIG.delay);

            await runCheck(summary, 'package_document', async () => {
                const packageDir = join(exportRoot, 'package');
                if (mode === 'local') mkdirSync(packageDir, { recursive: true });
                const result = await client.callTool('package_document', {
                    outputPath: packageDir,
                    includeFonts: true,
                    includeLinks: true,
                    includeProfiles: true
                });
                assert.equal(result.success, true);
            });
            await delay(TEST_CONFIG.delay);
        }

        await runCheck(summary, 'close_document_and_session_clear', async () => {
            const close = await client.callTool('close_document', {
                saveOptions: 'DISCARD'
            });
            assert.equal(close.success, true);

            const sessionResult = await client.callTool('get_session_info', {});
            assert.equal(sessionResult.success, true);
            const session = parseSession(sessionResult);
            assert.equal(session.hasActiveDocument, false);
            assert.equal(session.hasPageDimensions, false);
            assert.equal(session.activeDocument, null);
            assert.equal(session.pageDimensions, null);
        });
    } finally {
        await client.stop();
    }

    log(`Passed: ${summary.passed.length}`, 'success');
    log(`Failed: ${summary.failed.length}`, summary.failed.length ? 'error' : 'success');
    log(`Unverified: ${summary.unverified.length}`, summary.unverified.length ? 'warning' : 'info');
    console.log(`LIVE_MCP_SUMMARY ${JSON.stringify(summary)}`);

    process.exit(summary.failed.length ? 1 : 0);
}

main().catch((error) => {
    log(`Test runner crashed: ${error.message}`, 'error');
    process.exit(1);
});
