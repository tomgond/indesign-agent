import { z } from 'zod';

export const searchAssetsInputSchema = z.object({
  query: z.string().min(1),
  style: z.enum(['outline', 'filled', 'solid', 'duotone', 'flat', 'any']).optional(),
  maxResults: z.number().int().positive().max(100).optional(),
  preferredSources: z.array(z.enum(['tabler', 'iconify-local', 'iconify-api'])).optional(),
  licenseMode: z.enum(['commercial-ok', 'attribution-ok', 'any-open-source']).optional(),
  language: z.string().optional(),
  allowRemote: z.boolean().optional()
});

export const materializeAssetInputSchema = z.object({
  candidateId: z.string().optional(),
  candidate: z.record(z.string(), z.unknown()).optional(),
  outputEncoding: z.enum(['svgText', 'base64']).optional(),
  includePreview: z.boolean().optional(),
  maxSvgBytes: z.number().int().positive().optional()
});

export const previewAssetInputSchema = z.object({
  assetId: z.string().optional(),
  svgText: z.string().optional(),
  svgBase64: z.string().optional(),
  maxWidth: z.number().int().positive().optional(),
  maxHeight: z.number().int().positive().optional()
}).refine((value) => Boolean(value.svgText) !== Boolean(value.svgBase64), {
  message: 'Provide exactly one of svgText or svgBase64'
});

export const generateVectorAssetInputSchema = z.object({
  prompt: z.string().min(1),
  style: z.enum(['icon', 'logo', 'vector_illustration', 'digital_illustration', 'any']).optional(),
  aspectRatio: z.string().optional(),
  model: z.enum(['recraftv4_1_vector', 'recraftv4_vector', 'recraftv3_vector', 'recraftv2_vector']).optional(),
  allowText: z.boolean().optional(),
  negativePrompt: z.string().optional(),
  seed: z.number().int().optional(),
  maxCostUsd: z.number().positive(),
  force: z.boolean(),
  outputEncoding: z.enum(['svgText', 'base64']).optional(),
  includePreview: z.boolean().optional()
});

export const vectorizeRasterAssetInputSchema = z.object({
  inputPath: z.string().optional(),
  rasterBase64: z.string().optional(),
  rasterMimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']).optional(),
  mode: z.enum(['poster', 'photo', 'bw', 'line-art']).optional(),
  tracing: z.record(z.string(), z.unknown()).optional(),
  outputEncoding: z.enum(['svgText', 'base64']).optional(),
  includePreview: z.boolean().optional()
}).refine((value) => Boolean(value.inputPath) !== Boolean(value.rasterBase64), {
  message: 'Provide exactly one of inputPath or rasterBase64'
});

export const listCachedAssetsInputSchema = z.object({
  source: z.enum(['tabler', 'iconify-local', 'iconify-api', 'recraft', 'vtracer']).optional(),
  limit: z.number().int().positive().max(200).optional(),
  cursor: z.string().optional()
});

export const explainAssetSourceInputSchema = z.object({
  assetId: z.string().optional(),
  candidateId: z.string().optional(),
  sha256: z.string().optional()
});
