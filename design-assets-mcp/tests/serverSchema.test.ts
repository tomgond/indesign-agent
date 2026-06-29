import { describe, expect, it } from 'vitest';

import { toolDefinitions } from '../src/server.js';

function definition(name: string) {
  const tool = toolDefinitions.find((entry) => entry.name === name);
  if (!tool) throw new Error(`missing tool definition: ${name}`);
  return tool;
}

describe('server schema', () => {
  it('advertises the expected tools', () => {
    expect(toolDefinitions.map((tool) => tool.name)).toEqual([
      'search_assets',
      'materialize_asset',
      'preview_asset',
      'generate_vector_asset',
      'vectorize_raster_asset',
      'list_cached_assets',
      'explain_asset_source'
    ]);
  });

  it('includes the required input fields', () => {
    expect(definition('materialize_asset').inputSchema.required).toContain('candidate');
    expect(definition('materialize_asset').inputSchema.properties.candidate).toBeDefined();
    expect(definition('materialize_asset').inputSchema.properties.candidateId).toBeUndefined();
    expect(definition('materialize_asset').inputSchema.anyOf).toBeUndefined();
    expect(definition('search_assets').inputSchema.properties.allowRemote).toBeDefined();
    expect(definition('generate_vector_asset').inputSchema.properties.prompt).toBeDefined();
    expect(definition('generate_vector_asset').inputSchema.properties.style).toBeDefined();
    expect(definition('generate_vector_asset').inputSchema.properties.aspectRatio).toBeDefined();
    expect(definition('generate_vector_asset').inputSchema.properties.maxCostUsd).toBeDefined();
    expect(definition('generate_vector_asset').inputSchema.properties.force).toBeDefined();
    expect(definition('generate_vector_asset').inputSchema.properties.size).toBeDefined();
    expect(definition('generate_vector_asset').inputSchema.properties.model).toBeDefined();
    expect(definition('generate_vector_asset').inputSchema.properties.negativePrompt).toBeDefined();
    expect(definition('generate_vector_asset').inputSchema.properties.seed).toBeDefined();
    expect(definition('generate_vector_asset').inputSchema.properties.outputEncoding).toBeDefined();
    expect(definition('generate_vector_asset').inputSchema.properties.includePreview).toBeDefined();
    expect(definition('generate_vector_asset').inputSchema.properties.allowText).toBeUndefined();
    expect(definition('preview_asset').inputSchema.properties.svgText).toBeDefined();
    expect(definition('preview_asset').inputSchema.properties.svgBase64).toBeDefined();
    expect(definition('vectorize_raster_asset').inputSchema.properties.inputPath).toBeDefined();
    expect(definition('list_cached_assets').inputSchema.properties.limit).toBeDefined();
  });
});
