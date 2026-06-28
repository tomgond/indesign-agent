import { describe, expect, it, vi } from 'vitest';

import { requestRecraftVectorAsset } from '../src/providers/recraft.js';

function baseConfig(overrides: Partial<Parameters<typeof requestRecraftVectorAsset>[0]> = {}) {
  return {
    cacheDir: '/tmp/design-assets-mcp-test',
    recraftLedgerPath: '/tmp/design-assets-mcp-test/recraft-ledger.jsonl',
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

describe('recraft', () => {
  it('uses the vector endpoint and documented field names', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://example.test/api/v1/images/generations/vector');
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer fake-token');
      expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');

      const body = JSON.parse(String(init?.body));
      expect(body.prompt).toBe('minimal flat vector icon of a small house with a sun');
      expect(body.model).toBe('recraftv4_1_vector');
      expect(body.style).toBe('icon');
      expect(body.size).toBe('1:1');
      expect(body.negative_prompt).toBe('text, watermark');
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
        data: [{ b64_json: svgBase64("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><path d='M0 0h10v10H0z'/></svg>") }]
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
  });

  it('parses b64_json SVG responses', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      data: [{ b64_json: svgBase64("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><path d='M0 0h10v10H0z'/></svg>") }]
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
      data: [{ b64_json: svgBase64("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><path d='M0 0h10v10H0z'/></svg>") }]
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
        bodyText: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><path d='M0 0h10v10H0z'/></svg>",
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
