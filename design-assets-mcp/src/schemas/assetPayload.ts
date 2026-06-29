import { z } from 'zod';

export const assetMetadataSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  source: z.enum(['tabler', 'iconify-local', 'iconify-api', 'recraft', 'vtracer', 'cache']),
  providerAssetId: z.string().optional(),
  providerUrl: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  style: z.string().optional(),
  providerWarnings: z.array(z.string()).optional(),
  createdAt: z.string(),
  tags: z.array(z.string()).optional(),
  dimensions: z.object({
    width: z.number().optional(),
    height: z.number().optional(),
    viewBox: z.string().optional()
  }).optional(),
  license: z.object({
    name: z.string().optional(),
    url: z.string().optional(),
    attributionRequired: z.boolean().optional(),
    commercialUseAllowed: z.boolean().optional(),
    sourceText: z.string().optional()
  }).optional(),
  provenance: z.object({
    steps: z.array(z.object({
      name: z.string(),
      at: z.string(),
      inputSha256: z.string().optional(),
      outputSha256: z.string().optional(),
      params: z.record(z.string(), z.unknown()).optional()
    }))
  }),
  cost: z.object({
    currency: z.literal('USD'),
    estimatedUsd: z.number().optional(),
    actualUsd: z.number().optional(),
    apiUnits: z.number().optional(),
    ledgerId: z.string().optional()
  }).optional()
});

export const safetyReportSchema = z.object({
  sanitizerVersion: z.string(),
  passed: z.boolean(),
  rejectedReasons: z.array(z.string()),
  warnings: z.array(z.string()),
  removedElements: z.array(z.string()),
  removedAttributes: z.array(z.string()),
  nodeCount: z.number().int().nonnegative(),
  pathCount: z.number().int().nonnegative(),
  byteLength: z.number().int().nonnegative(),
  hasEmbeddedImages: z.boolean(),
  hasText: z.boolean()
});

export const assetPayloadSchema = z.object({
  assetId: z.string(),
  encoding: z.enum(['svgText', 'base64']),
  svgText: z.string().optional(),
  svgBase64: z.string().optional(),
  sha256: z.string(),
  byteLength: z.number().int().nonnegative(),
  recommendedFilename: z.string(),
  metadata: assetMetadataSchema,
  safetyReport: safetyReportSchema,
  previewPngBase64: z.string().optional()
}).refine((value) => Boolean(value.svgText) !== Boolean(value.svgBase64), {
  message: 'Provide exactly one of svgText or svgBase64'
});

export type AssetPayload = z.infer<typeof assetPayloadSchema>;
export type AssetMetadata = z.infer<typeof assetMetadataSchema>;
export type SafetyReport = z.infer<typeof safetyReportSchema>;
