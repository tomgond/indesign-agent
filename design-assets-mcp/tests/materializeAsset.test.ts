import { describe, expect, it } from 'vitest';

import { searchTabler } from '../src/providers/tabler.js';
import { materializeAsset } from '../src/tools/materializeAsset.js';

describe('materializeAsset', () => {
  it('materializes a tabler candidate', async () => {
    const candidate = searchTabler('home', 1)[0];
    const result = await materializeAsset({ candidate, includePreview: true });
    if (!result.success) throw new Error(result.error.message);
    expect(result.asset.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.asset.previewPngBase64).toBeDefined();
  });
});
