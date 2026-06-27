#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { initWorkspace, clearActiveWorkspace } from '../src/core/workspaceState.js';

delete process.env.INDESIGN_BRIDGE_FETCH_TIMEOUT_MS;
delete process.env.INDESIGN_BRIDGE_EXEC_TIMEOUT_MS;

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const { TIMEOUT_MS } = require('../bridge/server.js');

const { withUxpBusyGate, getUxpBusyGateStatus } = await import('../src/core/uxpBusyGate.js');
const { InDesignMCPServer } = await import('../src/core/InDesignMCPServer.js');
const { TemplateHandlers } = await import('../src/handlers/templateHandlers.js');
const { EXECUTE_TIMEOUT_MS } = await import('../src/core/scriptExecutor.js');

const BASE = 'http://127.0.0.1:3000';

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 2000, stepMs = 25) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const value = await predicate();
        if (value) return value;
        await delay(stepMs);
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

async function expectReject(promise, code) {
    try {
        await promise;
        assert.fail(`Expected rejection ${code}`);
    } catch (error) {
        assert.equal(error.code, code);
        return error;
    }
}

async function test(name, fn) {
    process.stdout.write(`${name}... `);
    try {
        await fn();
        console.log('✓');
    } catch (error) {
        console.log('✗', error.message);
        throw error;
    }
}

async function runGateTests() {
    await test('MCP busy/free gate rejects concurrent UXP work', async () => {
        assert.equal(getUxpBusyGateStatus().busy, false);
        const release = {};
        const first = withUxpBusyGate({ toolName: 'first_tool' }, () => new Promise((resolve) => {
            release.resolve = resolve;
        }));
        assert.equal(getUxpBusyGateStatus().busy, true);
        const secondError = await expectReject(
            withUxpBusyGate({ toolName: 'second_tool' }, async () => 'nope'),
            'INDESIGN_BUSY'
        );
        assert.equal(secondError.busy, true);
        assert.equal(secondError.active.toolName, 'first_tool');
        release.resolve('done');
        assert.equal(await first, 'done');
        assert.equal(getUxpBusyGateStatus().busy, false);
        const third = await withUxpBusyGate({ toolName: 'third_tool' }, async () => 'ok');
        assert.equal(third, 'ok');
    });

    await test('get_workspace_status skips UXP validation while busy', async () => {
        const root = fs.mkdtempSync(path.join(process.cwd(), '.tmp-status-'));
        const originalSourcePath = path.join(root, 'original.indd');
        const workspaceRoot = path.join(root, 'workspace');
        fs.writeFileSync(originalSourcePath, 'fake-indd');
        initWorkspace({ originalSourcePath, workspaceRoot, overwriteExistingWorkspace: true });

        const originalRawValidateActive = TemplateHandlers.rawValidateActive;
        TemplateHandlers.rawValidateActive = async () => {
            throw new Error('rawValidateActive should not run while busy');
        };
        const { ScriptExecutor } = await import('../src/core/scriptExecutor.js');
        const originalBridgeStatusMethod = ScriptExecutor.bridgeStatus;
        ScriptExecutor.bridgeStatus = async () => ({ ok: true, connected: true, queueDepth: 0 });

        try {
            const status = await withUxpBusyGate({ toolName: 'busy_tool' }, async () => TemplateHandlers.get_workspace_status());
            assert.equal(status.success, true);
            assert.equal(status.result.uxpExecution.busy, true);
            assert.ok(Array.isArray(status.result.warnings));
            assert.ok(status.result.warnings.some((warning) => /Skipped active document validation/i.test(warning)));
            assert.equal(status.result.activeDocument, null);
        } finally {
            TemplateHandlers.rawValidateActive = originalRawValidateActive;
            ScriptExecutor.bridgeStatus = originalBridgeStatusMethod;
            clearActiveWorkspace();
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await test('MCP boundary gates template UXP tools', async () => {
        const originalHandle = TemplateHandlers.handle;
        const calls = [];
        let releaseFirst;
        TemplateHandlers.handle = async (name, args) => {
            calls.push(name);
            if (name === 'inspect_document_bundle') {
                return await new Promise((resolve) => {
                    releaseFirst = resolve;
                });
            }
            return { success: true, name, args };
        };

        const server = new InDesignMCPServer();
        server.canLoadTemplateWorkspace = () => true;

        try {
            const first = server.handleToolCall('inspect_document_bundle', {});
            const busyError = await expectReject(server.handleToolCall('inspect_document_bundle', {}), 'INDESIGN_BUSY');
            assert.equal(busyError.busy, true);
            const pure = await server.handleToolCall('validate_workspace_path', { path: '/tmp/example', kind: 'input' });
            assert.equal(pure.success, true);
            assert.equal(pure.name, 'validate_workspace_path');
            releaseFirst({ success: true, name: 'inspect_document_bundle' });
            assert.equal((await first).success, true);
            assert.deepEqual(calls, ['inspect_document_bundle', 'validate_workspace_path']);
        } finally {
            TemplateHandlers.handle = originalHandle;
        }
    });
}

async function runPluginSourceTest() {
    await test('Plugin no longer has synthetic timeout path', async () => {
        const pluginSource = fs.readFileSync(path.join(process.cwd(), 'plugin/index.js'), 'utf8');
        assert.ok(!/PLUGIN_TIMEOUT_MS/.test(pluginSource));
        assert.ok(!/Promise\.race\s*\(/.test(pluginSource));
        assert.match(pluginSource, /const result = await fn\(app, sandboxedRequire\);/);
    });
}

async function startBridgeProcess() {
    const child = spawn('node', ['bridge/server.js'], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            INDESIGN_BRIDGE_EXEC_TIMEOUT_MS: '120',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stderrLines = [];
    child.stderr.on('data', (data) => {
        stderrLines.push(...data.toString().split('\n').map((line) => line.trim()).filter(Boolean));
    });

    child.stdout.on('data', () => {});

    const cleanup = async () => {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
    };

    await waitFor(async () => {
        try {
            const response = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(500) });
            return response.ok;
        } catch {
            return false;
        }
    }, 5000);

    return { child, stderrLines, cleanup };
}

async function runBridgeTests() {
    await test('Bridge timeout marks dirty and does not drain', async () => {
        const { child, stderrLines, cleanup } = await startBridgeProcess();
        const ws = new WebSocket('ws://127.0.0.1:3001');
        const received = [];
        let firstRequestId = null;
        let secondRequestId = null;
        let nextResponse = null;

        const messageWaiters = [];
        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            received.push(msg);
            if (msg.type === 'execute') {
                if (!firstRequestId) firstRequestId = msg.id;
                else if (!secondRequestId) secondRequestId = msg.id;
            }
            if (nextResponse && msg.type === 'execute') {
                ws.send(JSON.stringify(nextResponse(msg.id)));
                nextResponse = null;
            }
            for (let i = 0; i < messageWaiters.length; i += 1) {
                const waiter = messageWaiters[i];
                if (waiter(msg)) {
                    messageWaiters.splice(i, 1);
                    break;
                }
            }
        });

        await new Promise((resolve, reject) => {
            ws.once('open', resolve);
            ws.once('error', reject);
        });

        const firstPromise = fetch(`${BASE}/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(3000),
            body: JSON.stringify({
                code: 'await new Promise(() => {})',
                traceId: 'trace-heavy',
                toolName: 'heavy_tool',
                phase: 'phase-1'
            })
        });

        await waitFor(() => firstRequestId, 2000);

        const secondPromise = fetch(`${BASE}/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(3000),
            body: JSON.stringify({
                code: 'return 2;',
                traceId: 'trace-queued',
                toolName: 'queued_tool',
                phase: 'phase-2'
            })
        });

        const firstResponse = await firstPromise;
        assert.equal(firstResponse.status, 500);
        const firstBody = await firstResponse.json();
        assert.match(firstBody.error, /Execution timed out after 120ms/);

        const secondResponse = await secondPromise;
        assert.equal(secondResponse.status, 409);
        const secondBody = await secondResponse.json();
        assert.equal(secondBody.code, 'INDESIGN_BRIDGE_DIRTY');
        assert.equal(secondBody.possiblyBusyAfterTimeout.requestId, firstRequestId);

        const dirtyStatus = await (await fetch(`${BASE}/status`)).json();
        assert.equal(dirtyStatus.possiblyBusyAfterTimeout.requestId, firstRequestId);
        assert.equal(dirtyStatus.timedOutRequestCount, 1);
        assert.equal(received.filter((msg) => msg.type === 'execute').length, 1);

        const dirtyReject = await fetch(`${BASE}/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(3000),
            body: JSON.stringify({
                code: 'return 3;',
                traceId: 'trace-dirty',
                toolName: 'dirty_tool',
                phase: 'phase-3'
            })
        });
        assert.equal(dirtyReject.status, 409);
        const dirtyBody = await dirtyReject.json();
        assert.equal(dirtyBody.code, 'INDESIGN_BRIDGE_DIRTY');

        ws.send(JSON.stringify({
            type: 'result',
            id: firstRequestId,
            result: { success: true, recovered: true }
        }));

        await waitFor(async () => {
            const status = await (await fetch(`${BASE}/status`)).json();
            return status.possiblyBusyAfterTimeout === null && status.timedOutRequestCount === 0;
        }, 2000);

        assert.ok(stderrLines.some((line) => line.includes('"event":"ws_response_after_timeout"') && line.includes(firstRequestId)));
        assert.ok(!stderrLines.some((line) => line.includes('"event":"ws_response_orphan"') && line.includes(firstRequestId)));

        nextResponse = (id) => ({ type: 'result', id, result: { success: true, accepted: true } });
        const fourthPromise = fetch(`${BASE}/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(3000),
            body: JSON.stringify({
                code: 'return 4;',
                traceId: 'trace-recovered',
                toolName: 'recovered_tool',
                phase: 'phase-4'
            })
        });

        await waitFor(() => secondRequestId || received.filter((msg) => msg.type === 'execute').length >= 2, 2000);
        const fourthResponse = await fourthPromise;
        assert.equal(fourthResponse.status, 200);
        const fourthBody = await fourthResponse.json();
        assert.equal(fourthBody.result.accepted, true);

        const finalStatus = await (await fetch(`${BASE}/status`)).json();
        assert.equal(finalStatus.possiblyBusyAfterTimeout, null);
        assert.equal(finalStatus.timedOutRequestCount, 0);

        ws.close();
        await cleanup();
    });

    await test('Timeout defaults', async () => {
        assert.equal(TIMEOUT_MS, 60000);
        assert.equal(EXECUTE_TIMEOUT_MS, 65000);
    });
}

try {
    await runGateTests();
    await runPluginSourceTest();
    await runBridgeTests();
    console.log('\nExecution safety tests passed');
} catch (error) {
    console.error('\nExecution safety tests failed');
    process.exitCode = 1;
    throw error;
}
