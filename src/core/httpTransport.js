import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { ScriptExecutor } from './scriptExecutor.js';
import { InDesignMCPServer } from './InDesignMCPServer.js';

const SERVER_NAME = 'indesign-server-complete';

function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : undefined);
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

export async function startHttpTransport(mcpServer, options = {}) {
    const host = options.host || process.env.MCP_HOST || '0.0.0.0';
    const port = Number(options.port || process.env.MCP_PORT || 3333);
    const createServer = options.createServer || (() => new InDesignMCPServer());
    const transports = new Map();

    async function newSessionTransport() {
        let transport;
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sessionId) => transports.set(sessionId, transport),
            onsessionclosed: (sessionId) => transports.delete(sessionId),
        });
        transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId);
        };
        await createServer(mcpServer).connect(transport);
        return transport;
    }

    const httpServer = http.createServer(async (req, res) => {
        const path = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;

        try {
            if (req.method === 'GET' && path === '/health') {
                return json(res, 200, { ok: true, transport: 'http', name: SERVER_NAME });
            }

            if (req.method === 'GET' && path === '/bridge-status') {
                return json(res, 200, await ScriptExecutor.bridgeStatus());
            }

            if (path === '/mcp') {
                // ponytail: first-pass remote dev endpoint; add MCP_AUTH_TOKEN enforcement before public exposure.
                const sessionId = req.headers['mcp-session-id'];
                let transport = sessionId ? transports.get(sessionId) : null;

                if (req.method === 'POST') {
                    const body = await readJson(req);
                    if (!transport && isInitializeRequest(body)) transport = await newSessionTransport();
                    if (!transport) return json(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: invalid MCP session' }, id: null });
                    return await transport.handleRequest(req, res, body);
                }

                if (!transport) return json(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: invalid MCP session' }, id: null });
                return await transport.handleRequest(req, res);
            }

            json(res, 404, { ok: false, error: 'Not found' });
        } catch (error) {
            if (!res.headersSent) json(res, 500, { ok: false, error: error.message });
        }
    });

    await new Promise((resolve) => httpServer.listen(port, host, resolve));
    if (options.log !== false) {
        console.error(`[MCP] HTTP transport listening on http://${host}:${port}/mcp`);
    }

    return {
        httpServer,
        transport: {
            close: async () => Promise.all([...transports.values()].map((transport) => transport.close())),
        },
        host,
        port,
    };
}
