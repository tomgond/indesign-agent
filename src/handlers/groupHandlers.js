/**
 * Group management handlers
 */
import { ScriptExecutor } from '../core/scriptExecutor.js';
import { formatResponse, formatErrorResponse } from '../utils/stringUtils.js';

export class GroupHandlers {
    static collectionHelper = `
            function collectionItem(collection, index) {
                if (!collection) return null;
                if (typeof collection.item === 'function') return collection.item(index);
                return collection[index];
            }
        `;

    static groupHelper = `
            function isGroupItem(item) {
                if (!item) return false;
                try {
                    if (item.constructor && item.constructor.name === 'Group') return true;
                } catch(e) {}
                try {
                    if (typeof item.ungroup === 'function') return true;
                } catch(e) {}
                return false;
            }

            function getGroupChildren(group) {
                const children = [];
                if (!group) return children;
                let source = null;
                try {
                    source = group.pageItems;
                } catch(e) {}
                if (!source) {
                    try {
                        source = group.allPageItems;
                    } catch(e) {}
                }
                if (!source) return children;
                for (let i = 0; i < source.length; i++) {
                    const child = collectionItem(source, i);
                    if (child) children.push(child);
                }
                return children;
            }

            function itemId(item) {
                try { return item && item.id; } catch(e) { return null; }
            }

            function findById(collection, id) {
                if (id === undefined || id === null) return null;
                for (let i = 0; i < collection.length; i++) {
                    const item = collectionItem(collection, i);
                    if (itemId(item) === id) return item;
                }
                return null;
            }

            function directPageItems(page) {
                const out = [];
                const source = page.pageItems || page.allPageItems;
                for (let i = 0; source && i < source.length; i++) {
                    const item = collectionItem(source, i);
                    if (item) out.push(item);
                }
                return out;
            }

            function childIdSet(group) {
                const ids = {};
                const children = getGroupChildren(group);
                for (let i = 0; i < children.length; i++) ids[itemId(children[i])] = true;
                return ids;
            }

            function findStandaloneCandidate(page, group) {
                const childIds = childIdSet(group);
                const items = directPageItems(page);
                const candidates = [];
                for (let i = 0; i < items.length; i++) {
                    const item = items[i];
                    const id = itemId(item);
                    if (!item || id === itemId(group) || childIds[id] || isGroupItem(item)) continue;
                    candidates.push(item);
                }
                return candidates.length === 1 ? candidates[0] : null;
            }
        `;

    /**
     * Create a group from selected items
     */
    static async createGroup(args) {
        const { pageIndex } = args;

        const code = `
            ${GroupHandlers.collectionHelper}
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const selection = app.selection;
            if (!selection || selection.length < 2) return { success: false, error: 'Select at least 2 items to create a group' };
            let group;
            try {
                group = selection[0].group();
            } catch(e) {
                try {
                    group = doc.groups.add(selection);
                } catch(e2) {
                    return { success: false, error: 'Failed to create group: ' + e2.message };
                }
            }
            let itemCount = 0;
            try { itemCount = group.allPageItems.length; } catch(e) {}
            return { success: true, id: group.id, itemCount };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Create Group")
            : formatErrorResponse(result?.error || 'Failed to create group', "Create Group");
    }

    /**
     * Create a group from specific page items
     */
    static async createGroupFromItems(args) {
        const { pageIndex, itemIndices } = args;

        const code = `
            ${GroupHandlers.collectionHelper}
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const { SelectionOptions } = require('indesign');
            const page = doc.pages.item(${pageIndex});
            const indices = ${JSON.stringify(itemIndices)};
            if (indices.length < 2) return { success: false, error: 'Need at least 2 items to create a group' };
            const items = [];
            for (let i = 0; i < indices.length; i++) {
                if (indices[i] < page.allPageItems.length) {
                    items.push(collectionItem(page.allPageItems, indices[i]));
                }
            }
            if (items.length < 2) return { success: false, error: 'Not enough valid items to create a group' };
            for (let j = 0; j < items.length; j++) {
                if (j === 0) {
                    items[j].select(SelectionOptions.replaceWith);
                } else {
                    items[j].select(SelectionOptions.addTo);
                }
            }
            let group;
            try {
                group = items[0].group();
            } catch(e) {
                try {
                    group = doc.groups.add(items);
                } catch(e2) {
                    return { success: false, error: 'Failed to create group: ' + e2.message };
                }
            }
            let itemCount = 0;
            try { itemCount = group.allPageItems.length; } catch(e) {}
            return { success: true, id: group.id, itemCount };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Create Group From Items")
            : formatErrorResponse(result?.error || 'Failed to create group from items', "Create Group From Items");
    }

    /**
     * Ungroup a group
     */
    static async ungroup(args) {
        const { pageIndex, groupIndex } = args;

        const code = `
            ${GroupHandlers.collectionHelper}
            ${GroupHandlers.groupHelper}
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            if (${groupIndex} < 0 || ${groupIndex} >= page.allPageItems.length) return { success: false, error: 'Group index out of range' };
            const item = collectionItem(page.allPageItems, ${groupIndex});
            if (!isGroupItem(item)) return { success: false, error: 'Selected item is not a group' };
            let itemCount = 0;
            try { itemCount = item.allPageItems.length; } catch(e) {}
            try {
                item.ungroup();
            } catch(e) {
                return { success: false, error: 'Failed to ungroup: ' + e.message };
            }
            return { success: true, releasedItemCount: itemCount };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Ungroup")
            : formatErrorResponse(result?.error || 'Failed to ungroup', "Ungroup");
    }

    /**
     * Get group information
     */
    static async getGroupInfo(args) {
        const { pageIndex, groupIndex } = args;

        const code = `
            ${GroupHandlers.collectionHelper}
            ${GroupHandlers.groupHelper}
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            if (${groupIndex} < 0 || ${groupIndex} >= page.allPageItems.length) return { success: false, error: 'Group index out of range' };
            const item = collectionItem(page.allPageItems, ${groupIndex});
            if (!isGroupItem(item)) return { success: false, error: 'Selected item is not a group' };
            const contents = [];
            try {
                const groupChildren = getGroupChildren(item);
                for (let i = 0; i < groupChildren.length; i++) {
                    const groupItem = groupChildren[i];
                    let type = 'Unknown';
                    try { type = groupItem.constructor?.name || 'Unknown'; } catch(e) {}
                    contents.push({ index: i, type, id: groupItem.id });
                }
            } catch(e) {}
            return {
                success: true,
                name: item.name || 'Unnamed',
                id: item.id,
                visible: item.visible,
                locked: item.locked,
                geometricBounds: item.geometricBounds,
                itemCount: contents.length,
                contents
            };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Get Group Info")
            : formatErrorResponse(result?.error || 'Failed to get group info', "Get Group Info");
    }

    /**
     * Add item to group
     */
    static async addItemToGroup(args) {
        const { pageIndex, groupIndex = -1, itemIndex = -1 } = args;

        const code = `
            ${GroupHandlers.collectionHelper}
            ${GroupHandlers.groupHelper}
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            let group = null;
            if (${JSON.stringify(args.groupId)} !== undefined && ${JSON.stringify(args.groupId)} !== null) {
                group = findById(page.allPageItems, ${JSON.stringify(args.groupId)});
            }
            if (!group) {
                if (${groupIndex} < 0 || ${groupIndex} >= page.allPageItems.length) return { success: false, error: 'Group index out of range' };
                group = collectionItem(page.allPageItems, ${groupIndex});
            }
            if (!isGroupItem(group)) return { success: false, error: 'Selected item is not a group' };
            let item = null;
            if (${JSON.stringify(args.itemId)} !== undefined && ${JSON.stringify(args.itemId)} !== null) {
                item = findById(page.allPageItems, ${JSON.stringify(args.itemId)});
            }
            if (!item && ${itemIndex} >= 0 && ${itemIndex} < page.allPageItems.length) {
                item = collectionItem(page.allPageItems, ${itemIndex});
            }
            if (!item) return { success: false, error: 'Target item not found' };
            if (item.id === group.id) return { success: false, error: 'Cannot add a group to itself' };

            const children = getGroupChildren(group);
            const originalName = group.name || '';
            const originalVisible = group.visible;
            const originalLocked = group.locked;

            for (let i = 0; i < children.length; i++) {
                if (children[i] && children[i].id === item.id) {
                    const fallback = findStandaloneCandidate(page, group);
                    if (!fallback) return { success: true, groupId: group.id, itemId: item.id, alreadyMember: true };
                    item = fallback;
                    break;
                }
            }

            try {
                if (originalLocked) group.locked = false;
                group.ungroup();
                const regroupItems = children.concat([item]);
                const newGroup = doc.groups.add(regroupItems);
                newGroup.name = originalName;
                newGroup.visible = originalVisible;
                newGroup.locked = originalLocked;
                return { success: true, groupId: newGroup.id, itemId: item.id, itemCount: getGroupChildren(newGroup).length };
            } catch(e) {
                return { success: false, error: 'Failed to add item to group: ' + e.message };
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Add Item to Group")
            : formatErrorResponse(result?.error || 'Failed to add item to group', "Add Item to Group");
    }

    /**
     * Remove item from group
     */
    static async removeItemFromGroup(args) {
        const { pageIndex, groupIndex = -1, itemIndex } = args;

        const code = `
            ${GroupHandlers.collectionHelper}
            ${GroupHandlers.groupHelper}
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            let group = null;
            if (${JSON.stringify(args.groupId)} !== undefined && ${JSON.stringify(args.groupId)} !== null) {
                group = findById(page.allPageItems, ${JSON.stringify(args.groupId)});
            }
            if (!group) {
                if (${groupIndex} < 0 || ${groupIndex} >= page.allPageItems.length) return { success: false, error: 'Group index out of range' };
                group = collectionItem(page.allPageItems, ${groupIndex});
            }
            if (!isGroupItem(group)) return { success: false, error: 'Selected item is not a group' };
            const groupItems = getGroupChildren(group);
            if (${itemIndex} < 0 || ${itemIndex} >= groupItems.length) return { success: false, error: 'Item index out of range in group' };
            const item = groupItems[${itemIndex}];
            const itemId = item.id;
            const originalName = group.name || '';
            const originalVisible = group.visible;
            const originalLocked = group.locked;
            const remainingItems = [];
            for (let i = 0; i < groupItems.length; i++) {
                if (i !== ${itemIndex}) remainingItems.push(groupItems[i]);
            }

            try {
                if (originalLocked) group.locked = false;
                group.ungroup();
                if (remainingItems.length >= 2) {
                    const newGroup = doc.groups.add(remainingItems);
                    newGroup.name = originalName;
                    newGroup.visible = originalVisible;
                    newGroup.locked = originalLocked;
                    return {
                        success: true,
                        groupId: newGroup.id,
                        removedItemId: itemId,
                        remainingItemCount: remainingItems.length
                    };
                }
                if (remainingItems.length === 1) {
                    return {
                        success: true,
                        removedItemId: itemId,
                        remainingItemCount: 1,
                        groupCollapsedToSingleItem: true,
                        remainingItemId: remainingItems[0].id
                    };
                }
                return { success: true, removedItemId: itemId, remainingItemCount: 0, groupRemoved: true };
            } catch(e) {
                return { success: false, error: 'Failed to remove item from group: ' + e.message };
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Remove Item from Group")
            : formatErrorResponse(result?.error || 'Failed to remove item from group', "Remove Item from Group");
    }

    /**
     * List all groups on a page
     */
    static async listGroups(args) {
        const { pageIndex } = args;

        const code = `
            ${GroupHandlers.collectionHelper}
            ${GroupHandlers.groupHelper}
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            const groups = [];
            for (let i = 0; i < page.allPageItems.length; i++) {
                const item = collectionItem(page.allPageItems, i);
                if (isGroupItem(item)) {
                    let itemCount = 0;
                    try { itemCount = getGroupChildren(item).length; } catch(e) {}
                    groups.push({
                        pageItemIndex: i,
                        name: item.name || 'Unnamed',
                        id: item.id,
                        visible: item.visible,
                        locked: item.locked,
                        itemCount,
                        geometricBounds: item.geometricBounds
                    });
                }
            }
            return { success: true, groups, count: groups.length };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "List Groups")
            : formatErrorResponse(result?.error || 'Failed to list groups', "List Groups");
    }

    /**
     * Set group properties
     */
    static async setGroupProperties(args) {
        const { pageIndex, groupIndex, visible, locked, name } = args;

        const code = `
            ${GroupHandlers.collectionHelper}
            ${GroupHandlers.groupHelper}
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            if (${groupIndex} < 0 || ${groupIndex} >= page.allPageItems.length) return { success: false, error: 'Group index out of range' };
            const group = collectionItem(page.allPageItems, ${groupIndex});
            if (!isGroupItem(group)) return { success: false, error: 'Selected item is not a group' };
            if (${visible} !== null && ${visible} !== undefined) group.visible = ${visible};
            if (${locked} !== null && ${locked} !== undefined) group.locked = ${locked};
            if (${JSON.stringify(name)} !== null && ${JSON.stringify(name)} !== undefined) group.name = ${JSON.stringify(name)};
            return { success: true, id: group.id, name: group.name, visible: group.visible, locked: group.locked };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Set Group Properties")
            : formatErrorResponse(result?.error || 'Failed to set group properties', "Set Group Properties");
    }
}
