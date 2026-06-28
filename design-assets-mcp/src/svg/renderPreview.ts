import { Resvg } from '@resvg/resvg-js';

export function renderPreview(svgText: string, options: { maxWidth?: number; maxHeight?: number } = {}) {
  const resvg = new Resvg(svgText, {
    fitTo: {
      mode: options.maxWidth && options.maxHeight ? 'zoom' : 'width',
      value: options.maxWidth || options.maxHeight || 256
    }
  });
  const png = resvg.render().asPng();
  return Buffer.from(png).toString('base64');
}
