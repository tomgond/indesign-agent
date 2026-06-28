import { describe, expect, it, vi } from 'vitest';

import { searchAssets } from '../src/tools/searchAssets.js';
import * as iconifyApi from '../src/providers/iconifyApi.js';

describe('searchAssets', () => {
  it('does not call iconify api unless allowRemote is true', async () => {
    const apiSpy = vi.spyOn(iconifyApi, 'searchIconifyApi');
    const result = await searchAssets({ query: 'home' }, { iconifyApiBaseUrl: 'https://api.iconify.design' });
    expect(result.success).toBe(true);
    expect(apiSpy).not.toHaveBeenCalled();
    apiSpy.mockRestore();
  });

  it('marks remote candidates as discovery-only', async () => {
    const apiSpy = vi.spyOn(iconifyApi, 'searchIconifyApi').mockResolvedValue([
      {
        candidateId: 'iconify-api:mdi:home',
        name: 'home',
        source: 'iconify-api' as const,
        providerAssetId: 'mdi:home',
        style: undefined,
        tags: ['home'],
        license: undefined,
        confidence: 0.4,
        materializable: false,
        _remote: true,
        warnings: ['Remote Iconify API candidates are discovery-only in this build.']
      }
    ]);
    const result = await searchAssets({ query: 'home', allowRemote: true, preferredSources: ['iconify-api'] }, { iconifyApiBaseUrl: 'https://api.iconify.design' });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error.message);
    expect(result.candidates[0].materializable).toBe(false);
    expect(result.candidates[0].warnings).toContain('Remote Iconify API candidates are discovery-only in this build.');
    expect(apiSpy).toHaveBeenCalledTimes(1);
    apiSpy.mockRestore();
  });
});
