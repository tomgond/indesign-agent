import fs from 'node:fs';
import path from 'node:path';

let currentManifest = null;

export const WORKSPACE_DIRS = ['input', 'work', 'previews', 'exports', 'versions', 'logs', 'assets'];

export function manifestPath(workspaceRoot) {
    return path.join(path.resolve(workspaceRoot), 'manifest.json');
}

export function loadWorkspace(workspaceRoot = currentManifest?.workspaceRoot) {
    if (!workspaceRoot) throw new Error('No template workspace initialized');
    currentManifest = JSON.parse(fs.readFileSync(manifestPath(workspaceRoot), 'utf8'));
    return currentManifest;
}

export function getWorkspace() {
    if (!currentManifest) throw new Error('No template workspace initialized');
    return currentManifest;
}

export function saveWorkspace(manifest = currentManifest) {
    if (!manifest?.workspaceRoot) throw new Error('No template workspace initialized');
    fs.writeFileSync(manifestPath(manifest.workspaceRoot), JSON.stringify(manifest, null, 2));
    currentManifest = manifest;
    return manifest;
}

export function initWorkspace({ originalSourcePath, workspaceRoot, overwriteExistingWorkspace = false }) {
    if (!originalSourcePath || !workspaceRoot) throw new Error('originalInddPath and workspaceRoot are required');
    const original = fs.realpathSync(path.resolve(originalSourcePath));
    if (path.extname(original).toLowerCase() !== '.indd') throw new Error('originalInddPath must be a .indd file');
    if (!fs.statSync(original).isFile()) throw new Error('originalInddPath must be a file');

    const root = path.resolve(workspaceRoot);
    if (fs.existsSync(root) && !overwriteExistingWorkspace && fs.readdirSync(root).length) {
        throw new Error('workspaceRoot already exists and is not empty');
    }
    for (const dir of WORKSPACE_DIRS) fs.mkdirSync(path.join(root, dir), { recursive: true });

    const baseCopy = path.join(root, 'input', 'base-copy.indd');
    const workingCopy = path.join(root, 'work', 'current.indd');
    fs.copyFileSync(original, baseCopy);
    fs.copyFileSync(baseCopy, workingCopy);

    return saveWorkspace({
        originalSourcePath: original,
        workspaceRoot: root,
        workingCopyPath: workingCopy,
        createdAt: new Date().toISOString(),
        activeVersionId: null,
        versions: [],
        previews: [],
        derivatives: [],
        visualReviews: []
    });
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
