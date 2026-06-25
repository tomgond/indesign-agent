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
import { PageHandlers } from './pageHandlers.js';
import { DocumentHandlers } from './documentHandlers.js';

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

    /**
     * Validate common args shared by both screenshot tools.
     * Returns null on success, or a formatErrorResponse on failure.
     */
    static validateCommonArgs(args, operation) {
        if (!args || typeof args !== 'object') {
            return formatErrorResponse('Args must be an object', operation);
        }

        // outputPath: required string
        if (!args.outputPath || typeof args.outputPath !== 'string' || !args.outputPath.trim()) {
            return formatErrorResponse('outputPath is required and must be a non-empty string', operation);
        }
        try {
            const ext = path.extname(args.outputPath).toLowerCase();
            if (ext && ext !== '.png') {
                return formatErrorResponse('outputPath must have .png extension', operation);
            }
        } catch { /* resolve later */ }

        // delayMs: optional integer 0..5000
        if (args.delayMs !== undefined && args.delayMs !== null) {
            if (!Number.isInteger(args.delayMs) || args.delayMs < 0 || args.delayMs > 5000) {
                return formatErrorResponse(
                    `delayMs must be an integer between 0 and 5000, got ${JSON.stringify(args.delayMs)}`,
                    operation
                );
            }
        }

        // captureMode: only "screen"
        if (args.captureMode !== undefined && args.captureMode !== null && args.captureMode !== 'screen') {
            return formatErrorResponse(
                `captureMode must be "screen", got ${JSON.stringify(args.captureMode)}`,
                operation
            );
        }

        return null;
    }

    /**
     * Validate args specific to capture_indesign_screen_preview.
     * Returns null on success, or a formatErrorResponse on failure.
     */
    static validateInDesignArgs(args, operation) {
        const common = this.validateCommonArgs(args, operation);
        if (common) return common;

        // pageIndex: required non-negative integer
        if (args.pageIndex === undefined || args.pageIndex === null) {
            return formatErrorResponse('pageIndex is required for capture_indesign_screen_preview', operation);
        }
        if (!Number.isInteger(args.pageIndex) || args.pageIndex < 0) {
            return formatErrorResponse(
                `pageIndex must be a non-negative integer, got ${JSON.stringify(args.pageIndex)}`,
                operation
            );
        }

        // zoomMode: optional, must be valid enum value
        const validZoomModes = ['fit_page', 'fit_spread', 'none'];
        if (args.zoomMode !== undefined && args.zoomMode !== null) {
            if (!validZoomModes.includes(args.zoomMode)) {
                return formatErrorResponse(
                    `zoomMode must be one of ${validZoomModes.join(', ')}, got ${JSON.stringify(args.zoomMode)}`,
                    operation
                );
            }
        }

        return null;
    }

    // =================== OS-native capture ===================

    /**
     * macOS: screencapture CLI.
     *   screencapture -x -t png <filePath>
     * Screen Recording permission may be required for Terminal/the MCP process.
     */
    static async captureMacOS(filePath) {
        await execFileAsync('screencapture', ['-x', '-t', 'png', filePath], { timeout: 15000 });
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
     * Linux: detect available screenshot backend, then run it.
     * Returns the exact error from the command if a backend exists but fails
     * (e.g. headless/no display/permissions).
     */
    static async captureLinux(filePath) {
        // Detect available backends with command -v
        const backends = [
            { cmd: 'gnome-screenshot', args: ['-f', filePath], name: 'gnome-screenshot' },
            { cmd: 'import', args: ['-window', 'root', filePath], name: 'ImageMagick import' },
            { cmd: 'grim', args: [filePath], name: 'grim' },
        ];

        const available = [];
        const errors = [];

        for (const backend of backends) {
            try {
                await execFileAsync('which', [backend.cmd], { timeout: 3000 });
                available.push(backend);
            } catch {
                // not found, skip
            }
        }

        if (available.length === 0) {
            throw new Error(
                'No supported Linux screenshot backend found. ' +
                'Install gnome-screenshot, ImageMagick import, or grim.'
            );
        }

        // Try each available backend in order
        for (const backend of available) {
            try {
                await execFileAsync(backend.cmd, backend.args, { timeout: 10000 });
                return; // success
            } catch (err) {
                // ponytail: only keep the first available backend's stderr — it's the most actionable
                const stderr = err.stderr ? err.stderr.toString().trim() : '';
                const reason = stderr || err.message || 'unknown error';
                errors.push(`${backend.name}: ${reason}`);
            }
        }

        throw new Error(
            `All available screenshot backends failed:\n${errors.join('\n')}`
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
        const operation = 'Capture Screen Preview';

        // Validate all args before any side effects
        const validationError = this.validateCommonArgs(args, operation);
        if (validationError) return validationError;

        try {
            const outputPath = args.outputPath;
            const delayMs = args.delayMs ?? 300;

            // Normalize output path
            const normalizedPath = this.normalizePngPath(outputPath);

            // Ensure output directory
            try {
                this.ensureDirForFile(normalizedPath);
            } catch (dirErr) {
                return formatErrorResponse(
                    `Cannot create output directory: ${dirErr.message}`,
                    operation
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
                    operation
                );
            }

            // Verify the output file exists
            if (!fs.existsSync(normalizedPath)) {
                return formatErrorResponse(
                    'Screenshot command completed but output file was not created',
                    operation
                );
            }

            const stat = fs.statSync(normalizedPath);
            if (stat.size === 0) {
                return formatErrorResponse(
                    'Screenshot file was created but is empty (0 bytes)',
                    operation
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
            }, operation);
        } catch (err) {
            return formatErrorResponse(err.message, operation);
        }
    }

    /**
     * capture_indesign_screen_preview — Navigate InDesign to a page, optionally
     * fit/zoom, then take an OS-level screenshot.
     *
     * Navigation reuses PageHandlers.navigateToPage (proven UXP code path).
     * Zoom reuses DocumentHandlers.zoomToPage for fit_page.
     * fit_spread is not supported by the existing zoom handler.
     * No InDesign export APIs are used.
     */
    static async captureInDesignScreenPreview(args) {
        const operation = 'Capture InDesign Screen Preview';

        // Validate all args before any side effects or UXP execution
        const validationError = this.validateInDesignArgs(args, operation);
        if (validationError) return validationError;

        try {
            const { outputPath, pageIndex, zoomMode = 'fit_page', delayMs = 700 } = args;

            // Early check: fit_spread is not supported by the existing zoom handler.
            // Must check before any UXP calls to fail fast.
            if (zoomMode === 'fit_spread') {
                return formatErrorResponse(
                    'zoomMode "fit_spread" is not supported by the existing zoom handler. ' +
                    'Use "fit_page" or "none" instead.',
                    operation
                );
            }

            // --- Phase 1: Navigate using the proven handler ---
            const navResult = await PageHandlers.navigateToPage({ pageIndex });
            if (!navResult?.success) {
                return formatErrorResponse(
                    navResult?.result || 'Failed to navigate to page',
                    operation
                );
            }

            // --- Phase 2: Zoom using the proven handler ---
            if (zoomMode !== 'none') {
                switch (zoomMode) {
                    case 'fit_page':
                        // zoomToPage with zoomLevel=100 fits page to window at 100%
                        const fitResult = await DocumentHandlers.zoomToPage({ pageIndex, zoomLevel: 100 });
                        if (!fitResult?.success) {
                            return formatErrorResponse(
                                fitResult?.result || 'Failed to zoom to page',
                                operation
                            );
                        }
                        break;

                    // 'none' — handled above
                }
            }

            // --- Phase 3: Wait for UI to settle ---
            if (delayMs > 0) {
                await this.sleep(delayMs);
            }

            // --- Phase 4: Take the screenshot ---
            // Delegate to captureScreenPreview with delayMs=0 (we already waited)
            return await this.captureScreenPreview({
                outputPath,
                delayMs: 0,
                captureMode: 'screen',
            });
        } catch (err) {
            return formatErrorResponse(err.message, operation);
        }
    }
}