import { Resvg } from '@resvg/resvg-js';

const HARD_MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

export function renderPreview(svgText: string, options: { maxWidth?: number; maxHeight?: number; maxBytes?: number } = {}) {
  const maxBytes = Math.min(options.maxBytes ?? HARD_MAX_PREVIEW_BYTES, HARD_MAX_PREVIEW_BYTES);
  const resvg = new Resvg(svgText, {
    fitTo: {
      mode: options.maxWidth && options.maxHeight ? 'zoom' : 'width',
      value: options.maxWidth || options.maxHeight || 256
    }
  });
  const png = resvg.render().asPng();
  if (png.length > maxBytes) {
    throw new Error('PREVIEW_TOO_LARGE');
  }
  return Buffer.from(png).toString('base64');
}
