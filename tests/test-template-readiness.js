import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initWorkspace, clearActiveWorkspace } from '../src/core/workspaceState.js';
import { buildEnsureTemplateReadyCode } from '../src/handlers/templateHandlers.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'indesign-template-readiness-'));
const original = path.join(root, 'base.indd');
const workspaceRoot = path.join(root, 'workspace');
fs.writeFileSync(original, 'fake-indd-bytes');

try {
    const manifest = initWorkspace({ originalSourcePath: original, workspaceRoot, overwriteExistingWorkspace: true });
    const expectedWorkingCopyPath = path.resolve(manifest.workingCopyPath);

    const badDoc = {
        name: 'Unsaved.indd',
        get filePath() {
            throw new Error('Unsaved documents have no path');
        },
        get fullName() {
            throw new Error('Unsaved documents have no path');
        }
    };

    const docsBacking = [badDoc];
    const documents = {
        get length() {
            return docsBacking.length;
        },
        item(index) {
            return docsBacking[index] || null;
        }
    };

    let openedPath = null;
    let openedDoc = null;
    const app = {
        documents,
        activeDocument: badDoc,
        async open(openPath) {
            openedPath = openPath;
            openedDoc = {
                name: path.basename(expectedWorkingCopyPath),
                filePath: expectedWorkingCopyPath,
                fullName: expectedWorkingCopyPath,
                async activate() {
                    app.activeDocument = openedDoc;
                }
            };
            docsBacking.push(openedDoc);
            this.activeDocument = openedDoc;
            return openedDoc;
        }
    };

    const code = buildEnsureTemplateReadyCode(expectedWorkingCopyPath, { allowSwitchDocument: true, openIfMissing: true });
    const run = new AsyncFunction('app', code);
    const result = await run(app);

    assert.equal(result.success, true);
    assert.equal(result.opened, true);
    assert.equal(openedPath, expectedWorkingCopyPath);
    assert.equal(result.activeDocumentPath, expectedWorkingCopyPath);
    assert.equal(app.activeDocument, openedDoc);
    assert.ok(Array.isArray(result.pathReadWarnings));
    assert.ok(result.pathReadWarnings.some((warning) => warning.property === 'filePath' && warning.name === 'Unsaved.indd'));
    assert.ok(result.pathReadWarnings.some((warning) => warning.property === 'fullName' && warning.name === 'Unsaved.indd'));

    console.log('Template readiness tests passed');
} finally {
    clearActiveWorkspace();
    fs.rmSync(root, { recursive: true, force: true });
}
