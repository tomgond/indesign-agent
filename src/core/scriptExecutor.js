/**
 * Core script execution functionality
 */
export const BRIDGE_URL = process.env.BRIDGE_URL || 'http://127.0.0.1:3000';

// L1: read auth token from env — must match BRIDGE_TOKEN set when starting bridge/server.js
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || null;

function bridgeHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (BRIDGE_TOKEN) headers['Authorization'] = `Bearer ${BRIDGE_TOKEN}`;
    return headers;
}

export class ScriptExecutor {
    /**
     * Execute JS code inside InDesign via the UXP bridge
     * @param {string} code - JS code with `app` in scope (UXP InDesign API)
     * @returns {any} The serialized result
     */
    static async executeViaUXP(code) {
        let response;
        try {
            // L5: 35s timeout — slightly longer than bridge's 30s execution timeout so we
            // get the bridge's own error message rather than a generic fetch abort
            response = await fetch(`${BRIDGE_URL}/execute`, {
                method: 'POST',
                headers: bridgeHeaders(),
                body: JSON.stringify({ code }),
                signal: AbortSignal.timeout(35000),
            });
        } catch (err) {
            // Fast-fail with a clear message when the bridge process isn't running (L5)
            if (err.name === 'TimeoutError' || err.name === 'TypeError' || err.code === 'ECONNREFUSED') {
                throw new Error(
                    'Bridge not reachable. Start it first: cd bridge && node server.js'
                );
            }
            throw err;
        }

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || `Bridge error: ${response.status}`);
        }

        return data.result;
    }

    /**
     * Check if the UXP bridge is running and plugin is connected
     * @returns {boolean}
     */
    static async isUXPAvailable() {
        try {
            const status = await ScriptExecutor.bridgeStatus();
            return status.pluginConnected === true;
        } catch {
            return false;
        }
    }

    static async bridgeStatus() {
        try {
            const response = await fetch(`${BRIDGE_URL}/status`, {
                headers: bridgeHeaders(),
                signal: AbortSignal.timeout(1000),
            });
            const data = await response.json();
            return {
                ok: response.ok,
                bridgeUrl: BRIDGE_URL,
                pluginConnected: data.connected === true,
            };
        } catch (error) {
            return {
                ok: false,
                bridgeUrl: BRIDGE_URL,
                pluginConnected: false,
                error: error.message,
            };
        }
    }

}
