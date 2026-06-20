import assert from 'node:assert/strict';

process.env.BRIDGE_URL = 'http://127.0.0.1:9';

const { InDesignMCPServer } = await import('../src/core/InDesignMCPServer.js');
const { startHttpTransport } = await import('../src/core/httpTransport.js');

const { httpServer, transport } = await startHttpTransport(new InDesignMCPServer(), {
    host: '127.0.0.1',
    port: 0,
    log: false,
});

try {
    const base = `http://127.0.0.1:${httpServer.address().port}`;
    const health = await (await fetch(`${base}/health`)).json();
    assert.deepEqual(health, { ok: true, transport: 'http', name: 'indesign-server-complete' });

    const bridge = await (await fetch(`${base}/bridge-status`)).json();
    assert.equal(bridge.ok, false);
    assert.equal(bridge.bridgeUrl, 'http://127.0.0.1:9');
    assert.equal(bridge.pluginConnected, false);

    async function postMcp(body, sessionId) {
        const headers = {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
        };
        if (sessionId) headers['mcp-session-id'] = sessionId;
        return await fetch(`${base}/mcp`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
    }

    const initializeBody = (id) => ({
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test-http-transport', version: '0.0.0' },
        },
    });

    const mcp = await postMcp(initializeBody(1));
    assert.equal(mcp.status, 200);
    assert.match(await mcp.text(), /indesign-server-complete/);

    const sessionId = mcp.headers.get('mcp-session-id');
    assert.ok(sessionId);

    const tools = await postMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sessionId);
    assert.equal(tools.status, 200);
    assert.match(await tools.text(), /create_document/);

    const secondInitialize = await postMcp(initializeBody(3));
    assert.equal(secondInitialize.status, 200);
    assert.match(await secondInitialize.text(), /indesign-server-complete/);

    const invalidSession = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'mcp-session-id': 'missing',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }),
    });
    assert.equal(invalidSession.status, 400);
} finally {
    await transport.close();
    await new Promise((resolve) => httpServer.close(resolve));
}

console.log('HTTP transport smoke test passed');
