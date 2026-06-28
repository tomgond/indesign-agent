import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { previewAsset } from '../src/tools/previewAsset.js';

const fixturePath = path.join(new URL('./fixtures', import.meta.url).pathname, 'safe-icon.svg');

describe('previewAsset', () => {
  it('renders a png preview', async () => {
    const svgText = fs.readFileSync(fixturePath, 'utf8');
    const result = await previewAsset({ svgText }) as { success: boolean; previewPngBase64?: string; error?: { message: string } };
    if (!result || !result.success) throw new Error(result?.error?.message ?? 'preview failed');
    expect(result.previewPngBase64).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});
