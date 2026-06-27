import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initWorkspace, clearActiveWorkspace } from '../src/core/workspaceState.js';
import { buildEnsureTemplateReadyCode } from '../src/handlers/templateHandlers.js';
import { TemplateHandlers } from '../src/handlers/templateHandlers.js';
import { ScriptExecutor } from '../src/core/scriptExecutor.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'indesign-template-readiness-'));
const original = path.join(root, 'base.indd');
const workspaceRoot = path.join(root, 'workspace');
fs.writeFileSync(original, 'fake-indd-bytes');

try {
    const manifest = initWorkspace({ originalSourcePath: original, workspaceRoot, overwriteExistingWorkspace: true });
    const expectedWorkingCopyPath = path.resolve(manifest.workingCopyPath);
    const code = buildEnsureTemplateReadyCode(expectedWorkingCopyPath, { allowSwitchDocument: true, openIfMissing: true });
    const run = new AsyncFunction('app', code);

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

    const result = await run(app);

    assert.equal(result.success, true);
    assert.equal(result.opened, true);
    assert.equal(openedPath, expectedWorkingCopyPath);
    assert.equal(result.activeDocumentPath, expectedWorkingCopyPath);
    assert.equal(app.activeDocument, openedDoc);
    assert.ok(Array.isArray(result.pathReadWarnings));
    assert.ok(result.pathReadWarnings.some((warning) => warning.property === 'filePath' && warning.name === 'Unsaved.indd'));
    assert.ok(result.pathReadWarnings.some((warning) => warning.property === 'fullName' && warning.name === 'Unsaved.indd'));

    const noAppResult = await run(undefined);
    assert.equal(noAppResult.success, false);
    assert.equal(noAppResult.errorCode, 'UXP_APP_UNAVAILABLE');
    assert.equal(noAppResult.error, 'InDesign UXP app object is unavailable');

    let openAttempted = false;
    const documentsThrowResult = await run({
        get documents() {
            throw new Error('documents getter exploded');
        },
        async open() {
            openAttempted = true;
            throw new Error('should not be called');
        }
    });
    assert.equal(documentsThrowResult.success, false);
    assert.equal(documentsThrowResult.errorCode, 'UXP_DOCUMENTS_UNAVAILABLE');
    assert.equal(documentsThrowResult.error, 'InDesign UXP documents collection is unavailable');
    assert.match(String(documentsThrowResult.documentsError), /documents getter exploded/);
    assert.equal(openAttempted, false);

    const originalExecuteViaUXP = ScriptExecutor.executeViaUXP;
    try {
        const badDoc = {
            name: 'BrokenActive.indd',
            get filePath() {
                throw new Error('Broken active document has no path');
            },
            get fullName() {
                throw new Error('Broken active document has no path');
            }
        };

        ScriptExecutor.executeViaUXP = async (code) => {
            const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
            const run = new AsyncFunction('app', code);
            return await run({
                documents: [badDoc],
                activeDocument: badDoc
            });
        };

        const activeResult = await TemplateHandlers.rawValidateActive();
        assert.equal(activeResult.ok, false);
        assert.equal(activeResult.activeDocumentPath, null);
        assert.equal(activeResult.workingCopyPath, expectedWorkingCopyPath);
        assert.equal(activeResult.appAvailable, true);
        assert.equal(activeResult.documentsAvailable, true);
        assert.equal(activeResult.documentCount, 1);
        assert.equal(activeResult.error, null);
        assert.ok(Array.isArray(activeResult.pathReadWarnings));
        assert.ok(activeResult.pathReadWarnings.some((warning) => warning.property === 'filePath'));
        assert.ok(activeResult.pathReadWarnings.some((warning) => warning.property === 'fullName'));

        ScriptExecutor.executeViaUXP = async (code) => {
            const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
            const run = new AsyncFunction('app', code);
            return await run(undefined);
        };

        const unavailableResult = await TemplateHandlers.rawValidateActive();
        assert.equal(unavailableResult.ok, false);
        assert.equal(unavailableResult.appAvailable, false);
        assert.equal(unavailableResult.documentsAvailable, false);
        assert.equal(unavailableResult.documentCount, null);
        assert.equal(unavailableResult.error, 'InDesign UXP app object is unavailable');

        ScriptExecutor.executeViaUXP = async (code) => {
            const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
            const run = new AsyncFunction('app', code);
            return await run({
                get documents() {
                    throw new Error('documents getter exploded');
                }
            });
        };

        const documentsUnavailableResult = await TemplateHandlers.rawValidateActive();
        assert.equal(documentsUnavailableResult.ok, false);
        assert.equal(documentsUnavailableResult.appAvailable, true);
        assert.equal(documentsUnavailableResult.documentsAvailable, false);
        assert.equal(documentsUnavailableResult.documentCount, null);
        assert.equal(documentsUnavailableResult.error, 'InDesign UXP documents collection is unavailable');
    } finally {
        ScriptExecutor.executeViaUXP = originalExecuteViaUXP;
    }

    console.log('Template readiness tests passed');
} finally {
    clearActiveWorkspace();
    fs.rmSync(root, { recursive: true, force: true });
}
