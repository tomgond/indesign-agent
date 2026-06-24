/**
 * Page management handlers
 */
import { ScriptExecutor } from '../core/scriptExecutor.js';
import { formatResponse, formatErrorResponse } from '../utils/stringUtils.js';

export class PageHandlers {
    /**
     * Add a new page to the document
     */
    static async addPage(args) {
        const { position = 'AT_END', referencePage = 0 } = args;

        const code = `
            const { LocationOptions } = require('indesign');
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            const locMap = {
                AT_END: LocationOptions.atEnd,
                AT_BEGINNING: LocationOptions.atBeginning,
                BEFORE: LocationOptions.before,
                AFTER: LocationOptions.after
            };
            const loc = locMap[${JSON.stringify(position)}] || LocationOptions.atEnd;
            const refPage = doc.pages.item(${referencePage});
            const page = doc.pages.add(loc, refPage);
            return { success: true, pageIndex: page.documentOffset, name: page.name, totalPages: doc.pages.length };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Add Page")
            : formatErrorResponse(result?.error || 'Failed to add page', "Add Page");
    }

    /**
     * Get detailed information about a specific page
     */
    static async getPageInfo(args) {
        const { pageIndex } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            return {
                success: true,
                index: page.documentOffset,
                name: page.name,
                label: page.label,
                bounds: page.bounds,
                side: String(page.side),
                appliedMaster: page.appliedMaster ? page.appliedMaster.name : 'None',
                pageColor: String(page.pageColor),
                optionalPage: page.optionalPage,
                layoutRule: String(page.layoutRule)
            };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Get Page Info")
            : formatErrorResponse(result?.error || 'Failed to get page info', "Get Page Info");
    }

    /**
     * Navigate to a specific page
     */
    static async navigateToPage(args) {
        const { pageIndex } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            doc.pages.item(${pageIndex}).select();
            return { success: true, pageIndex: ${pageIndex} };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Navigate to Page")
            : formatErrorResponse(result?.error || 'Failed to navigate to page', "Navigate to Page");
    }

    /**
     * Delete a specific page from the document
     */
    static async deletePage(args) {
        const { pageIndex } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            doc.pages.item(${pageIndex}).remove();
            return { success: true, totalPages: doc.pages.length };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Delete Page")
            : formatErrorResponse(result?.error || 'Failed to delete page', "Delete Page");
    }

    /**
     * Duplicate a specific page
     */
    static async duplicatePage(args) {
        const { pageIndex } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const originalPage = doc.pages.item(${pageIndex});
            const newPage = originalPage.duplicate();
            return { success: true, newPageIndex: newPage.documentOffset, totalPages: doc.pages.length };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Duplicate Page")
            : formatErrorResponse(result?.error || 'Failed to duplicate page', "Duplicate Page");
    }

    /**
     * Move a page to a different position
     */
    static async movePage(args) {
        const { pageIndex, newPosition } = args;

        const code = `
            const { LocationOptions } = require('indesign');
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            const locMap = {
                AT_END: LocationOptions.atEnd,
                AT_BEGINNING: LocationOptions.atBeginning,
                BEFORE: LocationOptions.before,
                AFTER: LocationOptions.after
            };
            const loc = locMap[${JSON.stringify(newPosition)}] || LocationOptions.atEnd;
            page.move(loc);
            return { success: true, pageIndex: page.documentOffset };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Move Page")
            : formatErrorResponse(result?.error || 'Failed to move page', "Move Page");
    }

    /**
     * Get all pages in the document
     */
    static async getAllPages(args) {
        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            const pages = [];
            for (let i = 0; i < doc.pages.length; i++) {
                const page = doc.pages.item(i);
                pages.push({
                    index: i,
                    name: page.name,
                    label: page.label,
                    appliedMaster: page.appliedMaster ? page.appliedMaster.name : 'None'
                });
            }
            return { success: true, totalPages: doc.pages.length, pages };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Get All Pages")
            : formatErrorResponse(result?.error || 'Failed to get pages', "Get All Pages");
    }

    // =================== ADVANCED PAGE PROPERTIES ===================

    /**
     * Set properties for a page
     */
    static async setPageProperties(args) {
        const { pageIndex, label, pageColor, optionalPage, layoutRule, snapshotBlendingMode, appliedTrapPreset } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            ${label !== undefined ? `page.label = ${JSON.stringify(label)};` : ''}
            ${pageColor !== undefined ? `page.pageColor = ${JSON.stringify(pageColor)};` : ''}
            ${optionalPage !== undefined ? `page.optionalPage = ${optionalPage};` : ''}
            ${layoutRule !== undefined ? `page.layoutRule = ${JSON.stringify(layoutRule)};` : ''}
            ${snapshotBlendingMode !== undefined ? `page.snapshotBlendingMode = ${JSON.stringify(snapshotBlendingMode)};` : ''}
            ${appliedTrapPreset !== undefined ? `page.appliedTrapPreset = ${JSON.stringify(appliedTrapPreset)};` : ''}
            return { success: true };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Set Page Properties")
            : formatErrorResponse(result?.error || 'Failed to set page properties', "Set Page Properties");
    }

    /**
     * Adjust page layout with new dimensions and margins
     */
    static async adjustPageLayout(args) {
        const {
            pageIndex, width, height,
            bleedInside, bleedTop, bleedOutside, bleedBottom,
            leftMargin, topMargin, rightMargin, bottomMargin
        } = args;

        const code = `
            const { CoordinateSpaces, AnchorPoint, ResizeMethods } = require('indesign');
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            ${width !== undefined ? `page.resize(CoordinateSpaces.pasteboardCoordinates, AnchorPoint.centerAnchor, ResizeMethods.replacingCurrentDimensionsWith, ${width}, ${height !== undefined ? height : width});` : ''}
            ${leftMargin !== undefined ? `page.marginPreferences.left = ${leftMargin};` : ''}
            ${topMargin !== undefined ? `page.marginPreferences.top = ${topMargin};` : ''}
            ${rightMargin !== undefined ? `page.marginPreferences.right = ${rightMargin};` : ''}
            ${bottomMargin !== undefined ? `page.marginPreferences.bottom = ${bottomMargin};` : ''}
            ${bleedInside !== undefined ? `page.bleedBoxPreferences.inside = ${bleedInside};` : ''}
            ${bleedTop !== undefined ? `page.bleedBoxPreferences.top = ${bleedTop};` : ''}
            ${bleedOutside !== undefined ? `page.bleedBoxPreferences.outside = ${bleedOutside};` : ''}
            ${bleedBottom !== undefined ? `page.bleedBoxPreferences.bottom = ${bleedBottom};` : ''}
            return { success: true };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Adjust Page Layout")
            : formatErrorResponse(result?.error || 'Failed to adjust page layout', "Adjust Page Layout");
    }

    /**
     * Resize a page
     */
    static async resizePage(args) {
        const {
            pageIndex, width, height,
            resizeMethod = 'replacingCurrentDimensionsWith',
            anchorPoint = 'centerAnchor',
            coordinateSpace = 'pasteboardCoordinates'
        } = args;

        const code = `
            const { CoordinateSpaces, AnchorPoint, ResizeMethods } = require('indesign');
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            page.resize(
                CoordinateSpaces[${JSON.stringify(coordinateSpace)}],
                AnchorPoint[${JSON.stringify(anchorPoint)}],
                ResizeMethods[${JSON.stringify(resizeMethod)}],
                ${width},
                ${height}
            );
            return { success: true };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Resize Page")
            : formatErrorResponse(result?.error || 'Failed to resize page', "Resize Page");
    }

    /**
     * Place a file on a page
     */
    static async placeFileOnPage(args) {
        const { pageIndex, filePath, x = 10, y = 10, layerName, showingOptions = false, autoflowing = false } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            ${layerName !== undefined ? `const layer = doc.layers.itemByName(${JSON.stringify(layerName)});` : ''}
            const placedItems = page.place(${JSON.stringify(filePath)}, [${x}, ${y}], ${showingOptions}, ${autoflowing}${layerName !== undefined ? ', layer' : ''});
            return { success: true, itemCount: placedItems ? placedItems.length : 1 };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Place File on Page")
            : formatErrorResponse(result?.error || 'Failed to place file on page', "Place File on Page");
    }

    /**
     * Place XML content on a page
     */
    static async placeXmlOnPage(args) {
        const { pageIndex, xmlElementName, x = 10, y = 10, autoflowing = false } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            const xmlElement = doc.xmlElements.itemByName(${JSON.stringify(xmlElementName)});
            const placedItem = page.place(xmlElement, [${x}, ${y}], false, ${autoflowing});
            return { success: true };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Place XML on Page")
            : formatErrorResponse(result?.error || 'Failed to place XML on page', "Place XML on Page");
    }

    /**
     * Create a snapshot of the current page layout
     */
    static async snapshotPageLayout(args) {
        const { pageIndex } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            page.createLayoutSnapshot();
            return { success: true };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Snapshot Page Layout")
            : formatErrorResponse(result?.error || 'Failed to create snapshot', "Snapshot Page Layout");
    }

    /**
     * Delete the layout snapshot for a page
     */
    static async deletePageLayoutSnapshot(args) {
        const { pageIndex } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            page.deleteLayoutSnapshot();
            return { success: true };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Delete Page Layout Snapshot")
            : formatErrorResponse(result?.error || 'Failed to delete snapshot', "Delete Page Layout Snapshot");
    }

    /**
     * Delete all layout snapshots for a page
     */
    static async deleteAllPageLayoutSnapshots(args) {
        const { pageIndex } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            page.deleteAllLayoutSnapshots();
            return { success: true };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Delete All Page Layout Snapshots")
            : formatErrorResponse(result?.error || 'Failed to delete all snapshots', "Delete All Page Layout Snapshots");
    }

    /**
     * Reframe (resize) a page
     */
    static async reframePage(args) {
        const { pageIndex, x1, y1, x2, y2, coordinateSpace = 'pasteboardCoordinates' } = args;

        const code = `
            const { CoordinateSpaces } = require('indesign');
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            page.reframe(CoordinateSpaces[${JSON.stringify(coordinateSpace)}], [${x1}, ${y1}, ${x2}, ${y2}]);
            return { success: true };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Reframe Page")
            : formatErrorResponse(result?.error || 'Failed to reframe page', "Reframe Page");
    }

    /**
     * Create guides on a page
     */
    static async createPageGuides(args) {
        const {
            pageIndex,
            numberOfRows = 0,
            numberOfColumns = 0,
            rowGutter = 5,
            columnGutter = 5,
            guideColor = 'blue',
            fitMargins = true,
            removeExisting = false,
            layerName
        } = args;

        const code = `
            const { GuideColor } = require('indesign');
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            ${removeExisting ? 'page.guides.everyItem().remove();' : ''}
            ${layerName !== undefined ? `const layer = doc.layers.itemByName(${JSON.stringify(layerName)});` : ''}
            const color = GuideColor[${JSON.stringify(guideColor.toLowerCase())}] || GuideColor.blue;
            page.createGuides(${numberOfRows}, ${numberOfColumns}, ${rowGutter}, ${columnGutter}, color, ${fitMargins}${layerName !== undefined ? ', layer' : ''});
            return { success: true };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Create Page Guides")
            : formatErrorResponse(result?.error || 'Failed to create page guides', "Create Page Guides");
    }

    /**
     * Select a page
     */
    static async selectPage(args) {
        const { pageIndex, selectionMode = 'replaceWith' } = args;

        const code = `
            const { SelectionOptions } = require('indesign');
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            page.select(SelectionOptions[${JSON.stringify(selectionMode)}] || SelectionOptions.replaceWith);
            return { success: true };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Select Page")
            : formatErrorResponse(result?.error || 'Failed to select page', "Select Page");
    }

    /**
     * Get a summary of content on a page
     */
    static async getPageContentSummary(args) {
        const { pageIndex } = args;

        const code = `
            function collectionLength(collection) {
                try { return collection ? collection.length : 0; } catch(e) { return 0; }
            }
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            return {
                success: true,
                pageName: page.name,
                textFrames: collectionLength(page.textFrames),
                rectangles: collectionLength(page.rectangles),
                ellipses: collectionLength(page.ovals),
                graphics: collectionLength(page.graphics),
                groups: collectionLength(page.groups),
                totalItems: collectionLength(page.allPageItems)
            };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Get Page Content Summary")
            : formatErrorResponse(result?.error || 'Failed to get page content summary', "Get Page Content Summary");
    }

    static async listSpreads() {
        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            const spreads = [];
            for (let i = 0; i < doc.spreads.length; i++) {
                const spread = doc.spreads.item(i);
                const pageNames = [];
                for (let p = 0; p < spread.pages.length; p++) pageNames.push(spread.pages.item(p).name);
                spreads.push({
                    index: i,
                    name: spread.name || '',
                    id: spread.id,
                    pages: spread.pages.length,
                    pageNames
                });
            }
            return { success: true, count: spreads.length, spreads };
        `;
        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "List Spreads")
            : formatErrorResponse(result?.error || 'Failed to list spreads', "List Spreads");
    }

    static async getSpreadInfo(args) {
        const { spreadIndex } = args;
        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${spreadIndex} < 0 || ${spreadIndex} >= doc.spreads.length) return { success: false, error: 'Spread index out of range' };
            const spread = doc.spreads.item(${spreadIndex});
            const pages = [];
            for (let i = 0; i < spread.pages.length; i++) {
                const page = spread.pages.item(i);
                pages.push({ index: page.documentOffset, name: page.name, bounds: page.bounds });
            }
            return { success: true, index: ${spreadIndex}, name: spread.name || '', id: spread.id, pages, pageCount: pages.length };
        `;
        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Get Spread Info")
            : formatErrorResponse(result?.error || 'Failed to get spread info', "Get Spread Info");
    }

    static async getSpreadContentSummary(args) {
        const { spreadIndex } = args;
        const code = `
            function collectionLength(collection) { try { return collection ? collection.length : 0; } catch(e) { return 0; } }
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${spreadIndex} < 0 || ${spreadIndex} >= doc.spreads.length) return { success: false, error: 'Spread index out of range' };
            const spread = doc.spreads.item(${spreadIndex});
            const pages = [];
            let totalItems = 0;
            for (let i = 0; i < spread.pages.length; i++) {
                const page = spread.pages.item(i);
                const items = collectionLength(page.allPageItems);
                totalItems += items;
                pages.push({ pageIndex: page.documentOffset, name: page.name, totalItems: items });
            }
            return { success: true, spreadIndex: ${spreadIndex}, pageCount: pages.length, totalItems, pages };
        `;
        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Get Spread Content Summary")
            : formatErrorResponse(result?.error || 'Failed to get spread content summary', "Get Spread Content Summary");
    }

    /**
     * Set page background by creating a full-page rectangle
     */
    static async setPageBackground(args) {
        const { pageIndex = 0, backgroundColor = 'White', opacity = 100 } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            const pageBounds = page.bounds;
            let layer = doc.layers.itemByName('BACKGROUND');
            if (!layer || layer.isValid === false) layer = doc.layers.add({ name: 'BACKGROUND' });
            layer.visible = true;
            layer.locked = false;
            const backgroundRect = page.rectangles.add();
            backgroundRect.itemLayer = layer;
            backgroundRect.geometricBounds = [
                pageBounds[0],
                pageBounds[1],
                pageBounds[2],
                pageBounds[3]
            ];
            const colorName = ${JSON.stringify(backgroundColor)};
            if (colorName !== 'White') {
                try {
                    const bgColor = doc.colors.itemByName(colorName);
                    backgroundRect.fillColor = bgColor.isValid ? bgColor : doc.colors.itemByName('White');
                } catch (e) {
                    backgroundRect.fillColor = doc.colors.itemByName('White');
                }
            } else {
                backgroundRect.fillColor = doc.colors.itemByName('White');
            }
            backgroundRect.transparencySettings.blendingSettings.opacity = ${opacity};
            backgroundRect.sendToBack();
            return { success: true, backgroundColor: colorName, opacity: ${opacity} };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Set Page Background")
            : formatErrorResponse(result?.error || 'Failed to set page background', "Set Page Background");
    }
}
