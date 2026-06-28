import { XMLBuilder, XMLParser } from 'fast-xml-parser';

import { normalizeSvgText } from './validateSvg.js';

export function normalizeSvg(svgText: string) {
  const trimmed = normalizeSvgText(svgText);
  const parser = new XMLParser({
    ignoreAttributes: false,
    allowBooleanAttributes: false,
    processEntities: false,
    trimValues: false,
    parseTagValue: false
  });
  const parsed = parser.parse(trimmed);
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    format: false,
    suppressEmptyNode: true
  });
  return builder.build(parsed);
}
