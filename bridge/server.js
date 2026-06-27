const { WebSocketServer } = require('ws');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { appendBridgeLog } = require('./runtimeLogger.cjs');

const WS_PORT = 3001;
const HTTP_PORT = 3000;
const TIMEOUT_MS = Number(process.env.INDESIGN_BRIDGE_EXEC_TIMEOUT_MS || 60000);

const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || null;
if (!BRIDGE_TOKEN) {
  console.warn('[Bridge] WARNING: BRIDGE_TOKEN not set. Any local process can send InDesign commands.');
  console.warn('[Bridge]   To enable auth: export BRIDGE_TOKEN="$(openssl rand -hex 32)" before starting.');
}

function logEvent(fields) {
  const entry = { ts: new Date().toISOString(), component: 'Bridge', ...fields };
  console.error(JSON.stringify(entry));
  try {
    appendBridgeLog(entry);
  } catch {}
}

function createDirtyTimeoutError(timeoutInfo, message) {
  const error = new Error(message);
  error.code = 'INDESIGN_BRIDGE_DIRTY';
  error.statusCode = 409;
  error.busy = true;
  error.possiblyBusyAfterTimeout = timeoutInfo;
  return error;
}

function startBridgeServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  if (BRIDGE_TOKEN) {
    app.use('/execute', (req, res, next) => {
      const auth = req.headers['authorization'];
      if (!auth || auth !== `Bearer ${BRIDGE_TOKEN}`) {
        return res.status(401).json({ error: 'Unauthorized: missing or invalid BRIDGE_TOKEN' });
      }
      next();
    });
  }

  let pluginSocket = null;
  const pending = new Map();
  const timedOutRequests = new Map();
  let possiblyBusyAfterTimeout = null;

  const requestQueue = [];
  let processingQueue = false;
  let activeRequest = null;

  function clearDirtyTimeoutState(reason) {
    if (!possiblyBusyAfterTimeout && timedOutRequests.size === 0) return;
    const previous = possiblyBusyAfterTimeout;
    possiblyBusyAfterTimeout = null;
    timedOutRequests.clear();
    logEvent({
      event: 'timeout_dirty_state_cleared',
      reason,
      requestId: previous?.requestId || null,
      traceId: previous?.traceId || null,
      toolName: previous?.toolName || null,
      phase: previous?.phase || null,
      timeoutMs: previous?.timeoutMs || null
    });
  }

  function flushQueuedRequestsAfterTimeout() {
    if (requestQueue.length === 0) return;
    const timeoutInfo = possiblyBusyAfterTimeout;
    while (requestQueue.length > 0) {
      const item = requestQueue.shift();
      const queueWaitMs = Date.now() - item.enqueuedAt;
      logEvent({
        event: 'queue_flushed_dirty_after_timeout',
        traceId: item.traceId,
        toolName: item.toolName,
        phase: item.phase,
        requestId: item.id,
        queueWaitMs,
        queueDepthAtEnqueue: item.queueDepthAtEnqueue,
        ok: false,
        error: 'Bridge became dirty after a previous UXP timeout; queued request was not sent to InDesign'
      });
      item.reject(createDirtyTimeoutError(timeoutInfo, 'Bridge became dirty after a previous UXP timeout; queued request was not sent to InDesign'));
    }
  }

  function drainQueue() {
    if (processingQueue || requestQueue.length === 0) return;
    if (possiblyBusyAfterTimeout) {
      flushQueuedRequestsAfterTimeout();
      return;
    }

    const socket = pluginSocket;
    if (!socket) {
      while (requestQueue.length > 0) {
        const item = requestQueue.shift();
        const queueWaitMs = Date.now() - item.enqueuedAt;
        logEvent({
          event: 'queue_drain_no_plugin',
          traceId: item.traceId,
          toolName: item.toolName,
          phase: item.phase,
          queueDepthAtEnqueue: item.queueDepthAtEnqueue,
          queueWaitMs,
          ok: false,
          error: 'Plugin not connected on drain'
        });
        item.reject(new Error('Plugin not connected'));
      }
      return;
    }

    processingQueue = true;
    const item = requestQueue.shift();
    const now = Date.now();
    const queueWaitMs = now - item.enqueuedAt;
    const requestId = item.id;

    activeRequest = {
      id: requestId,
      traceId: item.traceId,
      toolName: item.toolName,
      phase: item.phase,
      enqueuedAt: item.enqueuedAt,
      dequeuedAt: now
    };

    logEvent({
      event: 'queue_dequeue',
      traceId: item.traceId,
      toolName: item.toolName,
      phase: item.phase,
      parentTraceId: item.parentTraceId,
      requestId,
      queueWaitMs,
      queueDepthAtEnqueue: item.queueDepthAtEnqueue,
      timeoutMs: TIMEOUT_MS
    });

    const timer = setTimeout(() => {
      const age = Date.now() - now;
      const timeoutInfo = {
        requestId,
        traceId: item.traceId || null,
        toolName: item.toolName || null,
        phase: item.phase || null,
        timedOutAt: new Date().toISOString(),
        timeoutMs: TIMEOUT_MS
      };

      pending.delete(requestId);
      timedOutRequests.set(requestId, timeoutInfo);
      possiblyBusyAfterTimeout = timeoutInfo;
      activeRequest = null;
      processingQueue = false;

      logEvent({
        event: 'execution_timeout',
        traceId: item.traceId,
        toolName: item.toolName,
        phase: item.phase,
        requestId,
        queueWaitMs,
        ageMs: age,
        timeoutMs: TIMEOUT_MS,
        ok: false,
        error: `Execution timed out after ${TIMEOUT_MS}ms`,
        timeoutInfo
      });

      item.reject(new Error(`Execution timed out after ${TIMEOUT_MS}ms`));
      flushQueuedRequestsAfterTimeout();
    }, TIMEOUT_MS);

    pending.set(requestId, {
      resolve: (result) => {
        clearTimeout(timer);
        activeRequest = null;
        processingQueue = false;
        item.resolve(result);
      },
      reject: (err) => {
        clearTimeout(timer);
        activeRequest = null;
        processingQueue = false;
        item.reject(err);
      },
      timer,
      traceId: item.traceId,
      toolName: item.toolName,
      phase: item.phase,
      dequeuedAt: now,
      queueWaitMs,
      queueDepthAtEnqueue: item.queueDepthAtEnqueue
    });

    try {
      const msg = JSON.stringify({
        type: 'execute',
        id: requestId,
        code: item.code,
        traceId: item.traceId,
        toolName: item.toolName,
        phase: item.phase,
        parentTraceId: item.parentTraceId
      });
      socket.send(msg);
      logEvent({
        event: 'ws_send',
        traceId: item.traceId,
        toolName: item.toolName,
        phase: item.phase,
        requestId,
        msgBytes: Buffer.byteLength(msg, 'utf8'),
        queueWaitMs
      });
    } catch (err) {
      clearTimeout(timer);
      pending.delete(requestId);
      activeRequest = null;
      processingQueue = false;
      logEvent({
        event: 'ws_send_failed',
        traceId: item.traceId,
        toolName: item.toolName,
        phase: item.phase,
        requestId,
        queueWaitMs,
        ok: false,
        error: err.message
      });
      item.reject(new Error('Failed to send to plugin: ' + err.message));
      drainQueue();
    }
  }

  function enqueueExecution(code, meta = {}) {
    const { traceId, toolName, phase, parentTraceId } = meta;
    const enqueuedAt = Date.now();
    const queueDepthAtEnqueue = requestQueue.length;
    const id = uuidv4();
    return new Promise((resolve, reject) => {
      requestQueue.push({
        id,
        code,
        resolve,
        reject,
        traceId,
        toolName,
        phase,
        parentTraceId,
        enqueuedAt,
        queueDepthAtEnqueue
      });
      logEvent({
        event: 'queue_enqueue',
        traceId,
        toolName,
        phase,
        parentTraceId,
        requestId: id,
        queueDepthAtEnqueue,
        pendingMapSize: pending.size
      });
      drainQueue();
    });
  }

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
      if (!item && msg && msg.id && timedOutRequests.has(msg.id)) {
        const timeoutInfo = timedOutRequests.get(msg.id);
        logEvent({
          event: 'ws_response_after_timeout',
          requestId: msg.id,
          responseBytes,
          type: msg.type,
          timeoutInfo
        });
        timedOutRequests.delete(msg.id);
        if (possiblyBusyAfterTimeout && possiblyBusyAfterTimeout.requestId === msg.id) {
          clearDirtyTimeoutState('late_response');
        }
        return;
      }

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

      clearTimeout(item.timer);
      pending.delete(msg.id);

      if (msg.type === 'result') {
        item.resolve(msg.result);
        drainQueue();
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
        drainQueue();
      } else if (msg.type === 'pong') {
        item.resolve('pong');
        drainQueue();
      }
    });

    ws.on('close', () => {
      console.log('[Bridge] Plugin disconnected');
      pluginSocket = null;
      clearDirtyTimeoutState('plugin_disconnected');
      activeRequest = null;

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

      processingQueue = false;

      while (requestQueue.length > 0) {
        const item = requestQueue.shift();
        logEvent({
          event: 'plugin_disconnected_queue_flush',
          traceId: item.traceId,
          toolName: item.toolName,
          phase: item.phase,
          requestId: item.id,
          ok: false,
          error: 'Plugin disconnected'
        });
        item.reject(new Error('Plugin disconnected'));
      }
    });

    ws.on('error', (err) => {
      console.error('[Bridge] WebSocket error:', err);
    });
  });

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
      possiblyBusyAfterTimeout,
      timedOutRequestCount: timedOutRequests.size,
      timeouts: {
        bridgeExecutionMs: TIMEOUT_MS,
      }
    });
  });

  app.post('/execute', async (req, res) => {
    if (possiblyBusyAfterTimeout) {
      logEvent({
        event: 'execute_rejected_dirty',
        traceId: req.body?.traceId || null,
        toolName: req.body?.toolName || null,
        phase: req.body?.phase || null,
        requestId: null,
        ok: false,
        error: 'Bridge is dirty after timeout'
      });
      return res.status(409).json({
        error: 'Bridge is dirty after timeout; refusing new UXP execution until late response, reconnect, or restart',
        code: 'INDESIGN_BRIDGE_DIRTY',
        possiblyBusyAfterTimeout
      });
    }

    if (!pluginSocket) {
      return res.status(503).json({
        error: 'Plugin not connected. Open InDesign, then load the Bridge Panel via UXP Developer Tool.'
      });
    }

    const { code, traceId, toolName, phase, parentTraceId } = req.body || {};
    if (!code) {
      return res.status(400).json({ error: 'Missing "code" in request body' });
    }

    const bodyStr = JSON.stringify(req.body);
    const requestBytes = Buffer.byteLength(bodyStr, 'utf8');

    logEvent({
      event: 'execute_request',
      traceId,
      toolName,
      phase,
      parentTraceId,
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
        traceId,
        toolName,
        phase,
        responseBytes,
        ok: true
      });
      res.type('application/json').send(resultStr);
    } catch (err) {
      const statusCode = err.statusCode || (err.code === 'INDESIGN_BRIDGE_DIRTY' ? 409 : 500);
      const body = statusCode === 409
        ? {
            error: err.message,
            code: err.code || 'INDESIGN_BRIDGE_DIRTY',
            possiblyBusyAfterTimeout: err.possiblyBusyAfterTimeout || possiblyBusyAfterTimeout
          }
        : { error: err.message };
      const errorBody = JSON.stringify(body);
      const responseBytes = Buffer.byteLength(errorBody, 'utf8');
      logEvent({
        event: 'execute_error',
        traceId,
        toolName,
        phase,
        responseBytes,
        ok: false,
        error: err.message,
        statusCode
      });
      res.status(statusCode).json(body);
    }
  });

  const httpServer = app.listen(HTTP_PORT, '127.0.0.1', () => {
    console.log(`[Bridge] HTTP server on http://127.0.0.1:${HTTP_PORT}`);
    console.log(`[Bridge] WebSocket server on ws://127.0.0.1:${WS_PORT}`);
    console.log(`[Bridge] Execution timeout: ${TIMEOUT_MS}ms`);
    console.log('[Bridge] Waiting for UXP plugin to connect...');
    logEvent({ event: 'startup_listen', httpPort: HTTP_PORT, wsPort: WS_PORT, timeoutMs: TIMEOUT_MS, ok: true });
  });

  return {
    httpServer,
    wss
  };
}

if (require.main === module) {
  startBridgeServer();
}

module.exports = {
  startBridgeServer,
  TIMEOUT_MS,
  HTTP_PORT,
  WS_PORT
};
