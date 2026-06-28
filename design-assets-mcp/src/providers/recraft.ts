import { readFileSync } from 'node:fs';

import type { DesignAssetsConfig } from '../config.js';
import { appendLedgerEntry, dailyUsdSpent, ensureLedgerPath } from '../cache/costLedger.js';
import { sanitizeSvg } from '../svg/sanitizeSvg.js';
import { bytesSha256 } from '../svg/hash.js';
import { renderPreview } from '../svg/renderPreview.js';
import { step } from '../cache/provenance.js';

export type RecraftVectorRequest = {
  prompt: string;
  style?: string;
  aspectRatio?: string;
  model?: string;
  allowText?: boolean;
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

  const endpoint = new URL('/v1/images/generations', config.recraftApiBaseUrl).toString();
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.recraftApiToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      prompt: input.prompt,
      style: input.style,
      aspect_ratio: input.aspectRatio,
      model: input.model,
      allow_text: input.allowText,
      negative_prompt: input.negativePrompt,
      seed: input.seed
    })
  });

  if (!response.ok) {
    return { success: false, error: { code: 'RECRAFT_REQUEST_FAILED', message: `Recraft request failed: ${response.status} ${response.statusText}` } };
  }

  const data = await response.json() as any;
  const svgText = data.svg ?? data.data?.[0]?.svg ?? data.output?.svg ?? null;
  const svgBase64 = data.svgBase64 ?? data.data?.[0]?.svgBase64 ?? null;
  const rawSvg = svgText ?? (svgBase64 ? Buffer.from(svgBase64, 'base64').toString('utf8') : null);
  if (!rawSvg) {
    return { success: false, error: { code: 'RECRAFT_EMPTY_RESULT', message: 'Recraft returned no SVG payload' } };
  }

  const sanitized = sanitizeSvg(rawSvg, { maxBytes: 2 * 1024 * 1024 });
  const sha256 = bytesSha256(Buffer.from(sanitized.svgText, 'utf8'));
  const createdAt = new Date().toISOString();
  const output = {
    assetId: data.id ?? `recraft:${sha256.slice(0, 16)}`,
    encoding: input.outputEncoding ?? 'svgText',
    svgText: input.outputEncoding === 'base64' ? undefined : sanitized.svgText,
    svgBase64: input.outputEncoding === 'base64' ? Buffer.from(sanitized.svgText, 'utf8').toString('base64') : undefined,
    sha256,
    byteLength: Buffer.byteLength(sanitized.svgText, 'utf8'),
    recommendedFilename: `${sha256.slice(0, 16)}.svg`,
    metadata: {
      source: 'recraft',
      prompt: input.prompt,
      model: input.model,
      style: input.style,
      createdAt,
      provenance: {
        steps: [
          step('recraft-request', { prompt: input.prompt, style: input.style, model: input.model, aspectRatio: input.aspectRatio }, { outputSha256: sha256 })
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
    model: input.model ?? null
  }, ensureLedgerPath(config.recraftLedgerPath));

  return { success: true, asset: output };
}
