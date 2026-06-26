import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { activeGuardCode } from '../src/handlers/templateHandlers.js';
import { initWorkspace, clearActiveWorkspace } from '../src/core/workspaceState.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'indesign-active-guard-'));
const original = path.join(root, 'base.indd');
const workspaceRoot = path.join(root, 'workspace');
fs.writeFileSync(original, 'fake-indd-bytes');

try {
    initWorkspace({ originalSourcePath: original, workspaceRoot, overwriteExistingWorkspace: true });

    const code = activeGuardCode('return { success: true };');
    const firstPickEnum = code.indexOf('function __pickEnum');
    const firstUse = code.indexOf('const __pt = __pickEnum');
    const tryIndex = code.indexOf('try {');
    const assignIndex = code.indexOf('doc.viewPreferences.horizontalMeasurementUnits = __pt;');

    assert.ok(firstPickEnum >= 0, 'activeGuardCode should define __pickEnum');
    assert.ok(firstUse >= 0, 'activeGuardCode should use __pickEnum');
    assert.ok(firstPickEnum < firstUse, '__pickEnum must be defined before first use');
    assert.ok(tryIndex >= 0, 'activeGuardCode should contain a try block');
    assert.ok(tryIndex < assignIndex, 'try block must begin before unit assignment');
    assert.match(code, /finally\s*\{/);
    assert.match(code, /doc\.viewPreferences\.horizontalMeasurementUnits = __savedH;/);
    assert.match(code, /doc\.viewPreferences\.verticalMeasurementUnits = __savedV;/);
    assert.match(code, /app\.scriptPreferences\.measurementUnit = __savedPref;/);

    console.log('Template active guard tests passed');
} finally {
    clearActiveWorkspace();
    fs.rmSync(root, { recursive: true, force: true });
}
