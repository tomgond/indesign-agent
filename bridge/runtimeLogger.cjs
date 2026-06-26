const fs = require('fs');
const path = require('path');
const os = require('os');

const FALLBACK_DIR = path.join(os.homedir(), '.indesign-agent', 'logs');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function resolvePath(workspaceRoot) {
  if (workspaceRoot) {
    try {
      const p = path.join(workspaceRoot, 'logs', 'bridge.jsonl');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      return p;
    } catch {}
  }
  const bridgeLogEnv = process.env.INDESIGN_BRIDGE_LOG_PATH;
  if (bridgeLogEnv) return bridgeLogEnv;
  ensureDir(FALLBACK_DIR);
  return path.join(FALLBACK_DIR, 'bridge.jsonl');
}

function appendBridgeLog(entry) {
  const record = { ts: new Date().toISOString(), component: 'Bridge', ...entry };
  const filePath = resolvePath();
  try {
    ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, JSON.stringify(record) + '\n');
  } catch {}
  return record;
}

function readBridgeLogs(options = {}) {
  const { limit = 200, traceId, toolName, phase, event, sinceTs } = options;
  const warnings = [];
  const lines = [];
  const filePath = resolvePath();

  try {
    if (!fs.existsSync(filePath)) {
      return { logs: [], warnings: ['No bridge log file found'], sources: [filePath], limit, order: 'oldest_to_newest' };
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const all = raw.split('\n');
    for (const line of all) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (traceId && parsed.traceId !== traceId) continue;
        if (toolName && parsed.toolName !== toolName) continue;
        if (phase && parsed.phase !== phase) continue;
        if (event && parsed.event !== event) continue;
        if (sinceTs && parsed.ts && parsed.ts < sinceTs) continue;
        lines.push(parsed);
      } catch {
        warnings.push('Skipped malformed log line');
      }
    }
  } catch (err) {
    return { logs: [], warnings: ['Error reading bridge logs: ' + err.message], sources: [filePath], limit, order: 'oldest_to_newest' };
  }

  return { logs: lines.slice(-limit), warnings: warnings.length ? warnings : undefined, sources: [filePath], limit, order: 'oldest_to_newest' };
}

function bridgeLogPaths() {
  const paths = [];
  const primary = resolvePath();
  paths.push(primary);
  const alt = path.join(FALLBACK_DIR, 'bridge.jsonl');
  if (alt !== primary) paths.push(alt);
  return paths;
}

module.exports = { appendBridgeLog, readBridgeLogs, resolvePath, bridgeLogPaths };