let active = null;
let dirtyAfterTimeout = null;

export function getUxpBusyGateStatus() {
    return {
        busy: !!active,
        active,
        dirtyAfterTimeout
    };
}

export function markUxpDirtyAfterTimeout(reason) {
    dirtyAfterTimeout = {
        ...reason,
        since: new Date().toISOString()
    };
}

export function clearUxpDirtyAfterTimeout() {
    dirtyAfterTimeout = null;
}

export async function withUxpBusyGate(meta, fn) {
    if (dirtyAfterTimeout) {
        const error = new Error(
            'InDesign bridge is dirty after timeout; reconnect/restart or wait for late response before running more UXP work'
        );
        error.code = 'INDESIGN_BRIDGE_DIRTY';
        error.busy = true;
        error.dirtyAfterTimeout = dirtyAfterTimeout;
        throw error;
    }

    if (active) {
        const error = new Error(
            'InDesign is busy; wait for the current MCP tool call to finish before issuing another InDesign tool call'
        );
        error.code = 'INDESIGN_BUSY';
        error.busy = true;
        error.active = active;
        throw error;
    }

    active = {
        toolName: (meta && meta.toolName) || null,
        phase: (meta && meta.phase) || null,
        startedAt: new Date().toISOString()
    };

    try {
        return await fn();
    } finally {
        active = null;
    }
}
