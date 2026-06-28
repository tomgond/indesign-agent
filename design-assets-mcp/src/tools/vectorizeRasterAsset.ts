import { vectorizeRasterAssetInputSchema } from '../schemas/toolSchemas.js';
import { loadConfig } from '../config.js';
import { vectorizeWithVTracer } from '../providers/vtracer.js';

export async function vectorizeRasterAsset(input: unknown, config = loadConfig()) {
  const parsed = vectorizeRasterAssetInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false as const, error: { code: 'INVALID_INPUT', message: parsed.error.message } };
  }
  return vectorizeWithVTracer(config, parsed.data);
}
