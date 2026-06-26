const { WebSocketServer } = require('ws');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { appendBridgeLog } = require('./runtimeLogger.cjs');

const WS_PORT = 3001;
const HTTP_PORT = 3000;

// Timeout config — env-overridable
const TIMEOUT_MS = Number(process.env.INDESIGN_BRIDGE_EXEC_TIMEOUT_MS || 30000);

// L1: Optional auth token — set BRIDGE_TOKEN env var to require Bearer auth on /execute.
// Without it the bridge is open to any local process; token is recommended for shared machines.
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || null;
if (!BRIDGE_TOKEN) {
  console.warn('[Bridge] WARNING: BRIDGE_TOKEN not set. Any local process can send InDesign commands.');
  console.warn('[Bridge]   To enable auth: export BRIDGE_TOKEN="$(openssl rand -hex 32)" before starting.');
  appendBridgeLog({ event: 'startup_warning', ok: false, error: 'BRIDGE_TOKEN not set; bridge accepts unauthenticated local requests' });
}

const app = express();
app.use(express.json({ limit: '10mb' }));

// Auth middleware — only applied when BRIDGE_TOKEN is configured
if (BRIDGE_TOKEN) {
  app.use('/execute', (req, res, next) => {
    const auth = req.headers['authorization'];
    if (!auth || auth !== `Bearer ${BRIDGE_TOKEN}`) {
      return res.status(401).json({ error: 'Unauthorized: missing or invalid BRIDGE_TOKEN' });
    }
    next();
  });
}

function logEvent(fields) {
  const entry = { ts: new Date().toISOString(), component: 'Bridge', ...fields };
  console.error(JSON.stringify(entry));
  try { appendBridgeLog(fields); } catch {}
}

let pluginSocket = null;
const pending = new Map(); // id -> { resolve, reject, timer, traceId, toolName, phase, dequeuedAt, queueWaitMs, queueDepthAtEnqueue }

// Serial execution queue — one UXP execution in flight at a time to prevent
// concurrent DOM mutations from corrupting InDesign document state (H2).
const requestQueue = [];
let processingQueue = false;
let activeRequest = null; // { id, traceId, toolName, phase, enqueuedAt, dequeuedAt, durationMs }

function drainQueue() {
  if (processingQueue || requestQueue.length === 0) return;

  const socket = pluginSocket;
  if (!socket) {
    // Drain all queued items with a connection error
    while (requestQueue.length > 0) {
      const item = requestQueue.shift();
      const queueWaitMs = Date.now() - item.enqueuedAt;
      logEvent({
        event: 'queue_drain_no_plugin', traceId: item.traceId,
        toolName: item.toolName, phase: item.phase,
        queueDepthAtEnqueue: item.queueDepthAtEnqueue,
        queueWaitMs, ok: false,
        error: 'Plugin not connected on drain'
      });
      item.reject(new Error('Plugin not connected'));
    }
    return;
  }

  processingQueue = true;
  const { code, resolve, reject, traceId, toolName, phase, parentTraceId, enqueuedAt, queueDepthAtEnqueue } = requestQueue.shift();
  const id = uuidv4();
  const queueWaitMs = Date.now() - enqueuedAt;
  const now = Date.now();

  activeRequest = { id, traceId, toolName, phase, enqueuedAt, dequeuedAt: now };

  logEvent({
    event: 'queue_dequeue',
    traceId, toolName, phase, parentTraceId,
    requestId: id,
    queueWaitMs,
    queueDepthAtEnqueue,
    timeoutMs: TIMEOUT_MS
  });

  const timer = setTimeout(() => {
    const age = Date.now() - now;
    pending.delete(id);
    activeRequest = null;
    processingQueue = false;
    logEvent({
      event: 'execution_timeout',
      traceId, toolName, phase, requestId: id,
      queueWaitMs, ageMs: age, timeoutMs: TIMEOUT_MS,
      ok: false, error: `Execution timed out after ${TIMEOUT_MS}ms`
    });
    reject(new Error(`Execution timed out after ${TIMEOUT_MS}ms`));
    drainQueue();
  }, TIMEOUT_MS);

  pending.set(id, {
    resolve: (result) => {
      activeRequest = null;
      processingQueue = false;
      resolve(result);
      drainQueue();
    },
    reject: (err) => {
      activeRequest = null;
      processingQueue = false;
      reject(err);
      drainQueue();
    },
    timer,
    traceId,
    toolName,
    phase,
    dequeuedAt: now,
    queueWaitMs,
    queueDepthAtEnqueue,
  });

  // Guard against WebSocket transitioning to CLOSING between null-check and send (L2)
  try {
    const msg = JSON.stringify({ type: 'execute', id, code, traceId, toolName, phase, parentTraceId });
    const msgBytes = Buffer.byteLength(msg, 'utf8');
    socket.send(msg);
    logEvent({
      event: 'ws_send',
      traceId, toolName, phase, requestId: id,
      msgBytes,
      queueWaitMs,
    });
  } catch (err) {
    clearTimeout(timer);
    pending.delete(id);
    activeRequest = null;
    processingQueue = false;
    logEvent({
      event: 'ws_send_failed',
      traceId, toolName, phase, requestId: id,
      queueWaitMs, ok: false, error: err.message
    });
    reject(new Error('Failed to send to plugin: ' + err.message));
    drainQueue();
  }
}

function enqueueExecution(code, meta = {}) {
  const { traceId, toolName, phase, parentTraceId } = meta;
  const enqueuedAt = Date.now();
  const queueDepthAtEnqueue = requestQueue.length;
  return new Promise((resolve, reject) => {
    requestQueue.push({ code, resolve, reject, traceId, toolName, phase, parentTraceId, enqueuedAt, queueDepthAtEnqueue });
    logEvent({
      event: 'queue_enqueue',
      traceId, toolName, phase, parentTraceId,
      queueDepthAtEnqueue,
      pendingMapSize: pending.size
    });
    drainQueue();
  });
}

// WebSocket server — UXP plugin connects here
const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });

wss.on('connection', (ws) => {
  console.log('[Bridge] Plugin connected');
  pluginSocket = ws;

  ws.on('message', (data) => {
    let rawStr;
    try {
      rawStr = data.toString();
    } catch (e) {
      console.error('[Bridge] Failed to decode message:', e);
      return;
    }

    const responseBytes = Buffer.byteLength(rawStr, 'utf8');
    let msg;
    try {
      msg = JSON.parse(rawStr);
    } catch (e) {
      console.error('[Bridge] Invalid JSON from plugin:', rawStr.slice(0, 200));
      return;
    }

    const item = pending.get(msg.id);
    if (!item) {
      logEvent({
        event: 'ws_response_orphan',
        requestId: msg.id,
        responseBytes,
        type: msg.type,
        warning: 'No matching pending request'
      });
      return;
    }

    clearTimeout(item.timer);
    pending.delete(msg.id);

    const bridgeExecutionMs = Date.now() - (item.dequeuedAt || activeRequest?.dequeuedAt || activeRequest?.enqueuedAt || Date.now());

    logEvent({
      event: 'ws_response',
      traceId: item.traceId,
      toolName: item.toolName,
      phase: item.phase,
      requestId: msg.id,
      responseBytes,
      bridgeExecutionMs,
      queueWaitMs: item.queueWaitMs,
      queueDepthAtEnqueue: item.queueDepthAtEnqueue,
      type: msg.type,
      ok: msg.type === 'result'
    });

    if (msg.type === 'result') {
      item.resolve(msg.result);
    } else if (msg.type === 'error') {
      logEvent({
        event: 'plugin_error',
        traceId: item.traceId,
        toolName: item.toolName,
        phase: item.phase,
        requestId: msg.id,
        bridgeExecutionMs,
        ok: false,
        error: msg.error
      });
      item.reject(new Error(msg.error));
    } else if (msg.type === 'pong') {
      item.resolve('pong');
    }
  });

  ws.on('close', () => {
    console.log('[Bridge] Plugin disconnected');
    pluginSocket = null;
    activeRequest = null;
    // Reject any in-flight pending entry
    for (const [id, item] of pending.entries()) {
      clearTimeout(item.timer);
      logEvent({
        event: 'plugin_disconnected_flush',
        traceId: item.traceId,
        toolName: item.toolName,
        phase: item.phase,
        requestId: id,
        ok: false,
        error: 'Plugin disconnected'
      });
      item.reject(new Error('Plugin disconnected'));
      pending.delete(id);
    }
    // processingQueue will be unblocked via the reject→drainQueue chain above;
    // if for some reason it isn't, reset it so reconnect can proceed
    processingQueue = false;
    // Drain any items waiting in queue with a connection error
    drainQueue();
  });

  ws.on('error', (err) => {
    console.error('[Bridge] WebSocket error:', err);
  });
});

// HTTP API — MCP server calls these endpoints

app.get('/status', (req, res) => {
  const now = Date.now();
  res.json({
    connected: pluginSocket !== null,
    queueDepth: requestQueue.length,
    processingQueue,
    activeRequest: activeRequest ? {
      id: activeRequest.id,
      traceId: activeRequest.traceId,
      toolName: activeRequest.toolName,
      phase: activeRequest.phase,
      ageMs: now - activeRequest.dequeuedAt
    } : null,
    pendingCount: pending.size,
    timeouts: {
      bridgeExecutionMs: TIMEOUT_MS,
    }
  });
});

app.post('/execute', async (req, res) => {
  if (!pluginSocket) {
    return res.status(503).json({
      error: 'Plugin not connected. Open InDesign, then load the Bridge Panel via UXP Developer Tool.'
    });
  }

  const { code, traceId, toolName, phase, parentTraceId } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'Missing "code" in request body' });
  }

  const bodyStr = JSON.stringify(req.body);
  const requestBytes = Buffer.byteLength(bodyStr, 'utf8');

  logEvent({
    event: 'execute_request',
    traceId, toolName, phase, parentTraceId,
    requestBytes,
    codeBytes: Buffer.byteLength(code, 'utf8'),
    queueDepth: requestQueue.length
  });

  try {
    const result = await enqueueExecution(code, { traceId, toolName, phase, parentTraceId });
    const resultStr = JSON.stringify({ result });
    const responseBytes = Buffer.byteLength(resultStr, 'utf8');
    logEvent({
      event: 'execute_response',
      traceId, toolName, phase,
      responseBytes,
      ok: true
    });
    res.type('application/json').send(resultStr);
  } catch (err) {
    const errorBody = JSON.stringify({ error: err.message });
    const responseBytes = Buffer.byteLength(errorBody, 'utf8');
    logEvent({
      event: 'execute_error',
      traceId, toolName, phase,
      responseBytes,
      ok: false,
      error: err.message
    });
    res.status(500).json({ error: err.message });
  }
});

app.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`[Bridge] HTTP server on http://127.0.0.1:${HTTP_PORT}`);
  console.log(`[Bridge] WebSocket server on ws://127.0.0.1:${WS_PORT}`);
  console.log(`[Bridge] Execution timeout: ${TIMEOUT_MS}ms`);
  console.log('[Bridge] Waiting for UXP plugin to connect...');
  logEvent({ event: 'startup_listen', httpPort: HTTP_PORT, wsPort: WS_PORT, timeoutMs: TIMEOUT_MS, ok: true });
});
