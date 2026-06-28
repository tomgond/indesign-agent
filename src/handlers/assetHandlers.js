import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { formatResponse, formatErrorResponse } from '../utils/stringUtils.js';
import { loadWorkspace } from '../core/workspaceState.js';
import { assertWorkspacePath } from '../utils/pathGuard.js';

const OPERATION = 'materialize_inline_svg_asset';
const SANITIZER_VERSION = 'mac-cheap-svg-validator-v2';
const DEFAULT_MAX_SVG_BYTES = 512 * 1024;
const HARD_MAX_SVG_BYTES = 2 * 1024 * 1024;
const HARD_MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_NODE_COUNT = 8000;
const MAX_PATH_COUNT = 4000;
const MAX_TEXT_LENGTH = 1_000_000;
const MAX_EMBEDDED_IMAGE_BYTES = 512 * 1024;
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

function decodeBase64Strict(value, fieldName = 'value') {
    const normalized = normalizeBase64(value);
    if (!normalized) throw new Error(`${fieldName} is required`);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
        throw new Error(`${fieldName} is not valid base64`);
    }
    const bytes = Buffer.from(normalized, 'base64');
    if (bytes.toString('base64') !== normalized) {
        throw new Error(`${fieldName} is not valid base64`);
    }
    return bytes;
}

function decodeUtf8Strict(bytes) {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const text = decoder.decode(bytes);
    if (!Buffer.from(text, 'utf8').equals(bytes)) {
        throw new Error('SVG payload is not valid UTF-8');
    }
    return text;
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
        const bytes = Buffer.from(svgText, 'utf8');
        const roundTrip = decodeUtf8Strict(bytes);
        if (roundTrip !== svgText) {
            throw new Error('svgText is not valid UTF-8');
        }
        return bytes;
    }

    const bytes = decodeBase64Strict(svgBase64, 'svgBase64');
    decodeUtf8Strict(bytes);
    return bytes;
}

function isSafeAssetKey(value) {
    return typeof value === 'string'
        && SAFE_ASSET_KEY.test(value)
        && value !== '.'
        && value !== '..'
        && !value.startsWith('.');
}

function safeAssetKey(assetId, sha256) {
    return isSafeAssetKey(assetId) ? assetId : sha256;
}

function sanitizeFilename(name) {
    if (!name || typeof name !== 'string') return null;
    return path.basename(name);
}

function writeAtomicFile(filePath, data, encoding = null) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tempPath = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
    if (encoding) {
        fs.writeFileSync(tempPath, data, { encoding });
    } else {
        fs.writeFileSync(tempPath, data);
    }
    fs.renameSync(tempPath, filePath);
}

function isExternalHref(value) {
    return /^(?:https?:|file:|\/\/|javascript:|data:)/i.test(value);
}

function validateEmbeddedImageDataUri(value) {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
    if (!match) return false;
    const bytes = Buffer.from(match[2], 'base64');
    return bytes.length > 0
        && bytes.length <= MAX_EMBEDDED_IMAGE_BYTES
        && bytes.toString('base64') === match[2];
}

function assertInsideImportsRoot(importsRoot, candidatePath) {
    const realImportsRoot = fs.realpathSync(importsRoot);
    const realCandidate = fs.realpathSync(candidatePath);
    const rel = path.relative(realImportsRoot, realCandidate);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error('Asset directory must stay inside workspace/assets/imports');
    }
    return realCandidate;
}

function hasUnsafeSvgContent(svgText, { allowEmbeddedImages = false } = {}) {
    const text = asString(svgText);
    const reasons = [];
    const warnings = [];
    const rejectedElements = [];
    const rejectedAttributes = [];

    if (!text.trim()) reasons.push('SVG payload is empty');
    if (text.length > MAX_TEXT_LENGTH) reasons.push(`SVG text exceeds maximum length of ${MAX_TEXT_LENGTH}`);
    if (!/^\s*(?:<\?xml[\s\S]*?\?>\s*)?<svg\b/i.test(text)) {
        reasons.push('SVG root element must be the first meaningful element');
    }
    if (!/<svg\b/i.test(text) || !/<\/svg\s*>/i.test(text)) {
        reasons.push('SVG root element is missing or not closed');
    }
    if (/<\s*!\s*doctype/i.test(text)) reasons.push('DOCTYPE declarations are not allowed');
    if (/<\s*!\s*entity/i.test(text)) reasons.push('ENTITY declarations are not allowed');

    const blockedTags = ['script', 'foreignObject', 'iframe', 'object', 'embed', 'video', 'audio', 'canvas'];
    for (const tag of blockedTags) {
        if (new RegExp(`<\\s*${tag}\\b`, 'i').test(text)) rejectedElements.push(tag);
    }
    if (!allowEmbeddedImages && /<\s*image\b/i.test(text)) rejectedElements.push('image');
    if (/<\s*animate[a-z]*\b/i.test(text)) rejectedElements.push('animate*');

    const eventAttrMatches = text.match(/\son[a-z]+\s*=/gi) || [];
    if (eventAttrMatches.length) {
        rejectedAttributes.push(...new Set(eventAttrMatches.map((match) => match.trim())));
    }

    if (/\bstyle\s*=\s*["'][^"']*(?:url\s*\(|@import|expression\s*\(|javascript:)/i.test(text)) {
        rejectedAttributes.push('style');
    }
    if (/<\s*style\b[^>]*>[\s\S]*?(?:url\s*\(|@import|expression\s*\(|javascript:)[\s\S]*?<\/\s*style\s*>/i.test(text)) {
        rejectedAttributes.push('style contents');
    }
    if (/url\s*\(/i.test(text)) rejectedAttributes.push('url()');
    if (/@import/i.test(text)) rejectedAttributes.push('@import');
    if (/expression\s*\(/i.test(text)) rejectedAttributes.push('expression()');
    if (/javascript\s*:/i.test(text)) rejectedAttributes.push('javascript:');

    const hrefMatches = [...text.matchAll(/<\s*([a-z][a-z0-9:-]*)\b[^>]*\b(?:xlink:)?href\s*=\s*["']([^"']+)["'][^>]*>/gi)];
    for (const match of hrefMatches) {
        const tagName = String(match[1] || '').toLowerCase();
        const value = String(match[2] || '').trim();
        if (!value || value.startsWith('#')) continue;
        if (allowEmbeddedImages && tagName === 'image' && validateEmbeddedImageDataUri(value)) continue;
        if (isExternalHref(value)) {
            rejectedAttributes.push(`${tagName} href=${value}`);
            continue;
        }
        rejectedAttributes.push(`${tagName} href=${value}`);
    }

    if (allowEmbeddedImages) {
        const imageTags = [...text.matchAll(/<\s*image\b[^>]*>/gi)];
        for (const match of imageTags) {
            const fragment = String(match[0] || '');
            const embeddedHref = fragment.match(/\b(?:xlink:)?href\s*=\s*["']([^"']+)["']/i)?.[1];
            if (embeddedHref && embeddedHref.startsWith('data:') && !validateEmbeddedImageDataUri(embeddedHref.trim())) {
                rejectedAttributes.push('image embedded data URI');
            }
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
    const asset = args.asset && typeof args.asset === 'object' && !Array.isArray(args.asset) ? args.asset : null;
    const payload = { ...args, ...(asset || {}) };
    const encoding = payload.encoding || null;
    const svgText = payload.svgText ?? null;
    const svgBase64 = payload.svgBase64 ?? null;
    const sha256 = payload.sha256 ?? null;
    const byteLength = payload.byteLength ?? null;
    const maxSvgBytes = payload.maxSvgBytes ?? null;
    const recommendedFilename = sanitizeFilename(payload.recommendedFilename ?? null);
    const assetId = typeof payload.assetId === 'string' ? payload.assetId : null;
    const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
    const safetyReport = payload.safetyReport && typeof payload.safetyReport === 'object' ? payload.safetyReport : {};
    const previewPngBase64 = payload.previewPngBase64 ?? null;

    return {
        assetId,
        encoding,
        svgText,
        svgBase64,
        sha256,
        byteLength,
        maxSvgBytes,
        recommendedFilename,
        metadata,
        safetyReport,
        previewPngBase64,
        allowEmbeddedImages: payload.allowEmbeddedImages === true
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
    if (bytes.length < 8 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
        throw new Error('previewPngBase64 must be a PNG image');
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
            const svgText = decodeUtf8Strict(svgBytes);

            if (svgBytes.length > HARD_MAX_SVG_BYTES) {
                throw new Error(`SVG payload exceeds hard limit of ${HARD_MAX_SVG_BYTES} bytes`);
            }

            const declaredMax = input.maxSvgBytes == null ? DEFAULT_MAX_SVG_BYTES : Number(input.maxSvgBytes);
            if (!Number.isFinite(declaredMax) || declaredMax <= 0) {
                throw new Error('maxSvgBytes must be a positive number');
            }
            if (declaredMax > HARD_MAX_SVG_BYTES) {
                throw new Error(`maxSvgBytes exceeds hard limit of ${HARD_MAX_SVG_BYTES} bytes`);
            }
            if (svgBytes.length > declaredMax) {
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
            const realAssetDir = assertInsideImportsRoot(importsRoot, assetDir);

            const assetPath = assertWorkspacePath(path.join(realAssetDir, 'asset.svg'), { kind: 'assets', manifest }).path;
            const metadataPath = assertWorkspacePath(path.join(realAssetDir, 'metadata.json'), { kind: 'assets', manifest }).path;
            const previewPath = input.previewPngBase64 ? assertWorkspacePath(path.join(realAssetDir, 'preview.png'), { kind: 'assets', manifest }).path : null;
            const previewBytes = validatePreviewBase64(input.previewPngBase64);

            writeAtomicFile(assetPath, svgBytes);
            if (previewBytes) {
                writeAtomicFile(previewPath, previewBytes);
            }

            const receivedAt = new Date().toISOString();
            const sourceMetadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
            const storedMetadata = {
                assetId: input.assetId || null,
                safeAssetKey: assetKey,
                assetKey,
                recommendedFilename: input.recommendedFilename || null,
                encoding: input.svgText != null ? 'svgText' : 'base64',
                suppliedSha256: input.sha256 || null,
                receivedSha256: input.sha256 || computedSha,
                computedSha256: computedSha,
                suppliedByteLength: input.byteLength ?? null,
                byteLength: computedByteLength,
                receivedAt,
                source: sourceMetadata.source || null,
                metadata: sourceMetadata,
                safetyReport: {
                    ...safetyReport,
                    ...input.safetyReport,
                    validatorVersion: SANITIZER_VERSION,
                    receivedAt,
                    passed: true,
                    rejectedReasons: [],
                    warnings: [...(safetyReport.warnings || []), ...((input.safetyReport && input.safetyReport.warnings) || [])],
                    removedElements: [],
                    removedAttributes: [],
                    nodeCount: safetyReport.nodeCount,
                    pathCount: safetyReport.pathCount,
                    hasText: safetyReport.hasText,
                    hasEmbeddedImages: safetyReport.hasEmbeddedImages,
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
                warnings: [...(safetyReport.warnings || [])],
                assetId: input.assetId || assetKey,
                assetKey,
                safeAssetKey: assetKey,
                materializedAt: receivedAt
            };
        })());
    }
}
