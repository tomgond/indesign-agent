import { describe, expect, it } from 'vitest';

import { vectorizeWithVTracer } from '../src/providers/vtracer.js';

describe('vtracer', () => {
  it('fails gracefully when the binary is unavailable', async () => {
    const result = await vectorizeWithVTracer({
      cacheDir: '/tmp/design-assets-mcp-test',
      recraftLedgerPath: '/tmp/design-assets-mcp-test/recraft-ledger.jsonl',
      recraftDailyCapUsd: 1,
      recraftDefaultMaxCostUsd: 0.1,
      recraftApiBaseUrl: 'https://example.invalid',
      recraftApiToken: undefined,
      iconifyApiBaseUrl: 'https://api.iconify.design',
      vtracerCommand: 'definitely-not-installed',
      vtracerTimeoutMs: 1000,
      allowedInputRoots: []
    }, {
      rasterBase64: Buffer.from('fake').toString('base64'),
      rasterMimeType: 'image/png'
    });
    expect(result.success).toBe(false);
    const failed = result as { success: false; error: { code: string } };
    expect(failed.error.code).toBe('VTRACER_UNAVAILABLE');
  });
});
