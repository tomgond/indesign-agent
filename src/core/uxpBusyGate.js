let active = null;

export function getUxpBusyGateStatus() {
    return {
        busy: !!active,
        active
    };
}

export async function withUxpBusyGate(meta, fn) {
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
