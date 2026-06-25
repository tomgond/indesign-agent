/**
 * Screenshot handlers — OS-level screen capture for visual debugging.
 *
 * These tools capture what is visible on the monitor, NOT an InDesign
 * export/rendering. Use for the visual debug loop; use export_images /
 * export_pdf for production export sanity checks.
 *
 * No InDesign export APIs, no jpegExportPreferences, no pngExportPreferences,
 * no doc.exportFile() calls.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ScriptExecutor } from '../core/scriptExecutor.js';
import { formatResponse, formatErrorResponse } from '../utils/stringUtils.js';

const execFileAsync = promisify(execFile);

export class ScreenshotHandlers {
    /**
     * Validate and normalize outputPath to end in .png.
     */
    static normalizePngPath(outputPath) {
        if (!outputPath || typeof outputPath !== 'string') {
            throw new Error('outputPath is required and must be a string');
        }
        const ext = path.extname(outputPath).toLowerCase();
        if (ext && ext !== '.png') {
            throw new Error('outputPath must have .png extension');
        }
        return ext === '.png' ? path.resolve(outputPath) : path.resolve(outputPath + '.png');
    }

    /**
     * Ensure the parent directory for filePath exists.
     */
    static ensureDirForFile(filePath) {
        if (!filePath) throw new Error('filePath is required');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }

    /**
     * Sleep for ms milliseconds.
     */
    static async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // =================== OS-native capture ===================

    /**
     * macOS: screencapture CLI.
     *   screencapture -x -t png <filePath>
     * Screen Recording permission may be required for Terminal/the MCP process.
     */
    static async captureMacOS(filePath) {
        await execFileAsync('screencapture', ['-x', '-t', 'png', filePath], { timeout: 30000 });
    }

    /**
     * Windows: PowerShell with System.Windows.Forms + System.Drawing.
     * Captures the primary screen bounds to a PNG.
     */
    static async captureWindows(filePath) {
        // JSON-stringify the path to prevent shell injection inside the -Command string
        const safePath = JSON.stringify(path.resolve(filePath));
        const script = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing;
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height;
$gfx = [System.Drawing.Graphics]::FromImage($bmp);
$gfx.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size);
$bmp.Save(${safePath}, [System.Drawing.Imaging.ImageFormat]::Png);
$gfx.Dispose();
$bmp.Dispose();
`;
        await execFileAsync('powershell.exe', [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script
        ], { timeout: 30000 });
    }

    /**
     * Linux: best-effort screenshot backends.
     *   - gnome-screenshot (GNOME)
     *   - import        (ImageMagick)
     *   - grim          (wlroots-based Wayland)
     */
    static async captureLinux(filePath) {
        // Try gnome-screenshot first
        try {
            await execFileAsync('gnome-screenshot', ['-f', filePath], { timeout: 15000 });
            return;
        } catch { /* fall through */ }

        // Try ImageMagick import
        try {
            await execFileAsync('import', ['-window', 'root', filePath], { timeout: 15000 });
            return;
        } catch { /* fall through */ }

        // Try grim (wlroots Wayland)
        try {
            await execFileAsync('grim', [filePath], { timeout: 15000 });
            return;
        } catch { /* fall through */ }

        throw new Error(
            'No supported Linux screenshot backend found. ' +
            'Install gnome-screenshot, ImageMagick import, or grim.'
        );
    }

    /**
     * Dispatch to the correct OS capture function.
     */
    static async captureOSScreen(filePath) {
        const platform = os.platform();
        switch (platform) {
            case 'darwin':
                await this.captureMacOS(filePath);
                break;
            case 'win32':
                await this.captureWindows(filePath);
                break;
            case 'linux':
                await this.captureLinux(filePath);
                break;
            default:
                throw new Error(`Unsupported platform: ${platform}. Screenshot capture is only available on macOS, Windows, and Linux.`);
        }
    }

    // =================== Tool handlers ===================

    /**
     * capture_screen_preview — OS-level screenshot of the current visible screen.
     */
    static async captureScreenPreview(args) {
        const {
            outputPath,
            delayMs = 300,
            captureMode = 'screen',
        } = args || {};

        try {
            // Validate capture mode
            if (captureMode !== 'screen') {
                return formatErrorResponse(
                    `Unsupported captureMode: "${captureMode}". Only "screen" is supported.`,
                    'Capture Screen Preview'
                );
            }

            // Normalize output path
            const normalizedPath = this.normalizePngPath(outputPath);

            // Ensure output directory
            try {
                this.ensureDirForFile(normalizedPath);
            } catch (dirErr) {
                return formatErrorResponse(
                    `Cannot create output directory: ${dirErr.message}`,
                    'Capture Screen Preview'
                );
            }

            // Apply delay
            if (delayMs > 0) {
                await this.sleep(delayMs);
            }

            // Capture
            const platform = os.platform();
            try {
                await this.captureOSScreen(normalizedPath);
            } catch (captureErr) {
                const note = platform === 'darwin'
                    ? ' (Note: macOS may require Screen Recording permission for Terminal/the MCP process in System Settings > Privacy & Security > Screen Recording)'
                    : '';
                return formatErrorResponse(
                    `Screenshot capture failed: ${captureErr.message}${note}`,
                    'Capture Screen Preview'
                );
            }

            // Verify the output file exists
            if (!fs.existsSync(normalizedPath)) {
                return formatErrorResponse(
                    'Screenshot command completed but output file was not created',
                    'Capture Screen Preview'
                );
            }

            const stat = fs.statSync(normalizedPath);
            if (stat.size === 0) {
                return formatErrorResponse(
                    'Screenshot file was created but is empty (0 bytes)',
                    'Capture Screen Preview'
                );
            }

            return formatResponse({
                success: true,
                filePath: normalizedPath,
                sizeBytes: stat.size,
                kind: 'screen_capture',
                note: 'OS-level screenshot; not an InDesign export',
                platform,
                capturedAt: new Date().toISOString(),
            }, 'Capture Screen Preview');
        } catch (err) {
            return formatErrorResponse(err.message, 'Capture Screen Preview');
        }
    }

    /**
     * capture_indesign_screen_preview — Navigate InDesign to a page, optionally
     * fit/zoom, then take an OS-level screenshot.
     *
     * This uses UXP code to navigate and zoom inside InDesign, then calls
     * captureScreenPreview for the screenshot. No InDesign export APIs are used.
     */
    static async captureInDesignScreenPreview(args) {
        const {
            outputPath,
            pageIndex,
            zoomMode = 'fit_page',
            delayMs = 700,
        } = args || {};

        try {
            // --- Phase 1: Navigate and zoom inside InDesign ---
            // Build UXP code for navigation and zoom
            const uxpCodeParts = [];

            if (pageIndex !== undefined && pageIndex !== null) {
                uxpCodeParts.push(`
                    if (app.documents.length === 0) {
                        return { success: false, error: 'No document open' };
                    }
                    const doc = app.activeDocument;
                    if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) {
                        return { success: false, error: 'Page index out of range' };
                    }
                    const page = doc.pages.item(${pageIndex});
                    page.select();
                `);

                // Zoom after navigation
                if (zoomMode && zoomMode !== 'none') {
                    switch (zoomMode) {
                        case 'fit_page':
                            // InDesign UXP: zoomToFit with a zoom level that fits the page
                            uxpCodeParts.push(`
                                try {
                                    page.zoomToFit();
                                } catch(e) {
                                    // fallback: set zoom to 100%
                                    if (app.activeWindow) {
                                        app.activeWindow.zoomPercentage = 100;
                                    }
                                }
                            `);
                            break;
                        case 'fit_spread':
                            uxpCodeParts.push(`
                                try {
                                    const spread = page.parent;
                                    if (spread && app.activeWindow) {
                                        app.activeWindow.zoomPercentage = Math.min(
                                            100,
                                            Math.floor(
                                                (app.activeWindow.screenDrawingWidth / spread.bounds[3]) * 100
                                            )
                                        );
                                    }
                                } catch(e) {
                                    // fallback if spread zoom fails
                                }
                            `);
                            break;
                        case 'actual_size':
                            uxpCodeParts.push(`
                                try {
                                    if (app.activeWindow) {
                                        app.activeWindow.zoomPercentage = 100;
                                    }
                                } catch(e) {}
                            `);
                            break;
                        // 'none' — skipped above
                    }
                }
            }

            // If we have UXP commands, execute them
            if (uxpCodeParts.length > 0) {
                const uxpCode = uxpCodeParts.join('\n') + `
                    return { success: true };
                `;

                const result = await ScriptExecutor.executeViaUXP(uxpCode);
                if (!result?.success) {
                    return formatErrorResponse(
                        result?.error || 'Failed to navigate/zoom in InDesign',
                        'Capture InDesign Screen Preview'
                    );
                }
            }

            // --- Phase 2: Wait for UI to settle ---
            if (delayMs > 0) {
                await this.sleep(delayMs);
            }

            // --- Phase 3: Take the screenshot ---
            // Delegate to captureScreenPreview with delayMs=0 (we already waited)
            return await this.captureScreenPreview({
                outputPath,
                delayMs: 0,
                captureMode: 'screen',
            });
        } catch (err) {
            return formatErrorResponse(err.message, 'Capture InDesign Screen Preview');
        }
    }
}