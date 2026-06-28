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

function schema(properties: any, required: string[] = [], extra: any = {}): any {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required,
    ...extra
  };
}

export const toolDefinitions: any[] = [
  {
    name: 'search_assets',
    description: 'Search local Tabler and installed Iconify collections, with remote Iconify API search only when allowRemote=true.',
    inputSchema: schema({
      query: { type: 'string' },
      style: { type: 'string', enum: ['outline', 'filled', 'solid', 'duotone', 'flat', 'any'] },
      maxResults: { type: 'integer', minimum: 1, maximum: 100 },
      preferredSources: { type: 'array', items: { type: 'string', enum: ['tabler', 'iconify-local', 'iconify-api'] } },
      licenseMode: { type: 'string', enum: ['commercial-ok', 'attribution-ok', 'any-open-source'] },
      language: { type: 'string' },
      allowRemote: { type: 'boolean' }
    }, ['query'])
  },
  {
    name: 'materialize_asset',
    description: 'Resolve a candidate into a sanitized AssetPayload that the Mac-side materialize_inline_svg_asset tool can consume.',
    inputSchema: schema({
      candidateId: { type: 'string' },
      candidate: { type: 'object', additionalProperties: true },
      outputEncoding: { type: 'string', enum: ['svgText', 'base64'] },
      includePreview: { type: 'boolean' },
      maxSvgBytes: { type: 'integer', minimum: 1 }
    }, [], { anyOf: [{ required: ['candidateId'] }, { required: ['candidate'] }] })
  },
  {
    name: 'preview_asset',
    description: 'Render a sanitized SVG payload to a PNG preview.',
    inputSchema: schema({
      assetId: { type: 'string' },
      svgText: { type: 'string' },
      svgBase64: { type: 'string' },
      maxWidth: { type: 'integer', minimum: 1 },
      maxHeight: { type: 'integer', minimum: 1 }
    }, [], { oneOf: [{ required: ['svgText'] }, { required: ['svgBase64'] }] })
  },
  {
    name: 'generate_vector_asset',
    description: 'Generate a vector asset through Recraft. Requires prompt, maxCostUsd, and force=true.',
    inputSchema: schema({
      prompt: { type: 'string' },
      style: { type: 'string', enum: ['icon', 'logo', 'vector_illustration', 'digital_illustration', 'any'] },
      aspectRatio: { type: 'string' },
      model: { type: 'string', enum: ['recraftv4_1_vector', 'recraftv4_vector', 'recraftv3_vector', 'recraftv2_vector'] },
      allowText: { type: 'boolean' },
      negativePrompt: { type: 'string' },
      seed: { type: 'integer' },
      maxCostUsd: { type: 'number', exclusiveMinimum: 0 },
      force: { type: 'boolean' },
      outputEncoding: { type: 'string', enum: ['svgText', 'base64'] },
      includePreview: { type: 'boolean' }
    }, ['prompt', 'maxCostUsd', 'force'])
  },
  {
    name: 'vectorize_raster_asset',
    description: 'Vectorize a raster asset using VTracer.',
    inputSchema: schema({
      inputPath: { type: 'string' },
      rasterBase64: { type: 'string' },
      rasterMimeType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp'] },
      mode: { type: 'string', enum: ['poster', 'photo', 'bw', 'line-art'] },
      tracing: { type: 'object', additionalProperties: true },
      outputEncoding: { type: 'string', enum: ['svgText', 'base64'] },
      includePreview: { type: 'boolean' }
    }, [], { oneOf: [{ required: ['inputPath'] }, { required: ['rasterBase64'] }] })
  },
  {
    name: 'list_cached_assets',
    description: 'List cached assets by source.',
    inputSchema: schema({
      source: { type: 'string', enum: ['tabler', 'iconify-local', 'iconify-api', 'recraft', 'vtracer'] },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      cursor: { type: 'string' }
    })
  },
  {
    name: 'explain_asset_source',
    description: 'Explain provenance, source, license, and safety details for an asset.',
    inputSchema: schema({
      assetId: { type: 'string' },
      candidateId: { type: 'string' },
      sha256: { type: 'string' }
    })
  }
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
