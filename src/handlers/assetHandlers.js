import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { formatResponse, formatErrorResponse } from '../utils/stringUtils.js';
import { loadWorkspace } from '../core/workspaceState.js';
import { assertWorkspacePath } from '../utils/pathGuard.js';

const OPERATION = 'materialize_inline_svg_asset';
const SANITIZER_VERSION = 'mac-cheap-svg-validator-v1';
const DEFAULT_MAX_SVG_BYTES = 512 * 1024;
const HARD_MAX_SVG_BYTES = 2 * 1024 * 1024;
const HARD_MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_NODE_COUNT = 8000;
const MAX_PATH_COUNT = 4000;
const MAX_TEXT_LENGTH = 1_000_000;
const SAFE_ASSET_KEY = /^[a-zA-Z0-9._:-]{1,96}$/;

function response(promise, op = OPERATION) {
    return Promise.resolve(promise)
        .then((result) => formatResponse(result, op))
        .catch((error) => formatErrorResponse(error.message, op));
}

function asString(value) {
    return typeof value === 'string' ? value : '';
}

function normalizeBase64(value) {
    return asString(value).replace(/\s+/g, '');
}

function decodeBase64Strict(value) {
    const normalized = normalizeBase64(value);
    if (!normalized) throw new Error('svgBase64 is required');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
        throw new Error('svgBase64 is not valid base64');
    }
    const bytes = Buffer.from(normalized, 'base64');
    if (bytes.toString('base64') !== normalized) {
        throw new Error('svgBase64 is not valid base64');
    }
    return bytes;
}

function decodeSvgPayload({ svgText, svgBase64, encoding }) {
    const hasText = svgText != null && svgText !== '';
    const hasBase64 = svgBase64 != null && svgBase64 !== '';
    if (hasText === hasBase64) {
        throw new Error('Provide exactly one of svgText or svgBase64');
    }
    if (encoding === 'svgText' && !hasText) throw new Error('encoding=svgText requires svgText');
    if (encoding === 'base64' && !hasBase64) throw new Error('encoding=base64 requires svgBase64');
    if (hasText) {
        if (typeof svgText !== 'string') throw new Error('svgText must be a string');
        return Buffer.from(svgText, 'utf8');
    }
    return decodeBase64Strict(svgBase64);
}

function safeAssetKey(assetId, sha256) {
    if (typeof assetId === 'string' && SAFE_ASSET_KEY.test(assetId)) return assetId;
    return sha256;
}

function sanitizeFilename(name) {
    if (!name || typeof name !== 'string') return null;
    return path.basename(name);
}

function writeAtomicFile(filePath, data, encoding = null) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tempPath = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
    const options = encoding ? { encoding } : undefined;
    if (options) {
        fs.writeFileSync(tempPath, data, options);
    } else {
        fs.writeFileSync(tempPath, data);
    }
    fs.renameSync(tempPath, filePath);
}

function hasUnsafeSvgContent(svgText, { allowEmbeddedImages = false } = {}) {
    const text = asString(svgText);
    const reasons = [];
    const warnings = [];
    const rejectedElements = [];
    const rejectedAttributes = [];

    if (!text.trim()) reasons.push('SVG payload is empty');
    if (text.length > MAX_TEXT_LENGTH) reasons.push(`SVG text exceeds maximum length of ${MAX_TEXT_LENGTH}`);
    if (/^\s*<\?xml/i.test(text) === false && !/^\s*<svg\b/i.test(text)) {
        reasons.push('SVG root element must be the first element');
    }
    if (!/<svg\b/i.test(text) || !/<\/svg\s*>/i.test(text)) {
        reasons.push('SVG root element is missing or not closed');
    }
    if (/<\s*!\s*doctype/i.test(text)) reasons.push('DOCTYPE declarations are not allowed');
    if (/<\s*!\s*entity/i.test(text)) reasons.push('ENTITY declarations are not allowed');
    if (/<\s*script\b/i.test(text)) rejectedElements.push('script');
    if (/<\s*foreignObject\b/i.test(text)) rejectedElements.push('foreignObject');
    if (/<\s*iframe\b/i.test(text)) rejectedElements.push('iframe');
    if (/<\s*object\b/i.test(text)) rejectedElements.push('object');
    if (/<\s*embed\b/i.test(text)) rejectedElements.push('embed');
    if (/<\s*video\b/i.test(text)) rejectedElements.push('video');
    if (/<\s*audio\b/i.test(text)) rejectedElements.push('audio');
    if (/<\s*canvas\b/i.test(text)) rejectedElements.push('canvas');
    if (!allowEmbeddedImages && /<\s*image\b/i.test(text)) rejectedElements.push('image');
    if (/<\s*animate[a-z]*\b/i.test(text)) rejectedElements.push('animate*');

    const eventAttrMatches = text.match(/\son[a-z]+\s*=/gi) || [];
    if (eventAttrMatches.length) rejectedAttributes.push(...new Set(eventAttrMatches.map((match) => match.trim())));

    if (/url\s*\(/i.test(text)) rejectedAttributes.push('style url()');
    if (/@import/i.test(text)) rejectedAttributes.push('@import');
    if (/expression\s*\(/i.test(text)) rejectedAttributes.push('expression()');
    if (/javascript\s*:/i.test(text)) rejectedAttributes.push('javascript:');
    if (/data\s*:/i.test(text) && !allowEmbeddedImages) rejectedAttributes.push('data:');

    const hrefMatches = [...text.matchAll(/\b(?:xlink:)?href\s*=\s*["']([^"']+)["']/gi)];
    for (const match of hrefMatches) {
        const value = String(match[1] || '').trim();
        if (!value) continue;
        if (value.startsWith('#')) continue;
        if (allowEmbeddedImages && value.startsWith('data:')) continue;
        if (/^(?:https?:|file:|\/\/|javascript:|data:)/i.test(value)) {
            rejectedAttributes.push(`${match[0].split('=')[0].trim()}=${value}`);
        } else if (!value.startsWith('#')) {
            rejectedAttributes.push(`${match[0].split('=')[0].trim()}=${value}`);
        }
    }

    const nodeCount = (text.match(/<(?!!|\/|\?)[a-zA-Z][^>]*>/g) || []).length;
    const pathCount = (text.match(/<\s*path\b/gi) || []).length;
    const textNodeCount = (text.match(/<\s*(?:text|tspan)\b/gi) || []).length;
    const hasEmbeddedImages = /<\s*image\b/i.test(text);
    const hasText = textNodeCount > 0;

    if (nodeCount > MAX_NODE_COUNT) reasons.push(`SVG node count exceeds maximum of ${MAX_NODE_COUNT}`);
    if (pathCount > MAX_PATH_COUNT) reasons.push(`SVG path count exceeds maximum of ${MAX_PATH_COUNT}`);
    if (text.length > HARD_MAX_SVG_BYTES * 8) warnings.push('SVG text is unusually large before byte validation');

    return {
        passed: reasons.length === 0 && rejectedElements.length === 0 && rejectedAttributes.length === 0,
        rejectedReasons: [...reasons, ...rejectedElements.map((name) => `Rejected element: ${name}`), ...rejectedAttributes.map((name) => `Rejected attribute/content: ${name}`)],
        warnings,
        removedElements: [],
        removedAttributes: [],
        nodeCount,
        pathCount,
        byteLength: Buffer.byteLength(text, 'utf8'),
        hasEmbeddedImages,
        hasText
    };
}

function resolveInlineSvgInput(args = {}) {
    const asset = args.asset && typeof args.asset === 'object' ? args.asset : null;
    const payload = asset || args;
    const encoding = payload.encoding || args.encoding || null;
    const svgText = payload.svgText ?? args.svgText ?? null;
    const svgBase64 = payload.svgBase64 ?? args.svgBase64 ?? null;
    const sha256 = payload.sha256 ?? args.sha256 ?? null;
    const byteLength = payload.byteLength ?? args.byteLength ?? null;
    const recommendedFilename = sanitizeFilename(payload.recommendedFilename ?? args.recommendedFilename ?? null);
    const assetId = typeof payload.assetId === 'string' ? payload.assetId : typeof args.assetId === 'string' ? args.assetId : null;
    const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : args.metadata && typeof args.metadata === 'object' ? args.metadata : {};
    const safetyReport = payload.safetyReport && typeof payload.safetyReport === 'object' ? payload.safetyReport : args.safetyReport && typeof args.safetyReport === 'object' ? args.safetyReport : {};
    const previewPngBase64 = payload.previewPngBase64 ?? args.previewPngBase64 ?? null;

    return {
        assetId,
        encoding,
        svgText,
        svgBase64,
        sha256,
        byteLength,
        recommendedFilename,
        metadata,
        safetyReport,
        previewPngBase64,
        allowEmbeddedImages: args.allowEmbeddedImages === true
    };
}

function validatePreviewBase64(previewPngBase64) {
    if (previewPngBase64 == null || previewPngBase64 === '') return null;
    const normalized = normalizeBase64(previewPngBase64);
    if (!normalized) return null;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
        throw new Error('previewPngBase64 is not valid base64');
    }
    const bytes = Buffer.from(normalized, 'base64');
    if (bytes.toString('base64') !== normalized) {
        throw new Error('previewPngBase64 is not valid base64');
    }
    if (bytes.length > HARD_MAX_PREVIEW_BYTES) {
        throw new Error(`previewPngBase64 exceeds maximum of ${HARD_MAX_PREVIEW_BYTES} bytes`);
    }
    return bytes;
}

export class AssetHandlers {
    static materializeInlineSvgAsset(args = {}) {
        return response((async () => {
            let manifest;
            try {
                manifest = loadWorkspace();
            } catch {
                throw new Error('Template workspace is not attached. Call attach_template_workspace({ workspaceRoot }) or init_template_workspace(...) first.');
            }

            const input = resolveInlineSvgInput(args);
            const svgBytes = decodeSvgPayload(input);
            const svgText = svgBytes.toString('utf8');

            if (svgBytes.length > HARD_MAX_SVG_BYTES) {
                throw new Error(`SVG payload exceeds hard limit of ${HARD_MAX_SVG_BYTES} bytes`);
            }
            const declaredMax = Number(args.maxSvgBytes ?? input.metadata?.maxSvgBytes ?? DEFAULT_MAX_SVG_BYTES);
            if (Number.isFinite(declaredMax) && declaredMax > 0 && svgBytes.length > declaredMax) {
                throw new Error(`SVG payload exceeds maxSvgBytes of ${declaredMax} bytes`);
            }

            const safetyReport = hasUnsafeSvgContent(svgText, { allowEmbeddedImages: input.allowEmbeddedImages });
            if (!safetyReport.passed) {
                throw new Error(`SVG payload rejected by cheap validator: ${safetyReport.rejectedReasons.join('; ')}`);
            }

            const computedSha = crypto.createHash('sha256').update(svgBytes).digest('hex');
            const computedByteLength = svgBytes.length;

            if (input.sha256 && input.sha256 !== computedSha) {
                throw new Error(`SHA-256 mismatch: expected ${input.sha256}, got ${computedSha}`);
            }
            if (input.byteLength != null && Number(input.byteLength) !== computedByteLength) {
                throw new Error(`byteLength mismatch: expected ${input.byteLength}, got ${computedByteLength}`);
            }

            const assetKey = safeAssetKey(input.assetId, computedSha);
            const importsRoot = path.join(manifest.workspaceRoot, 'assets', 'imports');
            const assetDir = path.join(importsRoot, assetKey);
            fs.mkdirSync(assetDir, { recursive: true });

            const assetPath = assertWorkspacePath(path.join(assetDir, 'asset.svg'), { kind: 'assets', manifest }).path;
            const metadataPath = assertWorkspacePath(path.join(assetDir, 'metadata.json'), { kind: 'assets', manifest }).path;
            const previewPath = input.previewPngBase64 ? assertWorkspacePath(path.join(assetDir, 'preview.png'), { kind: 'assets', manifest }).path : null;
            const previewBytes = validatePreviewBase64(input.previewPngBase64);

            writeAtomicFile(assetPath, svgBytes);

            if (previewBytes) {
                writeAtomicFile(previewPath, previewBytes);
            }

            const materializedAt = new Date().toISOString();
            const sourceMetadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
            const storedMetadata = {
                assetId: input.assetId || null,
                assetKey,
                recommendedFilename: input.recommendedFilename || null,
                encoding: input.svgText != null ? 'svgText' : 'base64',
                receivedSha256: input.sha256 || computedSha,
                receivedByteLength: input.byteLength ?? computedByteLength,
                sha256: computedSha,
                byteLength: computedByteLength,
                materializedAt,
                source: sourceMetadata.source || null,
                metadata: sourceMetadata,
                safetyReport: {
                    ...safetyReport,
                    ...input.safetyReport,
                    sanitizerVersion: SANITIZER_VERSION,
                    receivedAt: materializedAt,
                    passed: true,
                    rejectedReasons: [],
                    warnings: [...(safetyReport.warnings || []), ...((input.safetyReport && input.safetyReport.warnings) || [])],
                    removedElements: [],
                    removedAttributes: [],
                    byteLength: computedByteLength
                }
            };

            writeAtomicFile(metadataPath, `${JSON.stringify(storedMetadata, null, 2)}\n`, 'utf8');

            return {
                success: true,
                assetPath,
                metadataPath,
                ...(previewPath ? { previewPath } : {}),
                readyForPlacement: true,
                sha256: computedSha,
                byteLength: computedByteLength,
                warnings: [],
                assetId: input.assetId || assetKey,
                assetKey,
                materializedAt
            };
        })());
    }
}
