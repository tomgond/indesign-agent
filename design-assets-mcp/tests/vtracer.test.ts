import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

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

  it('removes its temp dir on oversized raster input', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-assets-mcp-vtracer-'));
    const mkdtempSpy = vi.spyOn(fs, 'mkdtempSync').mockImplementation(() => tempDir);
    try {
      const result = await vectorizeWithVTracer({
        cacheDir: '/tmp/design-assets-mcp-test',
        recraftLedgerPath: '/tmp/design-assets-mcp-test/recraft-ledger.jsonl',
        recraftDailyCapUsd: 1,
        recraftDefaultMaxCostUsd: 0.1,
        recraftApiBaseUrl: 'https://example.invalid',
        recraftApiToken: undefined,
        iconifyApiBaseUrl: 'https://api.iconify.design',
        vtracerCommand: 'node',
        vtracerTimeoutMs: 1000,
        allowedInputRoots: []
      }, {
        rasterBase64: Buffer.from('x'.repeat(6 * 1024 * 1024)).toString('base64'),
        rasterMimeType: 'image/png'
      });
      expect(result.success).toBe(false);
      expect(fs.existsSync(tempDir)).toBe(false);
    } finally {
      mkdtempSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
