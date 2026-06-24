import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let currentManifest = null;

export const WORKSPACE_DIRS = ['input', 'work', 'previews', 'exports', 'versions', 'logs', 'assets'];

export function manifestPath(workspaceRoot) {
    return path.join(path.resolve(workspaceRoot), 'manifest.json');
}

export function activeWorkspaceStatePath() {
    const dir = path.join(os.homedir(), '.indesign-agent');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'active-workspace.json');
}

function safeRealpath(candidatePath) {
    return fs.realpathSync(path.resolve(candidatePath));
}

function ensureWorkspaceDirs(root) {
    for (const dir of WORKSPACE_DIRS) fs.mkdirSync(path.join(root, dir), { recursive: true });
}

export function readActiveWorkspaceRoot() {
    try {
        const statePath = activeWorkspaceStatePath();
        if (!fs.existsSync(statePath)) return null;
        const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (!raw?.workspaceRoot || typeof raw.workspaceRoot !== 'string') return null;
        const root = safeRealpath(raw.workspaceRoot);
        if (!fs.existsSync(root)) return null;
        if (!fs.existsSync(manifestPath(root))) return null;
        return root;
    } catch {
        return null;
    }
}

export function writeActiveWorkspaceRoot(workspaceRoot) {
    const root = safeRealpath(workspaceRoot);
    if (!fs.statSync(root).isDirectory()) throw new Error('workspaceRoot must be a directory');
    if (!fs.existsSync(manifestPath(root))) throw new Error('workspaceRoot must contain manifest.json');
    fs.writeFileSync(activeWorkspaceStatePath(), JSON.stringify({ workspaceRoot: root, updatedAt: new Date().toISOString() }, null, 2));
    return root;
}

export function clearActiveWorkspace() {
    currentManifest = null;
    try { fs.rmSync(activeWorkspaceStatePath(), { force: true }); } catch {}
}

export function fileStatEvidence(filePath) {
    const resolved = path.resolve(filePath);
    let stat;
    try {
        stat = fs.statSync(resolved);
    } catch {
        throw new Error(`File does not exist: ${resolved}`);
    }
    if (!stat.isFile()) throw new Error(`Not a file: ${resolved}`);
    if (stat.size <= 0) throw new Error(`File is empty: ${resolved}`);
    return {
        path: resolved,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        mtimeIso: stat.mtime.toISOString()
    };
}

export function validateWorkspaceFiles(manifest, { allowMissingManifest = false } = {}) {
    if (!manifest?.workspaceRoot) throw new Error('workspaceRoot is required');
    const root = safeRealpath(manifest.workspaceRoot);
    if (!fs.statSync(root).isDirectory()) throw new Error('workspaceRoot must exist');
    ensureWorkspaceDirs(root);

    const manifestFile = manifestPath(root);
    if (!allowMissingManifest && !fs.existsSync(manifestFile)) throw new Error('manifest.json is required');

    const inputCopyPath = path.join(root, 'input', 'base-copy.indd');
    const workingCopyPath = path.join(root, 'work', 'current.indd');
    if (!fs.existsSync(inputCopyPath)) throw new Error('Missing input/base-copy.indd');
    if (!fs.existsSync(workingCopyPath)) throw new Error('Missing work/current.indd');

    manifest.workspaceRoot = root;
    manifest.inputCopyPath = path.resolve(manifest.inputCopyPath || inputCopyPath);
    manifest.workingCopyPath = path.resolve(manifest.workingCopyPath || workingCopyPath);
    manifest.versions ||= [];
    manifest.previews ||= [];
    manifest.derivatives ||= [];
    manifest.visualReviews ||= [];
    return manifest;
}

export function attachWorkspace(workspaceRoot) {
    const root = safeRealpath(workspaceRoot);
    const manifestFile = manifestPath(root);
    if (!fs.existsSync(manifestFile)) throw new Error('workspaceRoot must contain manifest.json');
    const manifest = validateWorkspaceFiles(JSON.parse(fs.readFileSync(manifestFile, 'utf8')));
    currentManifest = manifest;
    saveWorkspace(manifest);
    writeActiveWorkspaceRoot(root);
    return manifest;
}

function resolveWorkspaceRoot(explicitWorkspaceRoot) {
    return explicitWorkspaceRoot
        || currentManifest?.workspaceRoot
        || process.env.INDESIGN_WORKSPACE_ROOT
        || readActiveWorkspaceRoot();
}

export function loadWorkspace(workspaceRoot) {
    const root = resolveWorkspaceRoot(workspaceRoot);
    if (!root) throw new Error('No template workspace initialized');
    const manifest = validateWorkspaceFiles(JSON.parse(fs.readFileSync(manifestPath(root), 'utf8')));
    currentManifest = manifest;
    return manifest;
}

export function getWorkspace() {
    if (!currentManifest) return loadWorkspace();
    return currentManifest;
}

export function saveWorkspace(manifest = currentManifest) {
    if (!manifest?.workspaceRoot) throw new Error('No template workspace initialized');
    const normalized = validateWorkspaceFiles(manifest, { allowMissingManifest: true });
    fs.writeFileSync(manifestPath(normalized.workspaceRoot), JSON.stringify(normalized, null, 2));
    currentManifest = normalized;
    writeActiveWorkspaceRoot(normalized.workspaceRoot);
    return normalized;
}

export function initWorkspace({ originalSourcePath, workspaceRoot, overwriteExistingWorkspace = false }) {
    if (!originalSourcePath || !workspaceRoot) throw new Error('originalInddPath and workspaceRoot are required');
    const original = safeRealpath(originalSourcePath);
    if (path.extname(original).toLowerCase() !== '.indd') throw new Error('originalInddPath must be a .indd file');
    if (!fs.statSync(original).isFile()) throw new Error('originalInddPath must be a file');

    const root = path.resolve(workspaceRoot);
    if (fs.existsSync(root) && !overwriteExistingWorkspace && fs.readdirSync(root).length) {
        throw new Error('workspaceRoot already exists and is not empty');
    }
    ensureWorkspaceDirs(root);

    const inputCopyPath = path.join(root, 'input', 'base-copy.indd');
    const workingCopyPath = path.join(root, 'work', 'current.indd');
    fs.copyFileSync(original, inputCopyPath);
    fs.copyFileSync(inputCopyPath, workingCopyPath);

    const manifest = saveWorkspace({
        originalSourcePath: original,
        workspaceRoot: root,
        inputCopyPath,
        workingCopyPath,
        createdAt: new Date().toISOString(),
        activeVersionId: null,
        versions: [],
        previews: [],
        derivatives: [],
        visualReviews: []
    });
    writeActiveWorkspaceRoot(root);
    return manifest;
}

export function nextVersionId(manifest = getWorkspace()) {
    return `v${String((manifest.versions?.length || 0) + 1).padStart(3, '0')}`;
}

export function upsertDerivative(manifest, derivativeId, patch) {
    if (!derivativeId) return null;
    manifest.derivatives ||= [];
    let record = manifest.derivatives.find((d) => d.derivativeId === derivativeId);
    if (!record) manifest.derivatives.push(record = { derivativeId, status: 'draft', createdAt: new Date().toISOString() });
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
    saveWorkspace(manifest);
    return record;
}

export function upsertDerivativePage(manifest, derivativeId, patch = {}) {
    if (!derivativeId) return null;
    const now = new Date().toISOString();
    const existing = (manifest.derivatives || []).find((record) => record.derivativeId === derivativeId) || {};
    return upsertDerivative(manifest, derivativeId, {
        derivativeId,
        pageIndex: patch.pageIndex ?? existing.pageIndex ?? null,
        pageId: patch.pageId ?? existing.pageId ?? null,
        pageName: patch.pageName ?? patch.name ?? existing.pageName ?? existing.name ?? null,
        pageBounds: patch.pageBounds ?? existing.pageBounds ?? null,
        spreadIndex: patch.spreadIndex ?? existing.spreadIndex ?? null,
        name: patch.name ?? existing.name ?? null,
        format: patch.format ?? patch.pageSize?.preset ?? patch.pageSize?.name ?? existing.format ?? null,
        pageSize: patch.pageSize ?? existing.pageSize ?? null,
        basePageIndex: patch.basePageIndex ?? existing.basePageIndex ?? null,
        status: patch.status ?? existing.status ?? 'draft',
        latestPreviewId: patch.latestPreviewId ?? existing.latestPreviewId ?? null,
        previewIds: patch.previewIds ?? existing.previewIds ?? [],
        versionIds: patch.versionIds ?? existing.versionIds ?? [],
        checkHistory: patch.checkHistory ?? existing.checkHistory ?? [],
        inspectionIds: patch.inspectionIds ?? existing.inspectionIds ?? [],
        createdAt: existing.createdAt ?? patch.createdAt ?? now,
        ...patch
    });
}
