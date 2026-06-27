import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const { startBridgeServer } = require('../bridge/server.js');
const { readBridgeLogs } = require('../bridge/runtimeLogger.cjs');

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 3000, stepMs = 25) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const value = await predicate();
        if (value) return value;
        await delay(stepMs);
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

async function postExecute(baseUrl, body) {
    const response = await fetch(`${baseUrl}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = { raw: text };
    }
    return { status: response.status, body: parsed };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'indesign-bridge-timeout-'));
const logPath = path.join(root, 'bridge.jsonl');
const priorBridgeLogPath = process.env.INDESIGN_BRIDGE_LOG_PATH;
process.env.INDESIGN_BRIDGE_LOG_PATH = logPath;

const bridge = startBridgeServer({
    host: '127.0.0.1',
    httpPort: 0,
    wsPort: 0,
    timeoutMs: 100,
});

let ws;

try {
    await waitFor(() => bridge.httpServer.address() && bridge.wss.address());
    const httpAddress = bridge.httpServer.address();
    const wsAddress = bridge.wss.address();
    const baseUrl = `http://127.0.0.1:${httpAddress.port}`;
    const wsUrl = `ws://127.0.0.1:${wsAddress.port}`;

    ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
    });

    const received = [];
    ws.on('message', (data) => {
        const raw = data.toString();
        const msg = JSON.parse(raw);
        received.push(msg);
    });

    const aRequest = postExecute(baseUrl, {
        code: 'return "A";',
        traceId: 'trace-a',
        toolName: 'tool_a',
        phase: 'phase_a',
    });

    await waitFor(() => received.length === 1 && received[0]?.id);
    const requestIdA = received[0].id;

    const bRequest = postExecute(baseUrl, {
        code: 'return "B";',
        traceId: 'trace-b',
        toolName: 'tool_b',
        phase: 'phase_b',
    });

    await waitFor(async () => {
        const status = await (await fetch(`${baseUrl}/status`)).json();
        return status.processingQueue === true && status.pendingCount === 1;
    });

    await delay(50);
    assert.equal(received.length, 1, 'queued request must not be sent while the first request is active');

    const aResponse = await aRequest;
    const bResponse = await bRequest;

    assert.equal(aResponse.status, 500);
    assert.match(String(aResponse.body?.error || ''), /Execution timed out after 100ms/);
    assert.equal(bResponse.status, 409);
    assert.equal(bResponse.body?.code, 'INDESIGN_BRIDGE_DIRTY');
    assert.match(String(bResponse.body?.error || ''), /Bridge became dirty after a previous UXP timeout/);

    const statusAfterTimeout = await (await fetch(`${baseUrl}/status`)).json();
    assert.equal(statusAfterTimeout.connected, true);
    assert.equal(statusAfterTimeout.queueDepth, 0);
    assert.equal(statusAfterTimeout.processingQueue, false);
    assert.equal(statusAfterTimeout.activeRequest, null);
    assert.equal(statusAfterTimeout.pendingCount, 0);
    assert.ok(statusAfterTimeout.possiblyBusyAfterTimeout);
    assert.equal(statusAfterTimeout.possiblyBusyAfterTimeout.requestId, requestIdA);
    assert.equal(statusAfterTimeout.timedOutRequestCount, 1);
    assert.equal(statusAfterTimeout.timeouts.bridgeExecutionMs, 100);

    const cResponse = await postExecute(baseUrl, {
        code: 'return "C";',
        traceId: 'trace-c',
        toolName: 'tool_c',
        phase: 'phase_c',
    });
    assert.equal(cResponse.status, 409);
    assert.equal(cResponse.body?.code, 'INDESIGN_BRIDGE_DIRTY');
    assert.equal(received.length, 1, 'dirty bridge must not drain queued or new work into the plugin');

    ws.send(JSON.stringify({
        type: 'result',
        id: requestIdA,
        result: { ok: true, requestId: requestIdA },
    }));

    await waitFor(async () => {
        const status = await (await fetch(`${baseUrl}/status`)).json();
        return status.possiblyBusyAfterTimeout === null && status.timedOutRequestCount === 0;
    });

    const statusAfterLateResponse = await (await fetch(`${baseUrl}/status`)).json();
    assert.equal(statusAfterLateResponse.possiblyBusyAfterTimeout, null);
    assert.equal(statusAfterLateResponse.timedOutRequestCount, 0);

    const dRequest = postExecute(baseUrl, {
        code: 'return "D";',
        traceId: 'trace-d',
        toolName: 'tool_d',
        phase: 'phase_d',
    });

    await waitFor(() => received.length === 2 && received[1]?.id);
    const requestIdD = received[1].id;
    assert.notEqual(requestIdD, requestIdA);

    ws.send(JSON.stringify({
        type: 'result',
        id: requestIdD,
        result: { ok: true, requestId: requestIdD },
    }));

    const dResponse = await dRequest;
    assert.equal(dResponse.status, 200);
    assert.deepEqual(dResponse.body, { result: { ok: true, requestId: requestIdD } });

    const logs = readBridgeLogs({ limit: 2000 });
    const timedOutLogs = logs.logs.filter((entry) => entry.requestId === requestIdA);
    assert.ok(timedOutLogs.some((entry) => entry.event === 'ws_response_after_timeout'));
    assert.ok(!timedOutLogs.some((entry) => entry.event === 'ws_response_orphan'));

    console.log('Bridge timeout dirty-state tests passed');
} finally {
    if (ws) {
        try {
            ws.close();
        } catch {}
        await new Promise((resolve) => ws.once('close', resolve)).catch(() => {});
    }
    await bridge.close();
    if (priorBridgeLogPath == null) delete process.env.INDESIGN_BRIDGE_LOG_PATH;
    else process.env.INDESIGN_BRIDGE_LOG_PATH = priorBridgeLogPath;
    fs.rmSync(root, { recursive: true, force: true });
}
