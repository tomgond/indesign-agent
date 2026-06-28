import { materializeAssetInputSchema } from '../schemas/toolSchemas.js';
import { sanitizeSvg } from '../svg/sanitizeSvg.js';
import { bytesSha256 } from '../svg/hash.js';
import { renderPreview } from '../svg/renderPreview.js';
import { getTablerSvg } from '../providers/tabler.js';
import { getIconifyLocalSvg } from '../providers/iconifyLocal.js';
import { writeCachedAsset } from '../cache/assetCache.js';
import { step } from '../cache/provenance.js';
import { fail, ok } from './shared.js';
import type { AssetPayload } from '../schemas/assetPayload.js';

function resolveCandidate(candidate: Record<string, unknown>) {
  const source = String(candidate.source ?? '');
  const providerAssetId = String(candidate.providerAssetId ?? '');
  if (source === 'tabler') return getTablerSvg(providerAssetId);
  if (source === 'iconify-local') return getIconifyLocalSvg(providerAssetId);
  if (source === 'iconify-api') {
    throw new Error('Remote Iconify API candidates are discovery-only in this build. Install a local collection or use a Tabler candidate.');
  }
  if (typeof candidate.svgText === 'string') return candidate.svgText;
  throw new Error(`Unsupported candidate source: ${source}`);
}

export async function materializeAsset(input: unknown, options: { includePreview?: boolean } = {}) {
  const parsed = materializeAssetInputSchema.safeParse(input);
  if (!parsed.success) {
    return fail('INVALID_INPUT', parsed.error.message);
  }

  try {
    const candidate = parsed.data.candidate;
    const svgText = resolveCandidate(candidate);
    const sanitized = sanitizeSvg(svgText);
    const sha256 = bytesSha256(Buffer.from(sanitized.svgText, 'utf8'));
    const maxSvgBytes = parsed.data.maxSvgBytes ?? 2 * 1024 * 1024;
    if (Buffer.byteLength(sanitized.svgText, 'utf8') > maxSvgBytes) {
      return fail('ASSET_TOO_LARGE', `SVG exceeds maxSvgBytes of ${maxSvgBytes}`);
    }
    const createdAt = new Date().toISOString();
    const output: AssetPayload = {
      assetId: String(candidate.candidateId ?? candidate.providerAssetId ?? `asset:${sha256.slice(0, 16)}`),
      encoding: parsed.data.outputEncoding ?? 'svgText',
      svgText: parsed.data.outputEncoding === 'base64' ? undefined : sanitized.svgText,
      svgBase64: parsed.data.outputEncoding === 'base64' ? Buffer.from(sanitized.svgText, 'utf8').toString('base64') : undefined,
      sha256,
      byteLength: Buffer.byteLength(sanitized.svgText, 'utf8'),
      recommendedFilename: `${sha256.slice(0, 16)}.svg`,
      metadata: {
        title: typeof candidate.name === 'string' ? candidate.name : undefined,
        description: typeof candidate.description === 'string' ? candidate.description : undefined,
        source: String(candidate.source ?? 'tabler') as AssetPayload['metadata']['source'],
        providerAssetId: typeof candidate.providerAssetId === 'string' ? candidate.providerAssetId : undefined,
        providerUrl: typeof candidate.providerUrl === 'string' ? candidate.providerUrl : undefined,
        createdAt,
        tags: Array.isArray(candidate.tags) ? candidate.tags.map(String) : undefined,
        license: candidate.license as AssetPayload['metadata']['license'],
        provenance: {
          steps: [
            step('resolve-candidate', { candidateId: candidate.candidateId, source: candidate.source }, { outputSha256: sha256 })
          ]
        }
      },
      safetyReport: sanitized.safetyReport
    };
    if (parsed.data.includePreview) {
      try {
        output.previewPngBase64 = renderPreview(sanitized.svgText, { maxBytes: 2 * 1024 * 1024 });
      } catch (error) {
        if (error instanceof Error && error.message === 'PREVIEW_TOO_LARGE') {
          output.safetyReport = {
            ...output.safetyReport,
            warnings: [...output.safetyReport.warnings, 'Preview omitted because rendered PNG exceeded the cap']
          };
        } else {
          throw error;
        }
      }
    }
    writeCachedAsset(output);
    return ok({
      asset: output
    });
  } catch (error) {
    return fail('MATERIALIZE_FAILED', error instanceof Error ? error.message : 'materialization failed');
  }
}
