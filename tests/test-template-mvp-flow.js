// Live scaffold only. This intentionally fails unless run on a Mac/Windows host
// with InDesign, the bridge server, connected UXP plugin, and a real .indd fixture.
// Expected missing pieces in the current Linux agent environment:
// - Mac/InDesign is not available.
// - Bridge is not running.
// - UXP plugin is not connected.
// - Real INDD fixture and derivative content are supplied in a later live pass.

import assert from 'node:assert/strict';
import fs from 'node:fs';

if (process.env.RUN_TEMPLATE_LIVE !== '1') {
    throw new Error('Live template MVP flow not run. Set RUN_TEMPLATE_LIVE=1 with Mac/InDesign/bridge/plugin and TEMPLATE_BASE_INDD.');
}

assert.ok(process.env.TEMPLATE_BASE_INDD, 'TEMPLATE_BASE_INDD must point to a real .indd fixture');
assert.ok(fs.existsSync(process.env.TEMPLATE_BASE_INDD), 'TEMPLATE_BASE_INDD does not exist');

// ponytail: this scaffold names the live dependency; full derivative content waits for the Mac pass.
console.log('Live template MVP scaffold reached environment checks; implement fixture-specific steps during live pass.');
