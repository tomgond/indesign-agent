import fs from 'node:fs';

import { explainAssetSourceInputSchema } from '../schemas/toolSchemas.js';
import { cacheDir } from '../cache/assetCache.js';
import { fail, ok } from './shared.js';

export async function explainAssetSource(input: unknown, config: { cacheDir: string }) {
  const parsed = explainAssetSourceInputSchema.safeParse(input);
  if (!parsed.success) {
    return fail('INVALID_INPUT', parsed.error.message);
  }
  const base = cacheDir(config.cacheDir);
  const result: Record<string, unknown> = { source: null, provenance: null, cost: null, safetyReport: null };
  if (parsed.data.sha256) {
    const file = `${base}/assets/${parsed.data.sha256.slice(0, 2)}/${parsed.data.sha256}.json`;
    if (fs.existsSync(file)) {
      result.source = 'cache';
      result.provenance = JSON.parse(fs.readFileSync(file, 'utf8')).metadata?.provenance ?? null;
    }
  }
  return ok(result);
}
