/**
 * Utility tool definitions for InDesign MCP Server
 * Utility functions and custom execution capabilities
 */

export const utilityToolDefinitions = [
    // =================== UTILITY TOOLS ===================
    {
        name: 'execute_indesign_code',
        description: 'Disabled by default. Executes arbitrary JavaScript code in the InDesign UXP context only when ALLOW_EXECUTE_INDESIGN_CODE=true is set for local development.',
        inputSchema: {
            type: 'object',
            properties: {
                code: { type: 'string', description: 'JavaScript code to execute in UXP context. Has access to `app` (InDesign application object).' },
                dangerousConfirmation: {
                    type: 'string',
                    description: 'Must be exactly: "I understand this executes arbitrary InDesign code"',
                },
            },
            required: ['code', 'dangerousConfirmation'],
        },
    },
    {
        name: 'view_document',
        description: 'View document information and current state',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'get_session_info',
        description: 'Get current session information including page dimensions and active document',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'clear_session',
        description: 'Clear all session data including page dimensions and document information',
        inputSchema: { type: 'object', properties: {} },
    },
]; 
