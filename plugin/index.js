const { entrypoints } = require("uxp");

const statusEl = document.getElementById("status");

function byteLength(value) {
  const str = String(value || '');
  try {
    return new Blob([str]).size;
  } catch {
    return str.length;
  }
}

function logEvent(fields) {
  const entry = { ts: new Date().toISOString(), component: "Plugin", ...fields };
  // UXP may log via console or we write as console.debug
  console.log(JSON.stringify(entry));
}

function serializeResult(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(serializeResult);
  if (typeof value === 'object') {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (e) {
      return String(value);
    }
  }
  return String(value);
}

function resolveIndesignAppCandidate() {
  let moduleApp;
  try {
    moduleApp = require("indesign").app;
  } catch (error) {
    moduleApp = undefined;
  }

  const globalApp = globalThis && typeof globalThis === "object" ? globalThis.app : undefined;
  return moduleApp || globalApp;
}

function getDomDiagnostic(currentApp) {
  const diagnostic = {
    hasApp: !!currentApp,
    hasDocuments: false,
    documentCount: null,
    hasOpen: false,
    activeDocumentExists: false
  };

  if (!currentApp) return diagnostic;

  diagnostic.hasOpen = typeof currentApp.open === "function";

  try {
    const documents = currentApp.documents;
    diagnostic.hasDocuments = !!documents;
    diagnostic.documentCount = documents ? Number(documents.length) || 0 : null;
  } catch (error) {
    diagnostic.documentCount = null;
  }

  try {
    diagnostic.activeDocumentExists = !!currentApp.activeDocument;
  } catch (error) {
    diagnostic.activeDocumentExists = false;
  }

  return diagnostic;
}

function getIndesignApp() {
  const currentApp = resolveIndesignAppCandidate();
  if (!currentApp) {
    throw new Error("InDesign UXP app object is unavailable");
  }

  let documents;
  try {
    documents = currentApp.documents;
  } catch (error) {
    throw new Error(`InDesign UXP documents collection is unavailable: ${error.message || String(error)}`);
  }

  if (!documents) {
    throw new Error("InDesign UXP documents collection is unavailable");
  }

  return currentApp;
}

// Whitelist: only 'indesign' and 'uxp' modules are allowed inside execute calls.
// Passing raw require into new Function() would otherwise expose the full module system.
const ALLOWED_MODULES = new Set(['indesign', 'uxp']);
function sandboxedRequire(moduleName) {
  if (!ALLOWED_MODULES.has(moduleName)) {
    throw new Error(`require('${moduleName}') is not allowed inside execute calls`);
  }
  return require(moduleName);
}

async function handleExecute(ws, msg) {
  const { id, code, traceId, toolName, phase } = msg;
  const codeBytes = byteLength(code || '');

  logEvent({
    event: "execute_received",
    traceId, toolName, phase, requestId: id,
    codeBytes,
    firstChars: code ? code.slice(0, 80) : "",
  });

  const execStart = Date.now();

  try {
    const currentApp = getIndesignApp();
    // Pass sandboxedRequire so code inside new Function() can call require('indesign') etc.
    // new Function() runs in global scope and loses UXP's module-scoped require.
    const fn = new Function('app', 'require', `return (async () => { ${msg.code} })()`);
    const result = await fn(currentApp, sandboxedRequire);
    const pluginExecutionMs = Date.now() - execStart;

    // Measure serialization time
    const serStart = Date.now();
    const serialized = serializeResult(result);
    const serializeMs = Date.now() - serStart;

    const payload = JSON.stringify({ type: 'result', id, result: serialized });
    const resultBytes = byteLength(payload);

    const sendStart = Date.now();
    ws.send(payload);
    const sendMs = Date.now() - sendStart;

    logEvent({
      event: "execute_complete",
      traceId, toolName, phase, requestId: id,
      pluginExecutionMs,
      serializeMs,
      resultBytes,
      sendMs,
      timedOut: false,
      ok: true,
    });
  } catch (e) {
    const pluginExecutionMs = Date.now() - execStart;
    const errorMsg = e.message || String(e);

    logEvent({
      event: "execute_error",
      traceId, toolName, phase, requestId: id,
      pluginExecutionMs,
      ok: false,
      error: errorMsg,
    });

    const payload = JSON.stringify({ type: 'error', id, error: errorMsg });
    ws.send(payload);
  }
}

function connectToBridge() {
  const ws = new WebSocket("ws://127.0.0.1:3001");

  ws.onopen = () => {
    statusEl.textContent = "Connected to bridge ✓";
    logEvent({ event: "connected", ok: true });
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      logEvent({ event: "invalid_json", error: "Failed to parse incoming message", raw: event.data.slice(0, 200) });
      return;
    }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', id: msg.id }));
    } else if (msg.type === 'execute') {
      handleExecute(ws, msg);
    }
  };

  ws.onerror = (err) => {
    statusEl.textContent = "Bridge connection error";
    logEvent({ event: "ws_error", error: err.message || String(err) });
  };

  ws.onclose = () => {
    statusEl.textContent = "Disconnected — retrying in 3s";
    logEvent({ event: "disconnected", willRetryInMs: 3000 });
    setTimeout(connectToBridge, 3000);
  };
}

entrypoints.setup({
  panels: {
    mainPanel: {
      show() {
        try {
          const currentApp = getIndesignApp();
          logEvent({ event: "dom_check", ok: true, ...getDomDiagnostic(currentApp) });
        } catch (e) {
          logEvent({ event: "dom_check", ok: false, error: String(e), ...getDomDiagnostic(resolveIndesignAppCandidate()) });
        }

        try {
          const result = new Function('return 1 + 1')();
          logEvent({ event: "newFunction_check", ok: true });
        } catch (e) {
          logEvent({ event: "newFunction_check", ok: false, error: String(e) });
        }

        connectToBridge();
      }
    }
  }
});

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    getIndesignApp,
    getDomDiagnostic
  };
}
