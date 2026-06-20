/**
 * Export handlers
 */
import { ScriptExecutor } from '../core/scriptExecutor.js';
import { formatResponse, formatErrorResponse, escapeJsxString } from '../utils/stringUtils.js';

export class ExportHandlers {
    /**
     * Export document to PDF
     */
    static async exportPDF(args) {
        const {
            filePath,
            preset = 'High Quality Print',
        } = args;

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

        const formatLower = format.toLowerCase();

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

        const code = `
            const { ExportFormat } = require('indesign');
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = app.activeDocument;
            const folder = ${JSON.stringify(targetFolder)};

            try {
                const formatStr = ${JSON.stringify(format)};
                let exportFormat;
                if (formatStr === 'JPEG') {
                    exportFormat = ExportFormat.jpegType;
                } else if (formatStr === 'PNG') {
                    exportFormat = ExportFormat.pngType;
                } else if (formatStr === 'TIFF') {
                    exportFormat = ExportFormat.tiffType;
                } else {
                    exportFormat = ExportFormat.jpegType;
                }

                const ext = ${JSON.stringify(formatLower)};
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
                            const fileName = folder + '/page_' + (pageNum + 1) + '.' + ext;
                            configureExport(pageNum + 1);
                            await doc.exportFile(exportFormat, fileName, false);
                            exportedCount++;
                        }
                    }
                } else {
                    for (let i = 0; i < doc.pages.length; i++) {
                        const fileName = folder + '/page_' + (i + 1) + '.' + ext;
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

        const code = `
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = app.activeDocument;

            try {
                doc.packageForPrint(
                    ${JSON.stringify(targetFolder)},
                    ${includeFonts},
                    ${includeLinks},
                    ${includeProfiles},
                    false,
                    false,
                    true
                );
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
