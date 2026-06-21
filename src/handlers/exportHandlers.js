/**
 * Export handlers
 */
import fs from 'node:fs';
import path from 'node:path';
import { ScriptExecutor } from '../core/scriptExecutor.js';
import { formatResponse, formatErrorResponse } from '../utils/stringUtils.js';

export class ExportHandlers {
    static ensureDirForFile(filePath) {
        if (!filePath) throw new Error('filePath is required');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }

    static ensureDir(dirPath) {
        if (!dirPath) throw new Error('outputPath is required');
        fs.mkdirSync(dirPath, { recursive: true });
    }

    /**
     * Export document to PDF
     */
    static async exportPDF(args) {
        const {
            filePath,
            preset = 'High Quality Print',
        } = args;

        try { this.ensureDirForFile(filePath); } catch (error) { return formatErrorResponse(error.message, "Export PDF"); }

        const code = `
            const { ExportFormat } = require('indesign');
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = app.activeDocument;
            try {
                await doc.exportFile(ExportFormat.pdfType, ${JSON.stringify(filePath)}, false, ${JSON.stringify(preset)});
                return { success: true, message: 'PDF exported to ' + ${JSON.stringify(filePath)} };
            } catch(e) {
                return { success: false, error: 'Export failed: ' + e.message };
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success ?
            formatResponse(result.message, "Export PDF") :
            formatErrorResponse(result?.error || 'Failed to export PDF', "Export PDF");
    }

    /**
     * Export pages as images
     */
    static async exportImages(args) {
        const {
            outputPath,
            folderPath,
            format = 'JPEG',
            quality = 80,
            resolution = 300,
            pages,
            pageRange
        } = args;

        const targetFolder = outputPath || folderPath;
        const range = pages || pageRange || 'all';

        // M4: validate pageRange entries before sending to UXP — invalid entries were
        // silently skipped, returning a count lower than expected with no error reported
        if (range !== 'all') {
            const entries = range.split(',');
            const invalid = entries.filter(p => {
                const n = parseInt(p.trim(), 10);
                return isNaN(n) || n < 1;
            });
            if (invalid.length > 0) {
                return formatErrorResponse(
                    `Invalid page range entries (must be positive integers): ${invalid.join(', ')}`,
                    "Export Images"
                );
            }
        }

        try { this.ensureDir(targetFolder); } catch (error) { return formatErrorResponse(error.message, "Export Images"); }

        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = app.activeDocument;
            const folderPath = ${JSON.stringify(targetFolder)};

            try {
                const formatStr = ${JSON.stringify(format)};
                let exportFormat;
                if (formatStr === 'JPEG') {
                    exportFormat = 'jpg';
                } else if (formatStr === 'PNG') {
                    exportFormat = 'png';
                } else if (formatStr === 'TIFF') {
                    exportFormat = 'tif';
                } else {
                    return { success: false, error: 'Unsupported export format: ' + formatStr };
                }

                const ext = exportFormat;
                const pageRangeStr = ${JSON.stringify(range)};
                let exportedCount = 0;
                function configureExport(pageNum) {
                    try {
                        if (formatStr === 'JPEG' && app.jpegExportPreferences) {
                            app.jpegExportPreferences.exportResolution = ${resolution};
                            app.jpegExportPreferences.jpegQuality = ${quality};
                            app.jpegExportPreferences.pageString = String(pageNum);
                        }
                        if (formatStr === 'PNG' && app.pngExportPreferences) {
                            app.pngExportPreferences.exportResolution = ${resolution};
                            app.pngExportPreferences.pageString = String(pageNum);
                        }
                    } catch(e) {}
                }

                if (pageRangeStr !== 'all') {
                    const pages = pageRangeStr.split(',');
                    for (let i = 0; i < pages.length; i++) {
                        const pageNum = parseInt(pages[i]) - 1;
                        if (pageNum >= 0 && pageNum < doc.pages.length) {
                            const fileName = folderPath + '/page_' + (pageNum + 1) + '.' + ext;
                            configureExport(pageNum + 1);
                            await doc.exportFile(exportFormat, fileName, false);
                            exportedCount++;
                        }
                    }
                } else {
                    for (let i = 0; i < doc.pages.length; i++) {
                        const fileName = folderPath + '/page_' + (i + 1) + '.' + ext;
                        configureExport(i + 1);
                        await doc.exportFile(exportFormat, fileName, false);
                        exportedCount++;
                    }
                }

                return { success: true, count: exportedCount };
            } catch(e) {
                return { success: false, error: 'Error exporting images: ' + e.message };
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success ?
            formatResponse(`${result.count} pages exported as ${format} images to: ${targetFolder}`, "Export Images") :
            formatErrorResponse(result?.error || 'Failed to export images', "Export Images");
    }

    /**
     * Package document for printing
     */
    static async packageDocument(args) {
        const { outputPath, folderPath, includeFonts = true, includeLinks = true, includeProfiles = true } = args;
        const targetFolder = outputPath || folderPath;

        try { this.ensureDir(targetFolder); } catch (error) { return formatErrorResponse(error.message, "Package Document"); }

        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = app.activeDocument;

            try {
                const args = [
                    ${includeFonts}, ${includeLinks}, ${includeProfiles},
                    false, false, true, true, false, false, '', false, '', false
                ];
                try {
                    doc.packageForPrint(${JSON.stringify(targetFolder)}, ...args);
                } catch (firstError) {
                    const { localFileSystem } = require('uxp').storage;
                    const folderUrl = 'file:' + ${JSON.stringify(targetFolder)};
                    const folder = await localFileSystem.getEntryWithUrl(folderUrl);
                    doc.packageForPrint(folder, ...args);
                }
                return { success: true };
            } catch(e) {
                return { success: false, error: 'Error packaging document: ' + e.message };
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success ?
            formatResponse(`Document packaged successfully to: ${targetFolder}`, "Package Document") :
            formatErrorResponse(result?.error || 'Failed to package document', "Package Document");
    }
} 
