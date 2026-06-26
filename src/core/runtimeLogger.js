import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FALLBACK_DIR = path.join(os.homedir(), '.indesign-agent', 'logs');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function resolvePath(workspaceRoot) {
  if (workspaceRoot) {
    try {
      const p = path.join(workspaceRoot, 'logs', 'runtime.jsonl');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      return p;
    } catch {}
  }
  ensureDir(FALLBACK_DIR);
  return path.join(FALLBACK_DIR, 'runtime.jsonl');
}

function readPaths(workspaceRoot) {
  const primary = resolvePath(workspaceRoot);
  const fallback = path.join(FALLBACK_DIR, 'runtime.jsonl');
  return [...new Set([primary, fallback])];
}

export function resolveRuntimeLogPath(workspaceRoot) {
  return resolvePath(workspaceRoot);
}

export function appendRuntimeLog(entry, workspaceRoot) {
  const record = { ts: new Date().toISOString(), ...entry };
  const filePath = resolvePath(workspaceRoot);
  try {
    ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, JSON.stringify(record) + '\n');
  } catch {}
  return record;
}

export function readRuntimeLogs(options = {}) {
  const {
    limit = 200,
    component,
    traceId,
    toolName,
    phase,
    event,
    sinceTs,
    workspaceRoot
  } = options;

  const warnings = [];
  const lines = [];
  const sources = readPaths(workspaceRoot);

  let foundAny = false;
  for (const filePath of sources) {
    try {
      if (!fs.existsSync(filePath)) continue;
      foundAny = true;
      const raw = fs.readFileSync(filePath, 'utf8');
      const all = raw.split('\n');
      for (const line of all) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (component && parsed.component !== component) continue;
          if (traceId && parsed.traceId !== traceId) continue;
          if (toolName && parsed.toolName !== toolName) continue;
          if (phase && parsed.phase !== phase) continue;
          if (event && parsed.event !== event) continue;
          if (sinceTs && parsed.ts && parsed.ts < sinceTs) continue;
          lines.push(parsed);
        } catch {
          warnings.push(`Skipped malformed log line in ${path.basename(filePath)}`);
        }
      }
    } catch (err) {
      warnings.push('Error reading runtime log ' + filePath + ': ' + err.message);
    }
  }

  if (!foundAny) warnings.push('No runtime log file found');
  const tail = lines.slice(-limit);
  return {
    logs: tail,
    warnings: warnings.length ? warnings : undefined,
    sources,
    limit,
    order: 'oldest_to_newest'
  };
}

export function runtimeLogPaths(workspaceRoot) {
  const paths = [resolvePath(workspaceRoot)];
  const fallback = path.join(FALLBACK_DIR, 'runtime.jsonl');
  if (fallback !== paths[0]) paths.push(fallback);
  return paths;
}
