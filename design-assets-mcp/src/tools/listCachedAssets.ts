import { listCachedAssetsInputSchema } from '../schemas/toolSchemas.js';
import { listCachedAssets as readCache } from '../cache/assetCache.js';
import { fail, ok } from './shared.js';

export async function listCachedAssets(input: unknown, config: { cacheDir: string }) {
  const parsed = listCachedAssetsInputSchema.safeParse(input);
  if (!parsed.success) {
    return fail('INVALID_INPUT', parsed.error.message);
  }
  const value = parsed.data;
  return ok({
    items: readCache(config.cacheDir, value.source, value.limit ?? 50),
    cursor: null
  });
}
