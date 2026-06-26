/**
 * Core script execution functionality
 */
import crypto from 'node:crypto';
import { appendRuntimeLog, resolveRuntimeLogPath } from './runtimeLogger.js';
import { loadWorkspace } from './workspaceState.js';

export const BRIDGE_URL = process.env.BRIDGE_URL || 'http://127.0.0.1:3000';

// L1: read auth token from env — must match BRIDGE_TOKEN set when starting bridge/server.js
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || null;

// Timeout config — visible and env-overridable
export const EXECUTE_TIMEOUT_MS = Number(process.env.INDESIGN_BRIDGE_FETCH_TIMEOUT_MS || 35000);

function bridgeHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (BRIDGE_TOKEN) headers['Authorization'] = `Bearer ${BRIDGE_TOKEN}`;
    return headers;
}

function generateTraceId() {
    return crypto.randomUUID();
}

function logEvent(fields) {
    const entry = { ts: new Date().toISOString(), component: 'ScriptExecutor', ...fields };
    process.stderr.write(JSON.stringify(entry) + '\n');
    try {
        const manifest = loadWorkspace();
        appendRuntimeLog(entry, manifest.workspaceRoot);
    } catch {
        appendRuntimeLog(entry);
    }
}

/**
 * @typedef {Object} ExecuteOptions
 * @property {string} [toolName] - Name of the tool being executed
 * @property {string} [phase] - Phase within the tool (e.g. 'inspect_page_items_v2')
 * @property {string} [traceId] - Trace ID for correlating across layers. Generated if not set.
 * @property {string} [parentTraceId] - Parent trace ID if this is a sub-execution
 */

export class ScriptExecutor {
    /**
     * Execute JS code inside InDesign via the UXP bridge
     * @param {string} code - JS code with `app` in scope (UXP InDesign API)
     * @param {ExecuteOptions} [options] - Optional metadata for tracing/logging
     * @returns {any} The serialized result
     */
    static async executeViaUXP(code, options = {}) {
        const traceId = options.traceId || generateTraceId();
        const toolName = options.toolName || null;
        const phase = options.phase || null;
        const parentTraceId = options.parentTraceId || null;
        const codeBytes = Buffer.byteLength(code, 'utf8');
        const requestBody = JSON.stringify({ code, traceId, toolName, phase, parentTraceId });
        const requestBytes = Buffer.byteLength(requestBody, 'utf8');

        let start = Date.now();
        let response;
        try {
            response = await fetch(`${BRIDGE_URL}/execute`, {
                method: 'POST',
                headers: bridgeHeaders(),
                body: requestBody,
                signal: AbortSignal.timeout(EXECUTE_TIMEOUT_MS),
            });
        } catch (err) {
            const durationMs = Date.now() - start;
            const isTimeout =
                err.name === 'TimeoutError' ||
                err.name === 'AbortError';

            if (isTimeout) {
                logEvent({
                    event: 'fetch_timeout',
                    traceId, toolName, phase, parentTraceId,
                    durationMs, ok: false,
                    error: `Bridge request timed out after ${EXECUTE_TIMEOUT_MS}ms while waiting for /execute response`,
                    timeoutMs: EXECUTE_TIMEOUT_MS
                });
                throw new Error(
                    `Bridge request timed out after ${EXECUTE_TIMEOUT_MS}ms while waiting for /execute response`,
                    { cause: err }
                );
            }
            if (err.name === 'TypeError' || err.code === 'ECONNREFUSED' || err.message?.includes('fetch')) {
                logEvent({
                    event: 'bridge_unreachable',
                    traceId, toolName, phase, parentTraceId,
                    durationMs, ok: false,
                    error: `Bridge not reachable at ${BRIDGE_URL}`
                });
                throw new Error(
                    `Bridge not reachable at ${BRIDGE_URL}. Start it first: cd bridge && node server.js`,
                    { cause: err }
                );
            }
            logEvent({
                event: 'fetch_error',
                traceId, toolName, phase, parentTraceId,
                durationMs, ok: false, error: err.message
            });
            throw err;
        }

        const fetchMs = Date.now() - start;

        // Use response.text() + JSON.parse to measure raw bytes and parse time
        const textStart = Date.now();
        let text;
        try {
            text = await response.text();
        } catch (err) {
            logEvent({
                event: 'response_read_failed',
                traceId, toolName, phase, parentTraceId,
                fetchMs, ok: false, error: err.message
            });
            throw new Error('Failed to read bridge response body', { cause: err });
        }
        const textBytes = Buffer.byteLength(text || '', 'utf8');
        const readMs = Date.now() - textStart;

        const parseStart = Date.now();
        let data;
        try {
            data = JSON.parse(text);
        } catch (err) {
            const parseMs = Date.now() - parseStart;
            logEvent({
                event: 'json_parse_failed',
                traceId, toolName, phase, parentTraceId,
                fetchMs, readMs, parseMs,
                bridgeResponseBytes: textBytes,
                ok: false,
                error: 'Failed to parse bridge JSON response'
            });
            throw new Error(
                `Failed to parse bridge JSON response (${textBytes} bytes): ${err.message}`,
                { cause: err }
            );
        }
        const parseMs = Date.now() - parseStart;
        const totalMs = Date.now() - start;

        if (!response.ok) {
            let bridgeError = data?.error || `Bridge error: ${response.status}`;
            logEvent({
                event: 'bridge_error',
                traceId, toolName, phase, parentTraceId,
                fetchMs, readMs, parseMs, totalMs,
                bridgeResponseBytes: textBytes,
                httpStatus: response.status,
                ok: false, error: bridgeError
            });
            // Classify bridge errors more precisely
            if (/timed out after/i.test(bridgeError)) {
                throw new Error(`Bridge execution failed: ${bridgeError}`);
            }
            if (/plugin not connected/i.test(bridgeError)) {
                throw new Error(`Bridge execution failed: Plugin not connected. Open InDesign and load the panel.`);
            }
            throw new Error(bridgeError);
        }

        logEvent({
            event: 'execute_complete',
            traceId, toolName, phase, parentTraceId,
            codeBytes, requestBytes,
            fetchMs, readMs, parseMs, totalMs,
            bridgeResponseBytes: textBytes,
            ok: true
        });

        return data.result;
    }

    /**
     * Check if the UXP bridge is running and plugin is connected
     * @returns {boolean}
     */
    static async isUXPAvailable() {
        try {
            const status = await ScriptExecutor.bridgeStatus();
            return status.pluginConnected === true;
        } catch {
            return false;
        }
    }

    static async bridgeStatus() {
        try {
            const response = await fetch(`${BRIDGE_URL}/status`, {
                headers: bridgeHeaders(),
                signal: AbortSignal.timeout(1000),
            });
            const data = await response.json();
            return {
                ok: response.ok,
                bridgeUrl: BRIDGE_URL,
                pluginConnected: data.connected === true,
                queueDepth: data.queueDepth ?? null,
                processingQueue: data.processingQueue ?? null,
                activeRequest: data.activeRequest ?? null,
                timeouts: data.timeouts ?? null,
            };
        } catch (error) {
            return {
                ok: false,
                bridgeUrl: BRIDGE_URL,
                pluginConnected: false,
                error: error.message,
            };
        }
    }
}