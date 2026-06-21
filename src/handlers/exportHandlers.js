/**
 * Export handlers
 */
import { ScriptExecutor } from '../core/scriptExecutor.js';
import { formatResponse, formatErrorResponse } from '../utils/stringUtils.js';

export class ExportHandlers {
    static pathHelper = `
            function normalizeFileTarget(targetPath) {
                try {
                    const file = targetPath instanceof File ? targetPath : new File(String(targetPath));
                    return { success: true, file };
                } catch (e) {
                    return { success: false, error: 'Invalid file path: ' + e.message };
                }
            }

            function normalizeFolderTarget(targetPath) {
                try {
                    const folder = targetPath instanceof Folder ? targetPath : new Folder(String(targetPath));
                    return { success: true, folder };
                } catch (e) {
                    return { success: false, error: 'Invalid directory path: ' + e.message };
                }
            }

            function ensureFolderExists(folder) {
                if (!folder) return { success: false, error: 'No directory target provided' };
                try {
                    if (folder.exists) return { success: true, folder };
                    const parent = folder.parent;
                    if (parent && parent !== folder && !parent.exists) {
                        const parentResult = ensureFolderExists(parent);
                        if (!parentResult.success) return parentResult;
                    }
                    if (!folder.create() && !folder.exists) {
                        return { success: false, error: 'Failed to create directory: ' + folder.fsName };
                    }
                    return { success: true, folder };
                } catch (e) {
                    return { success: false, error: 'Failed to create directory: ' + folder.fsName + ' (' + e.message + ')' };
                }
            }

            function prepareFileTarget(targetPath) {
                const fileResult = normalizeFileTarget(targetPath);
                if (!fileResult.success) return { success: false, error: fileResult.error };
                const parentResult = ensureFolderExists(fileResult.file.parent);
                if (!parentResult.success) return { success: false, error: parentResult.error };
                return { success: true, file: fileResult.file };
            }

            function prepareFolderTarget(targetPath) {
                const folderResult = normalizeFolderTarget(targetPath);
                if (!folderResult.success) return { success: false, error: folderResult.error };
                return ensureFolderExists(folderResult.folder);
            }
        `;

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
            ${ExportHandlers.pathHelper}
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = app.activeDocument;
            try {
                const target = prepareFileTarget(${JSON.stringify(filePath)});
                if (!target.success) {
                    return { success: false, error: 'Failed to prepare export path: ' + target.error };
                }
                await doc.exportFile(ExportFormat.pdfType, target.file, false, ${JSON.stringify(preset)});
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

        const code = `
            ${ExportHandlers.pathHelper}
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = app.activeDocument;
            const folderPath = ${JSON.stringify(targetFolder)};

            try {
                const folderResult = prepareFolderTarget(folderPath);
                if (!folderResult.success) {
                    return { success: false, error: 'Failed to prepare export directory: ' + folderResult.error };
                }
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
                            const fileName = folderResult.folder.fsName + '/page_' + (pageNum + 1) + '.' + ext;
                            configureExport(pageNum + 1);
                            const target = prepareFileTarget(fileName);
                            if (!target.success) {
                                return { success: false, error: 'Failed to prepare image export path: ' + target.error };
                            }
                            await doc.exportFile(exportFormat, target.file, false);
                            exportedCount++;
                        }
                    }
                } else {
                    for (let i = 0; i < doc.pages.length; i++) {
                        const fileName = folderResult.folder.fsName + '/page_' + (i + 1) + '.' + ext;
                        configureExport(i + 1);
                        const target = prepareFileTarget(fileName);
                        if (!target.success) {
                            return { success: false, error: 'Failed to prepare image export path: ' + target.error };
                        }
                        await doc.exportFile(exportFormat, target.file, false);
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
            ${ExportHandlers.pathHelper}
            if (app.documents.length === 0) {
                return { success: false, error: 'No document open' };
            }
            const doc = app.activeDocument;

            try {
                const folderResult = prepareFolderTarget(${JSON.stringify(targetFolder)});
                if (!folderResult.success) {
                    return { success: false, error: 'Failed to prepare package directory: ' + folderResult.error };
                }

                doc.packageForPrint(
                    folderResult.folder,
                    ${includeFonts},
                    ${includeLinks},
                    ${includeProfiles},
                    false,
                    false,
                    true,
                    true,
                    false,
                    false,
                    '',
                    false,
                    '',
                    false
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
