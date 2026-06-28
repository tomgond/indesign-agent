import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { searchTabler } from '../src/providers/tabler.js';
import { materializeAsset } from '../src/tools/materializeAsset.js';
import { assetPayloadSchema } from '../src/schemas/assetPayload.js';

describe('materializeAsset', () => {
  it('materializes a tabler candidate', async () => {
    const candidate = searchTabler('home', 1)[0];
    const result = await materializeAsset({ candidate, includePreview: true });
    if (!result.success) throw new Error(result.error.message);
    const asset = result.asset;
    const parsed = assetPayloadSchema.safeParse(asset);
    expect(parsed.success).toBe(true);
    expect(result.asset.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.asset.previewPngBase64).toBeDefined();
    expect(Boolean(asset.svgText) !== Boolean(asset.svgBase64)).toBe(true);
    const svgText = asset.svgText ?? Buffer.from(asset.svgBase64 ?? '', 'base64').toString('utf8');
    expect(asset.sha256).toBe(crypto.createHash('sha256').update(Buffer.from(svgText, 'utf8')).digest('hex'));
    expect(asset.byteLength).toBe(Buffer.byteLength(svgText, 'utf8'));
    expect(asset.recommendedFilename.endsWith('.svg')).toBe(true);
    expect(asset.safetyReport.passed).toBe(true);
    expect(asset.metadata.source).toBe('tabler');
  });

  it('rejects candidateId-only input', async () => {
    const result = await materializeAsset({ candidateId: 'tabler:home' } as any);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected invalid input');
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('rejects discovery-only remote candidates', async () => {
    const result = await materializeAsset({
      candidate: { source: 'iconify-api', providerAssetId: 'mdi:home', candidateId: 'iconify-api:mdi:home', warnings: ['Remote Iconify API candidates are discovery-only in this build.'] }
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error.code).toBe('MATERIALIZE_FAILED');
    expect(result.error.message).toMatch(/discovery-only/i);
  });
});
