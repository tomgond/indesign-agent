import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { loadConfig } from './config.js';
import { searchAssets } from './tools/searchAssets.js';
import { materializeAsset } from './tools/materializeAsset.js';
import { previewAsset } from './tools/previewAsset.js';
import { generateVectorAsset } from './tools/generateVectorAsset.js';
import { vectorizeRasterAsset } from './tools/vectorizeRasterAsset.js';
import { listCachedAssets } from './tools/listCachedAssets.js';
import { explainAssetSource } from './tools/explainAssetSource.js';
import { toContentJson } from './tools/shared.js';

const toolDefinitions = [
  { name: 'search_assets', description: 'Search local and optionally remote design assets.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'materialize_asset', description: 'Materialize a candidate to a sanitized AssetPayload.', inputSchema: { type: 'object', properties: { candidateId: { type: 'string' }, candidate: { type: 'object' } } } },
  { name: 'preview_asset', description: 'Render a sanitized SVG payload to a PNG preview.', inputSchema: { type: 'object', properties: { svgText: { type: 'string' }, svgBase64: { type: 'string' } } } },
  { name: 'generate_vector_asset', description: 'Generate a vector asset through Recraft.', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt', 'maxCostUsd', 'force'] } },
  { name: 'vectorize_raster_asset', description: 'Vectorize a raster asset using VTracer.', inputSchema: { type: 'object', properties: { inputPath: { type: 'string' }, rasterBase64: { type: 'string' } } } },
  { name: 'list_cached_assets', description: 'List cached assets by source.', inputSchema: { type: 'object', properties: { source: { type: 'string' } } } },
  { name: 'explain_asset_source', description: 'Explain provenance and source details for an asset.', inputSchema: { type: 'object', properties: { assetId: { type: 'string' }, candidateId: { type: 'string' }, sha256: { type: 'string' } } } }
];

export function createDesignAssetsServer(config = loadConfig()) {
  const server = new Server(
    { name: 'design-assets-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const input = args ?? {};
    const result = await handleTool(name, input, config);
    return { content: toContentJson(result) };
  });

  return server;
}

async function handleTool(name: string, args: unknown, config = loadConfig()) {
  switch (name) {
    case 'search_assets':
      return await searchAssets(args, config);
    case 'materialize_asset':
      return await materializeAsset(args);
    case 'preview_asset':
      return await previewAsset(args);
    case 'generate_vector_asset':
      return await generateVectorAsset(args, config);
    case 'vectorize_raster_asset':
      return await vectorizeRasterAsset(args, config);
    case 'list_cached_assets':
      return await listCachedAssets(args, config);
    case 'explain_asset_source':
      return await explainAssetSource(args, config);
    default:
      return { success: false, error: { code: 'UNKNOWN_TOOL', message: `Unknown tool: ${name}` } };
  }
}

export async function startDesignAssetsServer(config = loadConfig()) {
  const server = createDesignAssetsServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
