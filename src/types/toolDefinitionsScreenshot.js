/**
 * Screenshot tool definitions for InDesign MCP Server
 * OS-level screen capture tools for visual debugging
 *
 * These tools capture what is visible on the monitor, NOT an InDesign export.
 * Use for the agent visual debug loop; use export_images / export_pdf for
 * production export sanity checks.
 */

export const screenshotToolDefinitions = [
    {
        name: 'capture_screen_preview',
        description: 'Capture the current visible desktop/app screen as a PNG for vision-model review. This is an OS-level screenshot, not an InDesign export. Does not call doc.exportFile() or any export preferences.',
        inputSchema: {
            type: 'object',
            properties: {
                outputPath: {
                    type: 'string',
                    description: 'Output PNG file path. When a template workspace is active, this must resolve inside the workspace exports directory.',
                },
                delayMs: {
                    type: 'integer',
                    default: 300,
                    minimum: 0,
                    maximum: 5000,
                    description: 'Delay in ms before screenshot, to allow UI repaint after navigation/zoom.',
                },
                captureMode: {
                    type: 'string',
                    enum: ['screen'],
                    default: 'screen',
                    description: 'Currently only full-screen capture is supported.',
                },
            },
            required: ['outputPath'],
        },
    },
    {
        name: 'capture_indesign_screen_preview',
        description: 'Navigate InDesign to a page, optionally fit/zoom the page, then take an OS-level screenshot of the current visible screen. Uses OS screenshot capture, not InDesign export.',
        inputSchema: {
            type: 'object',
            properties: {
                outputPath: {
                    type: 'string',
                    description: 'Output PNG file path under workspace exports when a template workspace is active.',
                },
                pageIndex: {
                    type: 'integer',
                    minimum: 0,
                    description: 'Zero-based target page index to show before screenshot.',
                },
                zoomMode: {
                    type: 'string',
                    enum: ['fit_page', 'fit_spread', 'actual_size', 'none'],
                    default: 'fit_page',
                    description: 'Zoom behavior after navigation. fit_page = fit page to window. fit_spread = fit spread to window. actual_size = 100% zoom. none = no zoom change.',
                },
                delayMs: {
                    type: 'integer',
                    default: 700,
                    minimum: 0,
                    maximum: 5000,
                    description: 'Delay in ms after navigation/zoom before screenshot.',
                },
            },
            required: ['outputPath', 'pageIndex'],
        },
    },
];