import { previewAssetInputSchema } from '../schemas/toolSchemas.js';
import { sanitizeSvg } from '../svg/sanitizeSvg.js';
import { renderPreview } from '../svg/renderPreview.js';
import { fail, ok } from './shared.js';

function decodeSvg(input: unknown) {
  const parsed = previewAssetInputSchema.safeParse(input);
  if (!parsed.success) {
    return { error: fail('INVALID_INPUT', parsed.error.message) };
  }
  const value = parsed.data;
  const svgText = value.svgText ?? Buffer.from(value.svgBase64 ?? '', 'base64').toString('utf8');
  return { value, svgText };
}

export async function previewAsset(input: unknown) {
  const decoded = decodeSvg(input);
  if ('error' in decoded) return decoded.error;
  try {
    const sanitized = sanitizeSvg(decoded.svgText);
    return ok({
      assetId: decoded.value.assetId ?? null,
      previewPngBase64: renderPreview(sanitized.svgText, {
        maxWidth: decoded.value.maxWidth,
        maxHeight: decoded.value.maxHeight
      }),
      safetyReport: sanitized.safetyReport
    });
  } catch (error) {
    return fail('PREVIEW_FAILED', error instanceof Error ? error.message : 'preview failed');
  }
}
