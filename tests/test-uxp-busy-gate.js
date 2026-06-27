import assert from 'node:assert/strict';

import { InDesignMCPServer } from '../src/core/InDesignMCPServer.js';
import { getUxpBusyGateStatus, withUxpBusyGate } from '../src/core/uxpBusyGate.js';

async function expectReject(promise, code) {
    try {
        await promise;
        assert.fail(`Expected rejection ${code}`);
    } catch (error) {
        assert.equal(error.code, code);
        return error;
    }
}

{
    assert.equal(getUxpBusyGateStatus().busy, false);

    let releaseFirst;
    const first = withUxpBusyGate({ toolName: 'inspect_page_items_v2', phase: 'test' }, () => new Promise((resolve) => {
        releaseFirst = resolve;
    }));

    assert.equal(getUxpBusyGateStatus().busy, true);
    assert.equal(getUxpBusyGateStatus().active.toolName, 'inspect_page_items_v2');

    const busyError = await expectReject(
        withUxpBusyGate({ toolName: 'save_working_copy', phase: 'test' }, async () => ({ success: true })),
        'INDESIGN_BUSY'
    );
    assert.equal(busyError.busy, true);
    assert.equal(busyError.active.toolName, 'inspect_page_items_v2');

    releaseFirst({ success: true });
    assert.deepEqual(await first, { success: true });
    assert.equal(getUxpBusyGateStatus().busy, false);
}

{
    const server = new InDesignMCPServer();
    const gatedTools = [
        'open_working_copy',
        'save_working_copy',
        'inspect_page_items_v2',
        'inspect_document_bundle',
        'run_derivative_checks'
    ];
    const pureTools = [
        'get_workspace_status',
        'get_runtime_logs',
        'validate_workspace_path',
        'attach_template_workspace',
        'init_template_workspace',
        'copy_original_to_workspace'
    ];

    for (const name of gatedTools) {
        assert.equal(server.shouldGateTool(name), true, `${name} should be gated`);
    }
    for (const name of pureTools) {
        assert.equal(server.shouldGateTool(name), false, `${name} should remain pure`);
    }
}

{
    const server = new InDesignMCPServer();
    let releaseFirst;
    server.executeTool = async (name) => {
        if (name === 'inspect_page_items_v2') {
            return await new Promise((resolve) => {
                releaseFirst = resolve;
            });
        }
        return { success: true, toolName: name };
    };

    const first = server.handleToolCall('inspect_page_items_v2', { pageIndex: 0 });

    const pureResult = await server.handleToolCall('get_workspace_status', {});
    assert.equal(pureResult.success, true);
    assert.equal(pureResult.toolName, 'get_workspace_status');

    const busyError = await expectReject(server.handleToolCall('save_working_copy', {}), 'INDESIGN_BUSY');
    const payload = server.formatGateErrorResponse('save_working_copy', busyError);
    assert.equal(payload.success, false);
    assert.equal(payload.operation, 'save_working_copy');
    assert.equal(payload.error, busyError.message);
    assert.equal(payload.code, 'INDESIGN_BUSY');
    assert.equal(payload.busy, true);
    assert.equal(payload.active.toolName, 'inspect_page_items_v2');
    assert.equal(typeof payload.timestamp, 'string');

    releaseFirst({ success: true, toolName: 'inspect_page_items_v2' });
    assert.deepEqual(await first, { success: true, toolName: 'inspect_page_items_v2' });
}

console.log('UXP busy gate tests passed');
