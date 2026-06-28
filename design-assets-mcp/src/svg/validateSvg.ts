import { XMLParser, XMLValidator } from 'fast-xml-parser';

import type { SafetyReport } from '../schemas/assetPayload.js';

const SANITIZER_VERSION = 'design-assets-mcp-svg-sanitizer-v1';
const MAX_NODES = 8000;
const MAX_PATHS = 4000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_PATH_DATA = 2 * 1024 * 1024;
const MAX_VIEWBOX = 100000;
const IMAGE_DATA_URI_RE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i;
const BLOCKED_TAGS = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed', 'video', 'audio', 'canvas', 'link', 'meta']);
const BLOCKED_ANIMATION_TAGS = new Set(['animate', 'animatemotion', 'animatetransform', 'set']);

export type SvgValidationOptions = {
  allowEmbeddedImages?: boolean;
  maxBytes?: number;
};

export type SvgValidationResult = {
  normalizedSvgText: string;
  safetyReport: SafetyReport;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseViewBox(value: unknown) {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  return parts;
}

function normalizeNumber(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validateStyleText(value: string, rejected: string[]) {
  if (/(?:url\s*\(|@import|expression\s*\(|javascript:)/i.test(value)) {
    rejected.push('style');
  }
}

function inspectAttributes(attributes: Record<string, unknown>, tagName: string, allowEmbeddedImages: boolean, rejectedReasons: string[], rejectedAttributes: string[], warnings: string[]) {
  for (const [name, rawValue] of Object.entries(attributes)) {
    if (!name) continue;
    const lower = name.toLowerCase();
    const value = String(rawValue ?? '').trim();

    if (lower.startsWith('on')) {
      rejectedAttributes.push(`${tagName}.${name}`);
    }
    if (lower === 'style') {
      validateStyleText(value, rejectedAttributes);
    }
    if (lower === 'href' || lower === 'xlink:href' || lower.endsWith(':href') || lower === 'src') {
      if (value.startsWith('#')) continue;
      if (allowEmbeddedImages && tagName === 'image' && IMAGE_DATA_URI_RE.test(value)) {
        const match = IMAGE_DATA_URI_RE.exec(value);
        const bytes = Buffer.from(match?.[2] ?? '', 'base64');
        if (bytes.length > 512 * 1024) {
          rejectedAttributes.push(`${tagName}.${name}`);
        }
        continue;
      }
      rejectedAttributes.push(`${tagName}.${name}`);
      continue;
    }
    if (lower === 'viewbox') {
      const viewBox = parseViewBox(value);
      if (!viewBox) {
        rejectedReasons.push('Invalid viewBox');
        continue;
      }
      if (viewBox.some((part) => Math.abs(part) > MAX_VIEWBOX)) {
        rejectedReasons.push('viewBox exceeds size bounds');
      }
    }
    if (lower === 'width' || lower === 'height' || lower === 'x' || lower === 'y') {
      const numeric = normalizeNumber(value);
      if (numeric != null && Math.abs(numeric) > MAX_VIEWBOX) {
        warnings.push(`large ${tagName}.${name}`);
      }
    }
  }
}

function walkNode(node: unknown, state: {
  nodeCount: number;
  pathCount: number;
  pathDataLength: number;
  hasText: boolean;
  hasEmbeddedImages: boolean;
  rejectedReasons: string[];
  rejectedElements: string[];
  rejectedAttributes: string[];
  warnings: string[];
  allowEmbeddedImages: boolean;
}) {
  if (Array.isArray(node)) {
    for (const child of node) walkNode(child, state);
    return;
  }
  if (!isPlainObject(node)) return;

  for (const [key, value] of Object.entries(node)) {
    if (key === '#text') {
      if (String(value ?? '').trim()) state.hasText = true;
      continue;
    }
    if (key === '#comment' || key === '?xml') continue;
    if (key.startsWith('@_')) continue;

    const tagName = key.toLowerCase();
    state.nodeCount += 1;
    if (tagName === 'path') state.pathCount += 1;
    if (tagName === 'image') state.hasEmbeddedImages = true;

    if (BLOCKED_TAGS.has(tagName)) state.rejectedElements.push(tagName);
    if (BLOCKED_ANIMATION_TAGS.has(tagName)) state.rejectedElements.push(tagName);
    if (tagName === 'image' && !state.allowEmbeddedImages) state.rejectedElements.push('image');

    const attrs: Record<string, unknown> = {};
    const children: unknown[] = [];
    const rawText = typeof value === 'string' ? value : isPlainObject(value) ? String(value['#text'] ?? '') : '';

    if (isPlainObject(value)) {
      for (const [childKey, childValue] of Object.entries(value)) {
        if (childKey.startsWith('@_')) {
          attrs[childKey.slice(2)] = childValue;
        } else {
          children.push({ [childKey]: childValue });
        }
      }
      inspectAttributes(attrs, tagName, state.allowEmbeddedImages, state.rejectedReasons, state.rejectedAttributes, state.warnings);
    } else if (Array.isArray(value)) {
      children.push(...value);
    } else if (typeof value === 'string' && value.trim()) {
      state.hasText = true;
    }

    if (tagName === 'style' && /(?:url\s*\(|@import|expression\s*\(|javascript:)/i.test(rawText)) {
      state.rejectedAttributes.push('style contents');
    }

    const pathData = attrs.d || attrs.D;
    if (typeof pathData === 'string') {
      state.pathDataLength += pathData.length;
    }
    if (state.pathDataLength > MAX_TOTAL_PATH_DATA) {
      state.rejectedReasons.push('path data exceeds limit');
    }

    for (const child of children) walkNode(child, state);
  }
}

export function validateSvg(svgText: string, options: SvgValidationOptions = {}): SvgValidationResult {
  const allowEmbeddedImages = options.allowEmbeddedImages === true;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const text = String(svgText ?? '');
  const rejectedReasons: string[] = [];
  const rejectedElements: string[] = [];
  const rejectedAttributes: string[] = [];
  const warnings: string[] = [];

  if (!text.trim()) rejectedReasons.push('SVG payload is empty');
  if (Buffer.byteLength(text, 'utf8') > maxBytes) rejectedReasons.push(`SVG payload exceeds maximum size of ${maxBytes} bytes`);
  if (/<\s*!\s*doctype/i.test(text)) rejectedReasons.push('DOCTYPE declarations are not allowed');
  if (/<\s*!\s*entity/i.test(text)) rejectedReasons.push('ENTITY declarations are not allowed');
  if (!/^\s*(?:<\?xml[\s\S]*?\?>\s*)?<svg\b/i.test(text)) rejectedReasons.push('SVG root element must be the first meaningful element');

  const xmlError = XMLValidator.validate(text);
  if (xmlError !== true) {
    rejectedReasons.push(typeof xmlError === 'string' ? xmlError : 'Invalid XML');
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    allowBooleanAttributes: false,
    processEntities: false,
    trimValues: false,
    parseTagValue: false,
    commentPropName: '#comment',
    preserveOrder: false
  });

  const parsed = parser.parse(text) as Record<string, unknown>;
  const rootKey = Object.keys(parsed).find((key) => !key.startsWith('?') && key !== '#comment');
  if (rootKey !== 'svg') {
    rejectedReasons.push('Root element must be <svg>');
  }

  const state = {
    nodeCount: 0,
    pathCount: 0,
    pathDataLength: 0,
    hasText: false,
    hasEmbeddedImages: false,
    rejectedReasons,
    rejectedElements,
    rejectedAttributes,
    warnings,
    allowEmbeddedImages
  };

  walkNode(parsed, state);

  if (state.nodeCount > MAX_NODES) state.rejectedReasons.push(`SVG node count exceeds maximum of ${MAX_NODES}`);
  if (state.pathCount > MAX_PATHS) state.rejectedReasons.push(`SVG path count exceeds maximum of ${MAX_PATHS}`);
  const allReasons = [
    ...state.rejectedReasons,
    ...state.rejectedElements.map((value) => `Rejected element: ${value}`),
    ...state.rejectedAttributes.map((value) => `Rejected attribute/content: ${value}`)
  ];

  const safetyReport: SafetyReport = {
    sanitizerVersion: SANITIZER_VERSION,
    passed: allReasons.length === 0,
    rejectedReasons: [...new Set(allReasons)],
    warnings: [...new Set(state.warnings)],
    removedElements: [],
    removedAttributes: [],
    nodeCount: state.nodeCount,
    pathCount: state.pathCount,
    byteLength: Buffer.byteLength(text, 'utf8'),
    hasEmbeddedImages: state.hasEmbeddedImages,
    hasText: state.hasText
  };

  if (!safetyReport.passed) {
    throw new Error(`SVG rejected: ${safetyReport.rejectedReasons.join('; ')}`);
  }

  return { normalizedSvgText: normalizeSvgText(text), safetyReport };
}

export function normalizeSvgText(svgText: string) {
  return String(svgText ?? '').trim().replace(/\r\n/g, '\n');
}
