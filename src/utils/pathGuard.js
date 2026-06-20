import fs from 'node:fs';
import path from 'node:path';
import { getWorkspace } from '../core/workspaceState.js';

const BUCKETS = new Set(['input', 'work', 'previews', 'exports', 'versions', 'logs', 'assets']);

function hasTraversal(raw) {
    return /(^|[\\/])\.\.([\\/]|$)/.test(String(raw));
}

function inside(root, candidate) {
    const norm = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
    const rel = path.relative(norm(root), norm(candidate));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function assertWorkspacePath(candidatePath, { kind, allowOriginalRead = false, manifest = getWorkspace() } = {}) {
    if (!candidatePath) throw new Error('Path is required');
    if (hasTraversal(candidatePath)) throw new Error('Path traversal is not allowed');
    if (kind && !BUCKETS.has(kind)) throw new Error(`Unknown workspace path kind: ${kind}`);

    const root = fs.realpathSync(path.resolve(manifest.workspaceRoot));
    const requested = path.resolve(candidatePath);
    const parent = fs.existsSync(requested) ? requested : path.dirname(requested);
    const realParent = fs.realpathSync(parent);
    const resolved = fs.existsSync(requested) ? fs.realpathSync(requested) : path.join(realParent, path.basename(requested));

    if (!inside(root, resolved)) throw new Error('Path must stay inside workspaceRoot');
    if (!allowOriginalRead && path.resolve(manifest.originalSourcePath) === resolved) throw new Error('Refusing to write/read original source path');

    if (kind === 'work' && path.resolve(manifest.workingCopyPath) !== resolved) throw new Error('Work path must be work/current.indd');
    if (kind && kind !== 'work' && !inside(path.join(root, kind), resolved)) throw new Error(`Path must be inside workspace ${kind}/`);

    return { path: resolved, workspaceRoot: root, kind };
}

export function safeBasename(name) {
    if (!name || /[\\/]/.test(name) || hasTraversal(name)) throw new Error('Name must be a basename inside the workspace');
    return path.basename(name);
}
