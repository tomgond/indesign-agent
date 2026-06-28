import { generateVectorAssetInputSchema } from '../schemas/toolSchemas.js';
import { loadConfig } from '../config.js';
import { requestRecraftVectorAsset } from '../providers/recraft.js';

export async function generateVectorAsset(input: unknown, config = loadConfig()) {
  const parsed = generateVectorAssetInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false as const, error: { code: 'INVALID_INPUT', message: parsed.error.message } };
  }
  return requestRecraftVectorAsset(config, parsed.data);
}
