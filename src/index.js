/**
 * Main entry point for InDesign MCP Server
 */
import { InDesignMCPServer } from './core/InDesignMCPServer.js';
import { startHttpTransport } from './core/httpTransport.js';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import net from 'net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE_PORT = 3001;

function isBridgeRunning() {
    return new Promise((resolve) => {
        const socket = net.connect(BRIDGE_PORT, '127.0.0.1');
        socket.on('connect', () => { socket.destroy(); resolve(true); });
        socket.on('error', () => resolve(false));
    });
}

function startBridge() {
    const bridgePath = join(__dirname, '../bridge/server.js');
    const child = spawn('node', [bridgePath], {
        detached: true,
        stdio: 'ignore',
    });
    child.unref();
    console.error('[MCP] Bridge server started (pid ' + child.pid + ')');
}

async function ensureBridge() {
    const running = await isBridgeRunning();
    if (!running) {
        console.error('[MCP] Bridge not running — starting it now...');
        startBridge();
        await new Promise(r => setTimeout(r, 500));
    } else {
        console.error('[MCP] Bridge already running on port ' + BRIDGE_PORT);
    }
}

async function main() {
    try {
        await ensureBridge();
        const server = new InDesignMCPServer();
        if ((process.env.MCP_TRANSPORT || 'http') === 'stdio') {
            await server.run();
        } else {
            await startHttpTransport(server);
        }
    } catch (error) {
        // Log to stderr instead of stdout to avoid interfering with MCP protocol
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

main(); 
