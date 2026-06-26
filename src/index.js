/**
 * Main entry point for InDesign MCP Server
 */
import { InDesignMCPServer } from './core/InDesignMCPServer.js';
import { startHttpTransport } from './core/httpTransport.js';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'node:path';
import net from 'net';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_PORT = 3001;

const BRIDGE_DIR = (dir) => dir || path.join(os.homedir(), '.indesign-agent');
const BRIDGE_PID_FILE = path.join(BRIDGE_DIR(), 'bridge.pid');

function isBridgeRunning() {
    return new Promise((resolve) => {
        const socket = net.connect(BRIDGE_PORT, '127.0.0.1');
        socket.on('connect', () => { socket.destroy(); resolve(true); });
        socket.on('error', () => resolve(false));
    });
}

function startBridge() {
    const bridgePath = path.join(__dirname, '../bridge/server.js');
    fs.mkdirSync(BRIDGE_DIR(), { recursive: true });
    const outFile = path.join(BRIDGE_DIR(), 'logs', 'bridge-stdout.log');
    const errFile = path.join(BRIDGE_DIR(), 'logs', 'bridge-stderr.log');
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const out = fs.openSync(outFile, 'a');
    const err = fs.openSync(errFile, 'a');
    const child = spawn('node', [bridgePath], {
        detached: true,
        stdio: ['ignore', out, err],
    });
    fs.writeFileSync(BRIDGE_PID_FILE, String(child.pid));
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
