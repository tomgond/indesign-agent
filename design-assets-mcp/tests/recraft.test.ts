import { describe, expect, it, vi } from 'vitest';

import { requestRecraftVectorAsset } from '../src/providers/recraft.js';

describe('recraft', () => {
  it('fails without a token and does not call fetch', async () => {
    const fetchSpy = vi.fn();
    const result = await requestRecraftVectorAsset({
      cacheDir: '/tmp/design-assets-mcp-test',
      recraftLedgerPath: '/tmp/design-assets-mcp-test/recraft-ledger.jsonl',
      recraftApiToken: undefined,
      recraftDailyCapUsd: 1,
      recraftDefaultMaxCostUsd: 0.1,
      recraftApiBaseUrl: 'https://example.invalid',
      iconifyApiBaseUrl: 'https://api.iconify.design',
      vtracerCommand: 'vtracer',
      vtracerTimeoutMs: 1000,
      allowedInputRoots: []
    }, {
      prompt: 'test',
      maxCostUsd: 0.05,
      force: true
    }, fetchSpy as unknown as typeof fetch);
    expect(result.success).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
