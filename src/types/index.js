/**
 * Tool definitions index for InDesign MCP Server
 * Central import and export of all tool definitions
 */

import { pageToolDefinitions } from './toolDefinitionsPage.js';
import { contentToolDefinitions } from './toolDefinitionsContent.js';
import { documentToolDefinitions } from './toolDefinitionsDocument.js';
import { exportToolDefinitions } from './toolDefinitionsExport.js';
import { bookToolDefinitions } from './toolDefinitionsBook.js';
import { utilityToolDefinitions } from './toolDefinitionsUtility.js';
import { pageItemGroupToolDefinitions } from './toolDefinitionsPageItemGroup.js';
import { masterSpreadToolDefinitions } from './toolDefinitionsMasterSpread.js';
import { spreadToolDefinitions } from './toolDefinitionsSpread.js';
import { layerToolDefinitions } from './toolDefinitionsLayer.js';
import { templateToolDefinitions, templateToolProfileNames } from './toolDefinitionsTemplate.js';

export const genericOnlyDefinitions = [
    ...pageToolDefinitions,
    ...contentToolDefinitions,
    ...documentToolDefinitions,
    ...exportToolDefinitions,
    ...bookToolDefinitions,
    ...utilityToolDefinitions,
    ...pageItemGroupToolDefinitions,
    ...masterSpreadToolDefinitions,
    ...spreadToolDefinitions,
    ...layerToolDefinitions,
];

export const allToolDefinitions = [...new Map([...genericOnlyDefinitions, ...templateToolDefinitions].map((tool) => [tool.name, tool])).values()];

export function getToolDefinitionsForProfile(profile = process.env.INDESIGN_TOOL_PROFILE || 'template') {
    if (profile === 'template') return templateToolDefinitions;
    if (profile === 'generic') return genericOnlyDefinitions;
    if (profile === 'all') return allToolDefinitions;
    throw new Error(`Unknown INDESIGN_TOOL_PROFILE: ${profile}`);
}

// Export individual modules for specific use cases
export { pageToolDefinitions } from './toolDefinitionsPage.js';
export { contentToolDefinitions } from './toolDefinitionsContent.js';
export { documentToolDefinitions } from './toolDefinitionsDocument.js';
export { exportToolDefinitions } from './toolDefinitionsExport.js';
export { bookToolDefinitions } from './toolDefinitionsBook.js';
export { utilityToolDefinitions } from './toolDefinitionsUtility.js';
export { pageItemGroupToolDefinitions } from './toolDefinitionsPageItemGroup.js';
export { masterSpreadToolDefinitions } from './toolDefinitionsMasterSpread.js';
export { spreadToolDefinitions } from './toolDefinitionsSpread.js';
export { layerToolDefinitions } from './toolDefinitionsLayer.js'; 
export { templateToolDefinitions, templateToolProfileNames } from './toolDefinitionsTemplate.js';
