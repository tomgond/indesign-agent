import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { templateToolDefinitions } from '../src/types/toolDefinitionsTemplate.js';
import { getToolDefinitionsForProfile } from '../src/types/index.js';
import { appendRuntimeLog, readRuntimeLogs } from '../src/core/runtimeLogger.js';

const bridgeLoggerModule = await import('../bridge/runtimeLogger.cjs');
const bridgeLogger = bridgeLoggerModule.default || bridgeLoggerModule;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'indesign-template-logs-'));
const runtimeDir = path.join(root, 'workspace');
const runtimeLogPath = path.join(runtimeDir, 'logs', 'runtime.jsonl');
const bridgeLogPath = path.join(root, 'bridge.jsonl');
const priorBridgeLogPath = process.env.INDESIGN_BRIDGE_LOG_PATH;

try {
    fs.mkdirSync(path.dirname(runtimeLogPath), { recursive: true });
    fs.writeFileSync(runtimeLogPath, '{"ts":"2026-01-01T00:00:00.000Z","component":"TemplateHandlers","event":"bad"}\n{not-json}\n');
    fs.appendFileSync(runtimeLogPath, '{"ts":"2026-01-01T00:00:01.000Z","component":"ScriptExecutor","event":"one","traceId":"t1","toolName":"toolA","phase":"p1"}\n');
    fs.appendFileSync(runtimeLogPath, '{"ts":"2026-01-01T00:00:02.000Z","component":"TemplateHandlers","event":"two","traceId":"t2","toolName":"toolB","phase":"p2"}\n');

    const missing = readRuntimeLogs({ workspaceRoot: path.join(root, 'missing'), limit: 10 });
    assert.equal(missing.logs.length, 0);
    assert.ok(missing.warnings.length > 0);

    const all = readRuntimeLogs({ workspaceRoot: runtimeDir, limit: 10 });
    assert.ok(all.logs.some((entry) => entry.event === 'one'));
    assert.ok(all.logs.some((entry) => entry.event === 'two'));
    assert.ok(all.warnings.length >= 1);

    const filtered = readRuntimeLogs({ workspaceRoot: runtimeDir, limit: 1, component: 'TemplateHandlers', traceId: 't2', toolName: 'toolB', phase: 'p2', event: 'two', sinceTs: '2026-01-01T00:00:02.000Z' });
    assert.equal(filtered.logs.length, 1);
    assert.equal(filtered.logs[0].event, 'two');

    const limit = readRuntimeLogs({ workspaceRoot: runtimeDir, limit: 1 });
    assert.equal(limit.logs.length, 1);
    assert.equal(limit.logs[0].event, 'two');

    const templateProfile = getToolDefinitionsForProfile('template').map((tool) => tool.name);
    assert.ok(templateProfile.includes('get_runtime_logs'));
    assert.ok(templateProfile.includes('get_debug_bundle'));

    const runtimeTool = templateToolDefinitions.find((tool) => tool.name === 'get_runtime_logs');
    const debugTool = templateToolDefinitions.find((tool) => tool.name === 'get_debug_bundle');
    assert.ok(runtimeTool);
    assert.ok(debugTool);
    assert.equal(runtimeTool.inputSchema.type, 'object');
    assert.equal(runtimeTool.inputSchema.additionalProperties, false);
    assert.equal(debugTool.inputSchema.type, 'object');
    assert.equal(debugTool.inputSchema.additionalProperties, false);

    process.env.INDESIGN_BRIDGE_LOG_PATH = bridgeLogPath;
    bridgeLogger.appendBridgeLog({ event: 'bridge_test', traceId: 'b1', toolName: 'toolX', phase: 'phaseX' });
    bridgeLogger.appendBridgeLog({ event: 'bridge_test_2', traceId: 'b2', toolName: 'toolY', phase: 'phaseY' });
    fs.appendFileSync(bridgeLogPath, '{oops}\n');

    const bridgeLogs = bridgeLogger.readBridgeLogs({ limit: 1, traceId: 'b2', toolName: 'toolY', phase: 'phaseY', event: 'bridge_test_2' });
    assert.equal(bridgeLogs.logs.length, 1);
    assert.equal(bridgeLogs.logs[0].event, 'bridge_test_2');

    const bridgeMissing = bridgeLogger.readBridgeLogs({ limit: 10, traceId: 'nope' });
    assert.equal(bridgeMissing.logs.length, 0);

    const appended = appendRuntimeLog({ component: 'TemplateHandlers', event: 'append_test' }, runtimeDir);
    assert.equal(appended.component, 'TemplateHandlers');
    assert.equal(fs.existsSync(runtimeLogPath), true);

    console.log('Template log tests passed');
} finally {
    if (priorBridgeLogPath == null) delete process.env.INDESIGN_BRIDGE_LOG_PATH;
    else process.env.INDESIGN_BRIDGE_LOG_PATH = priorBridgeLogPath;
    fs.rmSync(root, { recursive: true, force: true });
}
