import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { requestRecraftVectorAsset } from '../src/providers/recraft.js';

function baseConfig(overrides: Partial<Parameters<typeof requestRecraftVectorAsset>[0]> = {}) {
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'design-assets-mcp-'));
  return {
    cacheDir,
    recraftLedgerPath: path.join(cacheDir, 'recraft-ledger.jsonl'),
    recraftApiToken: 'fake-token',
    recraftDailyCapUsd: 1,
    recraftDefaultMaxCostUsd: 0.1,
    recraftApiBaseUrl: 'https://example.test/api/',
    iconifyApiBaseUrl: 'https://api.iconify.design',
    vtracerCommand: 'vtracer',
    vtracerTimeoutMs: 1000,
    allowedInputRoots: [],
    ...overrides
  };
}

function svgBase64(svg: string) {
  return Buffer.from(svg, 'utf8').toString('base64');
}

function binaryResponse(options: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  bodyText?: string;
  bodyBytes?: Uint8Array;
  headers?: Record<string, string>;
}) {
  const text = options.bodyText ?? Buffer.from(options.bodyBytes ?? new Uint8Array()).toString('utf8');
  const bytes = options.bodyBytes ?? Buffer.from(text, 'utf8');
  const headers = new Headers(options.headers ?? {});
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    headers,
    async json() {
      return JSON.parse(text);
    },
    async text() {
      return text;
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  } as unknown as Response;
}

function jsonResponse(value: unknown, options: { ok?: boolean; status?: number; statusText?: string; headers?: Record<string, string> } = {}) {
  return binaryResponse({
    ok: options.ok,
    status: options.status,
    statusText: options.statusText,
    bodyText: JSON.stringify(value),
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) }
  });
}

function getResult(result: Awaited<ReturnType<typeof requestRecraftVectorAsset>>) {
  return result as
    | { success: true; asset: Record<string, any> }
    | { success: false; error: { code: string; message: string } };
}

function parseBody(init?: RequestInit) {
  return JSON.parse(String(init?.body)) as Record<string, any>;
}

function validSvg() {
  return "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><path d='M0 0h10v10H0z'/></svg>";
}

describe('recraft', () => {
  it('normalizes icon intent to the provider-compatible vector request', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://example.test/api/v1/images/generations/vector');
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer fake-token');
      expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');

      const body = parseBody(init);
      expect(body.prompt).toBe('minimal flat vector icon of a small house with a sun');
      expect(body.model).toBe('recraftv4_1_vector');
      expect(body.style).toBe('vector_illustration');
      expect(body.size).toBe('1:1');
      expect(body.negative_prompt).toBeUndefined();
      expect(body.random_seed).toBe(123);
      expect(body.response_format).toBe('b64_json');
      expect(body.n).toBe(1);
      expect(body.seed).toBeUndefined();
      expect(body.aspect_ratio).toBeUndefined();
      expect(body.allow_text).toBeUndefined();
      expect(body.force).toBeUndefined();
      expect(body.maxCostUsd).toBeUndefined();
      expect(body.outputEncoding).toBeUndefined();
      expect(body.includePreview).toBeUndefined();

      return jsonResponse({
        data: [{ b64_json: svgBase64(validSvg()) }]
      });
    });

    const result = getResult(await requestRecraftVectorAsset(baseConfig(), {
      prompt: 'minimal flat vector icon of a small house with a sun',
      style: 'icon',
      model: 'recraftv4_1_vector',
      aspectRatio: '1:1',
      negativePrompt: 'text, watermark',
      seed: 123,
      maxCostUsd: 0.05,
      force: true,
      outputEncoding: 'svgText',
      includePreview: false
    }, fetchMock as unknown as typeof fetch));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.asset.assetId).toBeDefined();
    expect(result.asset.metadata.source).toBe('recraft');
    expect(result.asset.svgText).toContain('<svg');
    expect(result.asset.svgBase64).toBeUndefined();
    expect(result.asset.sha256).toBeDefined();
    expect(result.asset.byteLength).toBeGreaterThan(0);
    expect(result.asset.recommendedFilename).toMatch(/\.svg$/);
    expect(result.asset.safetyReport).toBeDefined();
    expect(result.asset.metadata.provenance.steps[0].name).toBe('recraft-request');
    expect(result.asset.metadata.providerWarnings).toContain(
      'Mapped style icon to vector_illustration for recraftv4_1_vector; style icon was rejected by live Recraft validation.'
    );
    expect(result.asset.metadata.providerWarnings).toContain(
      'Omitted negativePrompt for recraftv4_1_vector; live Recraft validation rejected negative prompt for this model.'
    );
  });

  it('passes vector_illustration through for the default model', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = parseBody(init);
      expect(body.style).toBe('vector_illustration');
      expect(body.size).toBe('1:1');
      return jsonResponse({ data: [{ b64_json: svgBase64(validSvg()) }] });
    });

    const result = getResult(await requestRecraftVectorAsset(baseConfig(), {
      prompt: 'minimal flat vector icon of a small house with a sun',
      style: 'vector_illustration',
      model: 'recraftv4_1_vector',
      aspectRatio: '1:1',
      negativePrompt: 'text, watermark',
      seed: 123,
      maxCostUsd: 0.05,
      force: true,
      outputEncoding: 'svgText'
    }, fetchMock as unknown as typeof fetch));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.asset.metadata.providerWarnings).toContain(
      'Omitted negativePrompt for recraftv4_1_vector; live Recraft validation rejected negative prompt for this model.'
    );
  });

  it('omits any style from the provider request', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = parseBody(init);
      expect(body.style).toBeUndefined();
      expect(body.size).toBe('1:1');
      expect(body.negative_prompt).toBeUndefined();
      return jsonResponse({ data: [{ b64_json: svgBase64(validSvg()) }] });
    });

    const result = getResult(await requestRecraftVectorAsset(baseConfig(), {
      prompt: 'minimal flat vector icon of a small house with a sun',
      style: 'any',
      model: 'recraftv4_1_vector',
      aspectRatio: '1:1',
      negativePrompt: 'text, watermark',
      seed: 123,
      maxCostUsd: 0.05,
      force: true,
      outputEncoding: 'svgText'
    }, fetchMock as unknown as typeof fetch));

    expect(result.success).toBe(true);
  });

  it('omits logo style for the default model and explains the omission', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = parseBody(init);
      expect(body.style).toBeUndefined();
      expect(body.size).toBe('1:1');
      return jsonResponse({ data: [{ b64_json: svgBase64(validSvg()) }] });
    });

    const result = getResult(await requestRecraftVectorAsset(baseConfig(), {
      prompt: 'minimal flat vector icon of a small house with a sun',
      style: 'logo',
      model: 'recraftv4_1_vector',
      aspectRatio: '1:1',
      negativePrompt: 'text, watermark',
      seed: 123,
      maxCostUsd: 0.05,
      force: true,
      outputEncoding: 'svgText'
    }, fetchMock as unknown as typeof fetch));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.asset.metadata.providerWarnings).toContain(
      'Omitted style logo for recraftv4_1_vector; not validated for this model.'
    );
  });

  it('fails fast for known-bad 512x512 size without a safe fallback', async () => {
    const fetchMock = vi.fn();

    const result = getResult(await requestRecraftVectorAsset(baseConfig(), {
      prompt: 'minimal flat vector icon of a small house with a sun',
      style: 'vector_illustration',
      model: 'recraftv4_1_vector',
      size: '512x512',
      negativePrompt: 'text, watermark',
      seed: 123,
      maxCostUsd: 0.05,
      force: true,
      outputEncoding: 'svgText'
    }, fetchMock as unknown as typeof fetch));

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('RECRAFT_SIZE_UNSUPPORTED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prefers aspectRatio over bad size and warns about the ignored size', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = parseBody(init);
      expect(body.size).toBe('1:1');
      expect(body.size).not.toBe('512x512');
      return jsonResponse({ data: [{ b64_json: svgBase64(validSvg()) }] });
    });

    const result = getResult(await requestRecraftVectorAsset(baseConfig(), {
      prompt: 'minimal flat vector icon of a small house with a sun',
      style: 'vector_illustration',
      model: 'recraftv4_1_vector',
      aspectRatio: '1:1',
      size: '512x512',
      negativePrompt: 'text, watermark',
      seed: 123,
      maxCostUsd: 0.05,
      force: true,
      outputEncoding: 'svgText'
    }, fetchMock as unknown as typeof fetch));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.asset.metadata.providerWarnings).toContain(
      'Ignored size 512x512 because aspectRatio 1:1 is the validated Recraft vector shape.'
    );
  });

  it('keeps the request body clean', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = parseBody(init);
      expect(body).not.toHaveProperty('allow_text');
      expect(body).not.toHaveProperty('aspect_ratio');
      expect(body).not.toHaveProperty('seed');
      expect(body).not.toHaveProperty('negative_prompt');
      expect(body).not.toHaveProperty('outputEncoding');
      expect(body).not.toHaveProperty('includePreview');
      expect(body).not.toHaveProperty('force');
      expect(body).not.toHaveProperty('maxCostUsd');
      expect(Object.values(body)).not.toContain(undefined);
      expect(Object.values(body)).not.toContain(null);
      return jsonResponse({ data: [{ b64_json: svgBase64(validSvg()) }] });
    });

    const result = getResult(await requestRecraftVectorAsset(baseConfig(), {
      prompt: 'minimal flat vector icon of a small house with a sun',
      style: 'icon',
      model: 'recraftv4_1_vector',
      aspectRatio: '1:1',
      negativePrompt: 'text, watermark',
      seed: 123,
      maxCostUsd: 0.05,
      force: true,
      outputEncoding: 'svgText',
      includePreview: true
    }, fetchMock as unknown as typeof fetch));

    expect(result.success).toBe(true);
  });

  it('parses b64_json SVG responses', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      data: [{ b64_json: svgBase64(validSvg()) }]
    }));

    const result = getResult(await requestRecraftVectorAsset(baseConfig(), {
      prompt: 'minimal flat vector icon of a small house with a sun',
      style: 'icon',
      model: 'recraftv4_1_vector',
      aspectRatio: '1:1',
      negativePrompt: 'text, watermark',
      seed: 123,
      maxCostUsd: 0.05,
      force: true,
      outputEncoding: 'svgText'
    }, fetchMock as unknown as typeof fetch));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.asset.svgText).toContain('<svg');
    expect(result.asset.svgBase64).toBeUndefined();
    expect(result.asset.metadata.source).toBe('recraft');
    expect(result.asset.sha256).toBeDefined();
    expect(result.asset.byteLength).toBeGreaterThan(0);
    expect(result.asset.recommendedFilename).toMatch(/\.svg$/);
    expect(result.asset.safetyReport).toBeDefined();
    expect(result.asset.metadata.provenance.steps[0].name).toBe('recraft-request');
  });

  it('returns base64 output when requested', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      data: [{ b64_json: svgBase64(validSvg()) }]
    }));

    const result = getResult(await requestRecraftVectorAsset(baseConfig(), {
      prompt: 'minimal flat vector icon of a small house with a sun',
      style: 'icon',
      model: 'recraftv4_1_vector',
      aspectRatio: '1:1',
      negativePrompt: 'text, watermark',
      seed: 123,
      maxCostUsd: 0.05,
      force: true,
      outputEncoding: 'base64'
    }, fetchMock as unknown as typeof fetch));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.asset.svgText).toBeUndefined();
    expect(result.asset.svgBase64).toBeDefined();
    const decoded = Buffer.from(result.asset.svgBase64 ?? '', 'base64').toString('utf8');
    expect(decoded).toContain('<svg');
    expect(result.asset.metadata.source).toBe('recraft');
  });

  it('parses URL responses returning SVG', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        data: [{ url: 'https://example.test/result.svg' }]
      }))
      .mockResolvedValueOnce(binaryResponse({
        ok: true,
        status: 200,
        statusText: 'OK',
        bodyText: validSvg(),
        headers: { 'content-type': 'image/svg+xml' }
      }));

    const result = getResult(await requestRecraftVectorAsset(baseConfig(), {
      prompt: 'minimal flat vector icon of a small house with a sun',
      style: 'icon',
      model: 'recraftv4_1_vector',
      aspectRatio: '1:1',
      negativePrompt: 'text, watermark',
      seed: 123,
      maxCostUsd: 0.05,
      force: true,
      outputEncoding: 'svgText'
    }, fetchMock as unknown as typeof fetch));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.asset.svgText).toContain('<svg');
    expect(result.asset.metadata.source).toBe('recraft');
    expect(result.asset.sha256).toBeDefined();
    expect(result.asset.byteLength).toBeGreaterThan(0);
  });

  it('returns useful body excerpts for non-OK responses', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      error: { message: 'Invalid style for vector model' }
    }, {
      ok: false,
      status: 400,
      statusText: 'Bad Request'
    }));

    const result = getResult(await requestRecraftVectorAsset(baseConfig(), {
      prompt: 'minimal flat vector icon of a small house with a sun',
      style: 'icon',
      model: 'recraftv4_1_vector',
      aspectRatio: '1:1',
      negativePrompt: 'text, watermark',
      seed: 123,
      maxCostUsd: 0.05,
      force: true,
      outputEncoding: 'svgText'
    }, fetchMock as unknown as typeof fetch));

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('RECRAFT_REQUEST_FAILED');
    expect(result.error.message).toContain('400');
    expect(result.error.message).toContain('Bad Request');
    expect(result.error.message).toContain('Invalid style for vector model');
    expect(result.error.message).not.toContain('fake-token');
  });

  it('summarizes unsupported OK responses', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      data: [{ revised_prompt: '...' }]
    }));

    const result = getResult(await requestRecraftVectorAsset(baseConfig(), {
      prompt: 'minimal flat vector icon of a small house with a sun',
      style: 'icon',
      model: 'recraftv4_1_vector',
      aspectRatio: '1:1',
      negativePrompt: 'text, watermark',
      seed: 123,
      maxCostUsd: 0.05,
      force: true,
      outputEncoding: 'svgText'
    }, fetchMock as unknown as typeof fetch));

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(['RECRAFT_EMPTY_RESULT', 'RECRAFT_RESPONSE_UNSUPPORTED']).toContain(result.error.code);
    expect(result.error.message).toContain('no supported SVG payload');
    expect(result.error.message).toContain('top-level keys');
    expect(result.error.message).toContain('data[0] keys');
  });

  it('rejects b64_json payloads that do not decode to SVG', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      data: [{ b64_json: Buffer.from('not svg', 'utf8').toString('base64') }]
    }));

    const result = getResult(await requestRecraftVectorAsset(baseConfig(), {
      prompt: 'minimal flat vector icon of a small house with a sun',
      style: 'icon',
      model: 'recraftv4_1_vector',
      aspectRatio: '1:1',
      negativePrompt: 'text, watermark',
      seed: 123,
      maxCostUsd: 0.05,
      force: true,
      outputEncoding: 'svgText'
    }, fetchMock as unknown as typeof fetch));

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('RECRAFT_NON_SVG_RESULT');
    expect(result.error.message).toContain('SVG/vector markup');
  });

  it('rejects URL results that are not SVG', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        data: [{ url: 'https://example.test/result.png' }]
      }))
      .mockResolvedValueOnce(binaryResponse({
        ok: true,
        status: 200,
        statusText: 'OK',
        bodyBytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        headers: { 'content-type': 'image/png' }
      }));

    const result = getResult(await requestRecraftVectorAsset(baseConfig(), {
      prompt: 'minimal flat vector icon of a small house with a sun',
      style: 'icon',
      model: 'recraftv4_1_vector',
      aspectRatio: '1:1',
      negativePrompt: 'text, watermark',
      seed: 123,
      maxCostUsd: 0.05,
      force: true,
      outputEncoding: 'svgText'
    }, fetchMock as unknown as typeof fetch));

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(['RECRAFT_NON_SVG_RESULT', 'RECRAFT_RESULT_FETCH_FAILED']).toContain(result.error.code);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails before fetch when the token is missing', async () => {
    const fetchMock = vi.fn();
    const result = getResult(await requestRecraftVectorAsset(baseConfig({ recraftApiToken: undefined }), {
      prompt: 'minimal flat vector icon of a small house with a sun',
      style: 'icon',
      model: 'recraftv4_1_vector',
      aspectRatio: '1:1',
      negativePrompt: 'text, watermark',
      seed: 123,
      maxCostUsd: 0.05,
      force: true
    }, fetchMock as unknown as typeof fetch));

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('RECRAFT_TOKEN_MISSING');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails before fetch when the request exceeds the per-request cap', async () => {
    const fetchMock = vi.fn();
    const result = getResult(await requestRecraftVectorAsset(baseConfig(), {
      prompt: 'minimal flat vector icon of a small house with a sun',
      style: 'icon',
      model: 'recraftv4_1_vector',
      aspectRatio: '1:1',
      negativePrompt: 'text, watermark',
      seed: 123,
      maxCostUsd: 0.2,
      force: true
    }, fetchMock as unknown as typeof fetch));

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('RECRAFT_REQUEST_TOO_EXPENSIVE');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
