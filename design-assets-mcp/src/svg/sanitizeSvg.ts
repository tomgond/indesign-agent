import { normalizeSvg } from './normalizeSvg.js';
import { validateSvg } from './validateSvg.js';

export function sanitizeSvg(svgText: string, options: { allowEmbeddedImages?: boolean; maxBytes?: number } = {}) {
  const validated = validateSvg(svgText, options);
  return {
    svgText: normalizeSvg(validated.normalizedSvgText),
    safetyReport: validated.safetyReport
  };
}
