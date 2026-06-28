import type { DesignAssetsConfig } from '../config.js';
import { appendLedgerEntry, dailyUsdSpent, ensureLedgerPath } from '../cache/costLedger.js';
import { sanitizeSvg } from '../svg/sanitizeSvg.js';
import { bytesSha256 } from '../svg/hash.js';
import { renderPreview } from '../svg/renderPreview.js';
import { step } from '../cache/provenance.js';
import type { AssetPayload } from '../schemas/assetPayload.js';

export type RecraftVectorRequest = {
  prompt: string;
  style?: string;
  aspectRatio?: string;
  size?: string;
  model?: string;
  negativePrompt?: string;
  seed?: number;
  maxCostUsd: number;
  force: boolean;
  outputEncoding?: 'svgText' | 'base64';
  includePreview?: boolean;
};

export async function requestRecraftVectorAsset(config: DesignAssetsConfig, input: RecraftVectorRequest, fetchImpl: typeof fetch = fetch) {
  if (!input.force) {
    return { success: false, error: { code: 'RECRAFT_FORCE_REQUIRED', message: 'force=true is required' } };
  }
  if (!config.recraftApiToken) {
    return { success: false, error: { code: 'RECRAFT_TOKEN_MISSING', message: 'RECRAFT_API_TOKEN is required' } };
  }
  if (input.maxCostUsd > config.recraftDefaultMaxCostUsd) {
    return { success: false, error: { code: 'RECRAFT_REQUEST_TOO_EXPENSIVE', message: 'Requested cost exceeds per-request cap' } };
  }

  ensureLedgerPath(config.recraftLedgerPath);
  const spentToday = dailyUsdSpent(config.recraftLedgerPath);
  if (spentToday + input.maxCostUsd > config.recraftDailyCapUsd) {
    return { success: false, error: { code: 'RECRAFT_DAILY_CAP_EXCEEDED', message: 'Daily Recraft cap exceeded' } };
  }

  const endpoint = joinUrlPath(config.recraftApiBaseUrl, 'v1/images/generations/vector');
  const requestBody = compactObject({
    prompt: input.prompt,
    n: 1,
    response_format: 'b64_json',
    model: input.model ?? 'recraftv4_1_vector',
    style: normalizeVectorStyle(input.style),
    size: normalizeVectorSize(input.size ?? input.aspectRatio),
    negative_prompt: input.negativePrompt,
    random_seed: input.seed
  });
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.recraftApiToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const bodyExcerpt = await readResponseBodyExcerpt(response);
    return {
      success: false,
      error: {
        code: 'RECRAFT_REQUEST_FAILED',
        message: formatRequestFailureMessage(response.status, response.statusText, bodyExcerpt)
      }
    };
  }

  const payload = await parseJsonResponse(response);
  if (!payload.ok) {
    return {
      success: false,
      error: {
        code: 'RECRAFT_RESPONSE_UNSUPPORTED',
        message: `Recraft response was not valid JSON: ${payload.error}`
      }
    };
  }

  const data = payload.value as Record<string, any>;
  const inlineSvg = extractInlineSvg(data);
  if (inlineSvg) {
    return finalizeRecraftAsset(config, data, inlineSvg, input);
  }

  const base64Candidate = extractBase64Candidate(data);
  if (base64Candidate) {
    const decoded = decodeBase64Candidate(base64Candidate);
    if (decoded.ok && looksLikeSvgText(decoded.value)) {
      return finalizeRecraftAsset(config, data, decoded.value, input);
    }
    return {
      success: false,
      error: {
        code: 'RECRAFT_NON_SVG_RESULT',
        message: buildNonSvgMessage(
          'Recraft returned a base64 payload that did not decode to SVG/vector markup.',
          data
        )
      }
    };
  }

  const urlCandidate = extractUrlCandidate(data);
  if (urlCandidate) {
    const fetched = await fetchVectorResult(urlCandidate, fetchImpl);
    if (!fetched.ok) {
      return {
        success: false,
        error: {
          code: 'RECRAFT_RESULT_FETCH_FAILED',
          message: fetched.message
        }
      };
    }
    if (looksLikeSvgText(fetched.value)) {
      return finalizeRecraftAsset(config, data, fetched.value, input, urlCandidate);
    }
    const urlBase64 = maybeDecodeTextAsBase64(fetched.value);
    if (urlBase64 && looksLikeSvgText(urlBase64)) {
      return finalizeRecraftAsset(config, data, urlBase64, input, urlCandidate);
    }
    return {
      success: false,
      error: {
        code: 'RECRAFT_NON_SVG_RESULT',
        message: buildNonSvgMessage(
          'Recraft result URL resolved to a non-SVG payload. This adapter only accepts SVG/vector payloads.',
          data
        )
      }
    };
  }

  const shapeSummary = summarizeResponseShape(data);
  return {
    success: false,
    error: {
      code: 'RECRAFT_EMPTY_RESULT',
      message: `Recraft returned no supported SVG payload. ${shapeSummary}. Provider returned OK before local extraction failed; account may have been charged.`
    }
  };
}

function finalizeRecraftAsset(config: DesignAssetsConfig, data: Record<string, any>, rawSvg: string, input: RecraftVectorRequest, providerUrl?: string) {
  const sanitized = sanitizeSvg(rawSvg, { maxBytes: 2 * 1024 * 1024 });
  const sha256 = bytesSha256(Buffer.from(sanitized.svgText, 'utf8'));
  const createdAt = new Date().toISOString();
  const output: AssetPayload = {
    assetId: typeof data.id === 'string' ? data.id : `recraft:${sha256.slice(0, 16)}`,
    encoding: input.outputEncoding ?? 'svgText',
    svgText: input.outputEncoding === 'base64' ? undefined : sanitized.svgText,
    svgBase64: input.outputEncoding === 'base64' ? Buffer.from(sanitized.svgText, 'utf8').toString('base64') : undefined,
    sha256,
    byteLength: Buffer.byteLength(sanitized.svgText, 'utf8'),
    recommendedFilename: `${sha256.slice(0, 16)}.svg`,
    metadata: {
      source: 'recraft',
      prompt: input.prompt,
      model: input.model ?? 'recraftv4_1_vector',
      style: normalizeVectorStyle(input.style),
      providerAssetId: typeof data.id === 'string' ? data.id : undefined,
      providerUrl,
      createdAt,
      provenance: {
        steps: [
          step('recraft-request', { prompt: input.prompt, style: normalizeVectorStyle(input.style), model: input.model ?? 'recraftv4_1_vector', size: normalizeVectorSize(input.size ?? input.aspectRatio) }, { outputSha256: sha256 })
        ]
      },
      cost: {
        currency: 'USD',
        estimatedUsd: input.maxCostUsd
      }
    },
    safetyReport: sanitized.safetyReport,
    previewPngBase64: input.includePreview ? renderPreview(sanitized.svgText) : undefined
  } as const;

  appendLedgerEntry({
    at: createdAt,
    assetId: output.assetId,
    requestedUsd: input.maxCostUsd,
    actualUsd: input.maxCostUsd,
    model: input.model ?? 'recraftv4_1_vector'
  }, ensureLedgerPath(config.recraftLedgerPath));

  return { success: true, asset: output };
}

function compactObject<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null));
}

function joinUrlPath(baseUrl: string, path: string) {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\//, ''), normalizedBase).toString();
}

function normalizeVectorStyle(style?: string) {
  if (style === 'digital_illustration') {
    // Recraft's vector endpoint accepts vector-oriented styles; map the raster-oriented one explicitly.
    return 'vector_illustration';
  }
  if (style === 'icon' || style === 'logo' || style === 'vector_illustration' || style === 'any') {
    return style;
  }
  return undefined;
}

function normalizeVectorSize(size?: string) {
  const trimmed = size?.trim();
  if (!trimmed) return undefined;
  if (/^\d+:\d+$/.test(trimmed) || /^\d+x\d+$/.test(trimmed)) {
    return trimmed;
  }
  return undefined;
}

function extractInlineSvg(data: Record<string, any>) {
  const svgText = data.svg ?? data.data?.[0]?.svg ?? data.output?.svg;
  return typeof svgText === 'string' ? svgText : null;
}

function extractBase64Candidate(data: Record<string, any>) {
  const candidate = data.svgBase64 ?? data.data?.[0]?.svgBase64 ?? data.data?.[0]?.b64_json ?? data.b64_json ?? data.image?.b64_json;
  return typeof candidate === 'string' ? candidate : null;
}

function extractUrlCandidate(data: Record<string, any>) {
  const candidate = data.data?.[0]?.url ?? data.url ?? data.image?.url;
  return typeof candidate === 'string' ? candidate : null;
}

function decodeBase64Candidate(base64Value: string) {
  try {
    return { ok: true as const, value: Buffer.from(base64Value.trim(), 'base64').toString('utf8') };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : 'base64 decode failed' };
  }
}

function looksLikeSvgText(text: string) {
  const trimmed = text.trimStart();
  return /^(<\?xml\b[^>]*\?>\s*)?<svg\b/i.test(trimmed);
}

function maybeDecodeTextAsBase64(text: string) {
  const compact = text.trim().replace(/\s+/g, '');
  if (!compact || compact.length < 16 || compact.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
  try {
    return Buffer.from(compact, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function summarizeResponseShape(data: Record<string, any>) {
  const topLevelKeys = Object.keys(data).slice(0, 20);
  const data0 = Array.isArray(data.data) && data.data[0] && typeof data.data[0] === 'object' ? Object.keys(data.data[0]).slice(0, 20) : [];
  const flags = {
    svg: Boolean(data.svg ?? data.data?.[0]?.svg ?? data.output?.svg),
    svgBase64: Boolean(data.svgBase64 ?? data.data?.[0]?.svgBase64 ?? data.data?.[0]?.b64_json ?? data.b64_json ?? data.image?.b64_json),
    url: Boolean(data.data?.[0]?.url ?? data.url ?? data.image?.url)
  };
  return `shape summary: top-level keys=${JSON.stringify(topLevelKeys)} data[0] keys=${JSON.stringify(data0)} fields=${JSON.stringify(flags)}`;
}

function buildNonSvgMessage(prefix: string, data: Record<string, any>) {
  return `${prefix} This adapter only accepts SVG/vector payloads. ${summarizeResponseShape(data)}. Provider returned OK before local extraction failed; account may have been charged.`;
}

async function parseJsonResponse(response: Response) {
  try {
    const text = await response.text();
    if (!text.trim()) {
      return { ok: false as const, error: 'empty response body' };
    }
    return { ok: true as const, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : 'failed to parse JSON' };
  }
}

async function readResponseBodyExcerpt(response: Response) {
  try {
    const text = await response.text();
    const trimmed = text.trim();
    if (!trimmed) return '';
    const parsed = tryParseJson(trimmed);
    if (parsed !== null) {
      const compact = compactJsonExcerpt(parsed);
      return compact.length > 1000 ? `${compact.slice(0, 1000)}…` : compact;
    }
    return trimmed.length > 1000 ? `${trimmed.slice(0, 1000)}…` : trimmed;
  } catch {
    return '';
  }
}

function tryParseJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function compactJsonExcerpt(value: unknown) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const selected: Record<string, unknown> = {};
    for (const key of ['error', 'message', 'detail', 'details', 'errors']) {
      if (record[key] !== undefined) selected[key] = record[key];
    }
    if (Object.keys(selected).length > 0) {
      return JSON.stringify(selected);
    }
  }
  return JSON.stringify(value);
}

function formatRequestFailureMessage(status: number, statusText: string, bodyExcerpt: string) {
  const suffix = bodyExcerpt ? ` Body: ${bodyExcerpt}` : '';
  return `Recraft request failed: ${status} ${statusText}.${suffix}`;
}

async function fetchVectorResult(url: string, fetchImpl: typeof fetch) {
  try {
    const response = await fetchImpl(url, { method: 'GET' });
    if (!response.ok) {
      const bodyExcerpt = await readResponseBodyExcerpt(response);
      return {
        ok: false as const,
        message: formatResultFetchFailureMessage(response.status, response.statusText, bodyExcerpt)
      };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? '';
    const text = buffer.toString('utf8');
    if (contentType.includes('svg') || looksLikeSvgText(text)) {
      return { ok: true as const, value: text };
    }
    return { ok: true as const, value: text };
  } catch (error) {
    return {
      ok: false as const,
      message: `Recraft result fetch failed for ${url}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function formatResultFetchFailureMessage(status: number, statusText: string, bodyExcerpt: string) {
  const suffix = bodyExcerpt ? ` Body: ${bodyExcerpt}` : '';
  return `Recraft result fetch failed: ${status} ${statusText}.${suffix}`;
}
