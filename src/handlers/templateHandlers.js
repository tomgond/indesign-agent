import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ScriptExecutor } from '../core/scriptExecutor.js';
import { getUxpBusyGateStatus } from '../core/uxpBusyGate.js';
import { formatResponse, formatErrorResponse } from '../utils/stringUtils.js';
import { initWorkspace, attachWorkspace, loadWorkspace, getWorkspace, saveWorkspace, nextVersionId, upsertDerivative, upsertDerivativePage, fileStatEvidence, validateWorkspaceFiles } from '../core/workspaceState.js';
import { assertWorkspacePath, safeBasename } from '../utils/pathGuard.js';
import { imageInfo } from '../utils/imageInfo.js';
import { buildMcpImagePayload } from '../utils/mcpImage.js';
import { appendRuntimeLog, readRuntimeLogs, resolveRuntimeLogPath } from '../core/runtimeLogger.js';
import os from 'node:os';
import { isDeepStrictEqual } from 'node:util';

const LABEL_KEY = 'mcpTemplateLabel';
const DESIGN_QUALITY_CATEGORIES = Object.freeze([
    'hierarchy', 'alignment', 'spacing', 'typography', 'contrastColor', 'imageUse',
    'styleConsistency', 'editability', 'productionRisk'
]);
const BLOCKING_ACCEPTANCE_IMPACTS = new Set([
    'userAcceptanceCriteria', 'readability', 'editability', 'productionSafety'
]);

function isRecord(value) {
    return value != null && typeof value === 'object' && !Array.isArray(value);
}

function unresolvedReviewItems(value) {
    return (Array.isArray(value) ? value : []).filter((item) => item?.resolved !== true && item?.status !== 'resolved');
}

function normalizeDesignQualityReview(args) {
    const structuredKeys = [
        'overallStatus', 'confidence', 'sourceEvidence', 'categoryRatings', 'highSeverityIssues',
        'blockers', 'warnings', 'recommendedNextBatch', 'doNotChange'
    ];
    const suppliedRubric = isRecord(args.designQualityRubric) ? args.designQualityRubric : null;
    const hasStructuredReview = suppliedRubric != null || structuredKeys.some((key) => Object.hasOwn(args, key));
    if (!hasStructuredReview) {
        return {
            rubric: null,
            rubricCompleteness: 'none',
            presentCategories: [],
            missingCategories: [],
            schemaWarnings: [],
            blockerCount: 0
        };
    }

    const schemaWarnings = Array.isArray(suppliedRubric?.schemaWarnings) ? [...suppliedRubric.schemaWarnings] : [];
    if (Object.hasOwn(args, 'designQualityRubric') && args.designQualityRubric != null && !suppliedRubric) {
        schemaWarnings.push('designQualityRubric was not an object; preserved structured aliases only.');
    }

    const nestedCategories = suppliedRubric?.categories;
    const aliasCategories = args.categoryRatings;
    let categories = {};
    if (isRecord(nestedCategories)) {
        categories = nestedCategories;
        if (isRecord(aliasCategories) && !isDeepStrictEqual(nestedCategories, aliasCategories)) {
            schemaWarnings.push('designQualityRubric.categories differed from categoryRatings; nested categories were used.');
        }
    } else if (isRecord(aliasCategories)) {
        categories = aliasCategories;
        if (nestedCategories != null) schemaWarnings.push('designQualityRubric.categories was not an object; categoryRatings was used.');
    } else if (nestedCategories != null || aliasCategories != null) {
        schemaWarnings.push('No usable category object was supplied.');
    }

    const unknownCategories = Object.keys(categories).filter((name) => !DESIGN_QUALITY_CATEGORIES.includes(name));
    if (unknownCategories.length) schemaWarnings.push(`Unknown rubric categories were preserved: ${unknownCategories.join(', ')}.`);
    const presentCategories = DESIGN_QUALITY_CATEGORIES.filter((name) => isRecord(categories[name]));
    const invalidCategories = DESIGN_QUALITY_CATEGORIES.filter((name) => Object.hasOwn(categories, name) && !isRecord(categories[name]));
    if (invalidCategories.length) schemaWarnings.push(`Non-object rubric categories were treated as missing: ${invalidCategories.join(', ')}.`);
    const missingCategories = DESIGN_QUALITY_CATEGORIES.filter((name) => !presentCategories.includes(name));
    const rubricCompleteness = missingCategories.length ? 'partial' : 'complete';

    const readRubricField = (key, fallback) => {
        if (suppliedRubric && Object.hasOwn(suppliedRubric, key)) return suppliedRubric[key];
        if (Object.hasOwn(args, key)) return args[key];
        return fallback;
    };
    const highSeverityIssues = readRubricField('highSeverityIssues', []);
    const blockers = readRubricField('blockers', []);
    const rubric = {
        ...(suppliedRubric || {}),
        ...(suppliedRubric?.schemaVersion == null ? { schemaVersion: '1.0' } : {}),
        categories,
        highSeverityIssues: Array.isArray(highSeverityIssues) ? highSeverityIssues : [],
        blockers: Array.isArray(blockers) ? blockers : [],
        warnings: Array.isArray(readRubricField('warnings', [])) ? readRubricField('warnings', []) : [],
        recommendedNextBatch: readRubricField('recommendedNextBatch', null),
        doNotChange: Array.isArray(readRubricField('doNotChange', [])) ? readRubricField('doNotChange', []) : [],
        rubricCompleteness,
        presentCategories,
        missingCategories,
        schemaWarnings
    };
    for (const key of ['overallStatus', 'confidence', 'sourceEvidence']) {
        const value = readRubricField(key, undefined);
        if (value !== undefined) rubric[key] = value;
    }

    const blockerKeys = new Set();
    const topLevelBlockerCategories = new Set();
    const addTopLevelBlocker = (item, prefix, index) => {
        const category = typeof item?.category === 'string' ? item.category : null;
        if (category) topLevelBlockerCategories.add(category);
        blockerKeys.add(item?.id != null ? `id:${item.id}` : category ? `category:${category}` : `${prefix}:${index}`);
    };
    unresolvedReviewItems(rubric.blockers).forEach((item, index) => addTopLevelBlocker(item, 'blocker', index));
    unresolvedReviewItems(rubric.highSeverityIssues)
        .filter((item) => BLOCKING_ACCEPTANCE_IMPACTS.has(item?.acceptanceImpact) && item?.blocksFinalization !== false)
        .forEach((item, index) => addTopLevelBlocker(item, 'highSeverityIssue', index));
    for (const category of presentCategories) {
        const result = categories[category];
        const categoryBlocks = result.blocksFinalization === true
            && BLOCKING_ACCEPTANCE_IMPACTS.has(result.acceptanceImpact)
            && (result.severity === 'high' || result.rating === 'fail');
        if (categoryBlocks && !topLevelBlockerCategories.has(category)) blockerKeys.add(`category:${category}`);
    }

    return {
        rubric,
        rubricCompleteness,
        presentCategories,
        missingCategories,
        schemaWarnings,
        blockerCount: blockerKeys.size
    };
}

// Trace and timing helpers — used by composed template tools
function generateTraceId() {
    return crypto.randomUUID();
}

function logPhase(fields) {
    const entry = { ts: new Date().toISOString(), component: 'TemplateHandlers', ...fields };
    process.stderr.write(JSON.stringify(entry) + '\n');
    try {
        const manifest = loadWorkspace();
        appendRuntimeLog(entry, manifest.workspaceRoot);
    } catch {
        appendRuntimeLog(entry);
    }
}

async function timedPhase(trace, phase, fn) {
    const start = Date.now();
    try {
        const result = await fn();
        logPhase({ traceId: trace.traceId, toolName: trace.toolName, phase, durationMs: Date.now() - start, ok: true });
        return result;
    } catch (error) {
        logPhase({ traceId: trace.traceId, toolName: trace.toolName, phase, durationMs: Date.now() - start, ok: false, error: error.message });
        throw error;
    }
}

function response(promise, op) {
    return Promise.resolve(promise).then((r) => formatResponse(r, op)).catch((e) => formatErrorResponse(e.message, op));
}

function q(value) { return JSON.stringify(value); }

function nowIso() { return new Date().toISOString(); }

function workspaceAttachError() {
    return 'Template workspace is not attached. Call attach_template_workspace({ workspaceRoot }) or init_template_workspace(...) first.';
}

function workspaceFolders(manifest) {
    return Object.fromEntries(['input', 'work', 'previews', 'exports', 'versions', 'logs', 'assets'].map((dir) => [dir, fs.existsSync(path.join(manifest.workspaceRoot, dir))]));
}

function workspaceSummary(manifest, extra = {}) {
    return {
        success: true,
        workspaceRoot: manifest.workspaceRoot,
        workingCopyPath: manifest.workingCopyPath,
        inputCopyPath: manifest.inputCopyPath,
        folders: workspaceFolders(manifest),
        versionCount: manifest.versions?.length || 0,
        previewCount: manifest.previews?.length || 0,
        derivatives: manifest.derivatives || [],
        ...extra
    };
}

function unwrapToolResult(toolResponse) {
    return toolResponse?.result ?? toolResponse;
}

function toPtNumber(value, unit = 'pt') {
    const num = Number(value);
    if (!Number.isFinite(num)) throw new Error('Expected finite number');
    return unit === 'mm' ? num * 2.8346456693 : num;
}

function boundsToPt(bounds, unit = 'pt') {
    if (!Array.isArray(bounds) || bounds.length !== 4) throw new Error('bounds must be [top,left,bottom,right]');
    const out = bounds.map((value) => toPtNumber(value, unit));
    if (out[2] <= out[0] || out[3] <= out[1]) throw new Error('bounds must have positive width and height');
    return out;
}

function pagePresetSize(name) {
    const key = String(name || '').toLowerCase();
    if (key === 'a5') return { width: 148, height: 210, unit: 'mm', preset: 'A5' };
    if (key === 'a3') return { width: 297, height: 420, unit: 'mm', preset: 'A3' };
    if (key === 'social_square') return { width: 1080, height: 1080, unit: 'pt', preset: 'social_square' };
    return null;
}

function derivativePageSize(args = {}) {
    const preset = pagePresetSize(args.pageSize);
    let width = args.width;
    let height = args.height;
    let unit = args.unit || 'pt';
    if (preset) {
        width = preset.width;
        height = preset.height;
        unit = preset.unit;
    }
    if (width == null || height == null) {
        if (args.pageSize === 'poster' || args.pageSize === 'banner') throw new Error('poster/banner require width and height');
        throw new Error('page size requires width and height or a supported preset');
    }
    let widthPt = toPtNumber(width, unit);
    let heightPt = toPtNumber(height, unit);
    if (args.orientation === 'landscape' && heightPt > widthPt) [widthPt, heightPt] = [heightPt, widthPt];
    if (args.orientation === 'portrait' && widthPt > heightPt) [widthPt, heightPt] = [heightPt, widthPt];
    if (widthPt <= 0 || heightPt <= 0) throw new Error('page width and height must be positive');
    return { width: widthPt, height: heightPt, unit: 'pt', preset: args.pageSize || preset?.preset || 'custom' };
}

export function normalizePreviewOutputName(outputName, format, fallbackName) {
    const ext = format === 'jpg' ? 'jpg' : 'png';
    const raw = safeBasename(outputName || fallbackName);
    const currentExt = path.extname(raw).toLowerCase();
    if (!currentExt) return `${raw}.${ext}`;
    if (currentExt !== `.${ext}`) {
        throw new Error(`outputName extension ${currentExt} does not match format ${ext}`);
    }
    return raw;
}

const PREVIEW_QUALITY_RESOLUTION = Object.freeze({
    checkpoint: 48,
    review: 96,
    final: 150
});

export function resolvePreviewExportSettings(args = {}) {
    const previewQuality = Object.hasOwn(PREVIEW_QUALITY_RESOLUTION, args.previewQuality)
        ? args.previewQuality
        : 'checkpoint';
    const resolvedResolution = args.resolution != null ? Number(args.resolution) : PREVIEW_QUALITY_RESOLUTION[previewQuality];
    if (!Number.isFinite(resolvedResolution) || resolvedResolution <= 0) {
        throw new Error('resolution must be a positive number');
    }
    return {
        previewQuality,
        resolution: resolvedResolution
    };
}

function resolveWorkspaceImagePath(requestedPath, manifest = loadWorkspace()) {
    if (!requestedPath) throw new Error('imagePath is required');
    try { return assertWorkspacePath(requestedPath, { kind: 'assets', manifest }).path; }
    catch { return assertWorkspacePath(requestedPath, { kind: 'input', manifest }).path; }
}

function ensureJsonlArray(filePath) {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function appendJsonl(filePath, record) {
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`);
}

function readJsonlRecords(filePath, { limit = Infinity, filter = null } = {}) {
    const logs = [];
    const warnings = [];
    if (!fs.existsSync(filePath)) return { logs, warnings, source: filePath };
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
            const parsed = JSON.parse(line);
            if (filter && !filter(parsed)) continue;
            logs.push(parsed);
        } catch {
            warnings.push(`Skipped malformed line in ${path.basename(filePath)}`);
        }
    }
    return { logs: logs.slice(-limit), warnings, source: filePath };
}

function bridgeLogPaths() {
    const fallback = path.join(os.homedir(), '.indesign-agent', 'logs', 'bridge.jsonl');
    const envPath = process.env.INDESIGN_BRIDGE_LOG_PATH;
    return [...new Set([envPath, fallback].filter(Boolean))];
}

function readBridgeLogs(options = {}) {
    const { limit = 200, component, traceId, toolName, phase, event, sinceTs } = options;
    const sources = bridgeLogPaths();
    const logs = [];
    const warnings = [];
    for (const source of sources) {
        const result = readJsonlRecords(source, {
            filter: (entry) => {
                if (component && entry.component !== component) return false;
                if (traceId && entry.traceId !== traceId) return false;
                if (toolName && entry.toolName !== toolName) return false;
                if (phase && entry.phase !== phase) return false;
                if (event && entry.event !== event) return false;
                if (sinceTs && entry.ts && entry.ts < sinceTs) return false;
                return true;
            }
        });
        logs.push(...result.logs);
        warnings.push(...result.warnings);
    }
    return { logs: logs.slice(-limit), warnings, sources, limit, order: 'oldest_to_newest' };
}

function shallowMergeLabel(base, patch) {
    return { ...(base || {}), ...(patch || {}) };
}

export function activeGuardCode(body) {
    const { workingCopyPath } = loadWorkspace();
    return `
        const expected = ${q(path.resolve(workingCopyPath))};
        if (!app.documents || app.documents.length === 0) return { success:false, error:'No document open' };
        const doc = app.activeDocument;
        let activePath = '';
        function nativePath(v) { try { return v ? String(v.nativePath || v.fsName || v) : ''; } catch(e) { return ''; } }
        function joinDocPath(basePath, docName) { const base = String(basePath || '').replace(/[\\/]+$/, ''); if (!base) return ''; return base + '/' + docName; }
        function normalizeDocPath(rawPath, docName) { const base = nativePath(rawPath); const name = String(docName || ''); if (!base) return ''; if (name && !/\.indd$/i.test(base)) return joinDocPath(base, name); return base; }
        try { activePath = normalizeDocPath(await doc.filePath, doc.name) || normalizeDocPath(await doc.fullName, doc.name); } catch(e) {}
        if (!activePath || activePath !== expected) return { success:false, error:'Active document is not workspace working copy', activeDocumentPath: activePath || null, workingCopyPath: expected };
        // Unit guard: force InDesign geometry units to points so all returned geometry is canonical pt
        function __pickEnum(obj, candidates, fallback){ for(const k of candidates){ try{ const v = obj && obj[k]; if(v != null) return v; } catch(e){} } return fallback; }
        const __indesign = require('indesign');
        const __pt = __pickEnum(__indesign.MeasurementUnits || {}, ['POINTS','points','POINT','point'], null);
        if (__pt == null) throw new Error('Unable to force InDesign measurement units to points; refusing to run template geometry tool because returned geometry would be ambiguous.');
        const __savedH = doc.viewPreferences.horizontalMeasurementUnits;
        const __savedV = doc.viewPreferences.verticalMeasurementUnits;
        let __savedPref = null;
        try { __savedPref = app.scriptPreferences.measurementUnit; } catch(e) {}
        try {
            doc.viewPreferences.horizontalMeasurementUnits = __pt;
            doc.viewPreferences.verticalMeasurementUnits = __pt;
            try { if (__savedPref != null) app.scriptPreferences.measurementUnit = __pt; } catch(e) {}
            const __unitResult = await (async () => { ${body} })();
            return __unitResult;
        } finally {
            try { doc.viewPreferences.horizontalMeasurementUnits = __savedH; } catch(e) {}
            try { doc.viewPreferences.verticalMeasurementUnits = __savedV; } catch(e) {}
            try { if (__savedPref != null) app.scriptPreferences.measurementUnit = __savedPref; } catch(e) {}
        }
    `;
}

export function buildEnsureTemplateReadyCode(expectedWorkingCopyPath, options = {}) {
    const { allowSwitchDocument = false, openIfMissing = true } = options;
    const expected = path.resolve(expectedWorkingCopyPath);
    return `
        const expected = ${q(expected)};
        const allowSwitchDocument = ${q(allowSwitchDocument)};
        const openIfMissing = ${q(openIfMissing)};
        const pathReadWarnings = [];
        if (typeof app === 'undefined' || app == null) {
            return {
                success: false,
                errorCode: 'UXP_APP_UNAVAILABLE',
                error: 'InDesign UXP app object is unavailable',
                workingCopyPath: expected,
                pathReadWarnings
            };
        }
        function nativePath(v) { try { return v ? String(v.nativePath || v.fsName || v) : ''; } catch(e) { return ''; } }
        function joinDocPath(basePath, docName) { const base = String(basePath || '').replace(/[\\/]+$/, ''); if (!base) return ''; return base + '/' + docName; }
        function normalizeDocPath(rawPath, docName) { const base = nativePath(rawPath); const name = String(docName || ''); if (!base) return ''; if (name && !/\\.indd$/i.test(base)) return joinDocPath(base, name); return base; }
        function docName(doc) {
            try {
                return String((doc && doc.name) || '');
            } catch (e) {
                return '';
            }
        }
        async function docPath(doc, context) {
            const name = docName(doc);
            try {
                const byFilePath = normalizeDocPath(await doc.filePath, name);
                if (byFilePath) return byFilePath;
            } catch (e) {
                pathReadWarnings.push({ context, name, property: 'filePath', error: String((e && e.message) || e) });
            }
            try {
                const byFullName = normalizeDocPath(await doc.fullName, name);
                if (byFullName) return byFullName;
            } catch (e) {
                pathReadWarnings.push({ context, name, property: 'fullName', error: String((e && e.message) || e) });
            }
            return null;
        }
        function documentCount(coll) {
            return Number(coll && coll.length) || 0;
        }
        function documentAt(coll, index) {
            try { return coll.item ? coll.item(index) : coll[index]; } catch (e) { return null; }
        }
        function currentActiveDocument(documents) {
            try { return app.activeDocument || documentAt(documents, 0); } catch (e) { return documentAt(documents, 0); }
        }
        async function activateDocument(doc) {
            if (!doc) return;
            try {
                if (typeof doc.activate === 'function') {
                    await doc.activate();
                    return;
                }
            } catch (e) {}
            try { app.activeDocument = doc; } catch (e) {}
        }
        let documents = null;
        try {
            documents = app.documents;
        } catch (e) {
            return {
                success: false,
                errorCode: 'UXP_DOCUMENTS_UNAVAILABLE',
                error: 'InDesign UXP documents collection is unavailable',
                workingCopyPath: expected,
                pathReadWarnings,
                documentsError: String((e && e.message) || e)
            };
        }
        if (!documents) {
            return {
                success: false,
                errorCode: 'UXP_DOCUMENTS_UNAVAILABLE',
                error: 'InDesign UXP documents collection is unavailable',
                workingCopyPath: expected,
                pathReadWarnings
            };
        }
        if (openIfMissing && typeof app.open !== 'function') {
            return {
                success: false,
                errorCode: 'UXP_OPEN_UNAVAILABLE',
                error: 'InDesign UXP app.open is unavailable',
                workingCopyPath: expected,
                pathReadWarnings
            };
        }
        let count = 0;
        try {
            count = documentCount(documents);
        } catch (e) {
            return {
                success: false,
                errorCode: 'UXP_DOCUMENTS_UNAVAILABLE',
                error: 'InDesign UXP documents collection is unavailable',
                workingCopyPath: expected,
                pathReadWarnings,
                documentsError: String((e && e.message) || e)
            };
        }
        let activeDocumentPath = null;
        let opened = false;
        let reusedOpenDocument = false;
        let switchedActiveDocument = false;
        let workingDoc = null;
        for (let i = 0; i < count; i++) {
            const candidate = documentAt(documents, i);
            const candidatePath = await docPath(candidate, 'documents[' + i + ']');
            if (candidatePath === expected) {
                workingDoc = candidate;
                break;
            }
        }
        const active = count ? currentActiveDocument(documents) : null;
        activeDocumentPath = active ? await docPath(active, 'activeDocument') : null;
        if (!count) {
            if (!openIfMissing) return { success: false, error: 'No document open and openIfMissing=false', workingCopyPath: expected, pathReadWarnings };
            workingDoc = await app.open(expected);
            opened = true;
        } else if (activeDocumentPath === expected) {
            workingDoc = active;
            reusedOpenDocument = true;
        } else if (workingDoc) {
            await activateDocument(workingDoc);
            switchedActiveDocument = true;
            reusedOpenDocument = true;
        } else if (allowSwitchDocument && openIfMissing) {
            workingDoc = await app.open(expected);
            opened = true;
        } else {
            return { success: false, error: 'Active document is not workspace working copy', activeDocumentPath, workingCopyPath: expected, pathReadWarnings };
        }
        let currentActive = null;
        try { currentActive = app.activeDocument; } catch (e) { currentActive = null; }
        if (workingDoc && currentActive !== workingDoc) await activateDocument(workingDoc);
        try { currentActive = app.activeDocument; } catch (e) { currentActive = null; }
        const finalActiveDocumentPath = currentActive ? await docPath(currentActive, 'finalActiveDocument') : null;
        return {
            success: true,
            workingCopyPath: expected,
            activeDocumentPath: finalActiveDocumentPath,
            opened,
            reusedOpenDocument,
            switchedActiveDocument,
            pathReadWarnings
        };
    `;
}

async function runGuarded(body, options = {}) {
    const { trace, ...rest } = options;
    const execMeta = trace ? { traceId: trace.traceId, toolName: trace.toolName, phase: rest.phase || trace.phase } : {};
    await TemplateHandlers.ensureTemplateReady({ ...rest, trace });
    const result = await ScriptExecutor.executeViaUXP(activeGuardCode(body), execMeta);
    if (result?.success === false) throw new Error(result.error || 'Template tool failed');
    return result;
}

function jsHelpers() {
    return `
        function pickEnum(obj, candidates, fallback){ for(const k of candidates){ try{ const v = obj[k]; if(v != null) return v; } catch(e){} } return fallback; }
        function boundsSize(b){ return { width: b[3]-b[1], height: b[2]-b[0] }; }
        function assertApproxPageSize(actual, expected, eps, ctx){ const w = boundsSize(actual).width; const h = boundsSize(actual).height; if(Math.abs(w-expected.width) > eps || Math.abs(h-expected.height) > eps) throw new Error('Geometry unit mismatch after '+ctx+': requested '+expected.width+'x'+expected.height+'pt, got '+w+'x'+h+' from page.bounds. Refusing to continue because MCP geometry must be canonical pt.'); }
        function at(c, i){ return c.item ? c.item(i) : c[i]; }
        function len(c){ try { return c.length || 0; } catch(e) { return 0; } }
        function arr(c, fn){ const out=[]; for (let i=0;i<len(c);i++){ try { out.push(fn(at(c,i), i)); } catch(e){ out.push({ index:i, warning:String(e) }); } } return out; }
        function safe(fn, fallback=null){ try { return fn(); } catch(e){ return fallback; } }
        function meta(item){ return { objectId:safe(()=>item.id), name:safe(()=>item.name), type:safe(()=>item.constructor.name), bounds:safe(()=>item.geometricBounds), layer:safe(()=>item.itemLayer.name), locked:safe(()=>item.locked,false), visible:safe(()=>item.visible,true) }; }
        function clone(v){ return JSON.parse(JSON.stringify(v)); }
        function itemById(id){ const items = doc.allPageItems || doc.pageItems; for (let i=0;i<len(items);i++){ const it=at(items,i); if (safe(()=>it.id) === id) return it; } throw new Error('Object not found: '+id); }
        function itemByName(name){ const hits=[]; const items = doc.allPageItems || doc.pageItems; for (let i=0;i<len(items);i++){ const it=at(items,i); if (safe(()=>it.name) === name) hits.push(it); } if (hits.length !== 1) throw new Error('Expected one object named '+name+', found '+hits.length); return hits[0]; }
        function labelMatches(label, query){ const keys=Object.keys(query||{}); return keys.length>0 && keys.every((key)=>{ const expected=query[key]; const actual=label ? label[key] : undefined; if (expected && typeof expected === 'object' && !Array.isArray(expected)) return labelMatches(actual||{}, expected); return actual === expected; }); }
        function itemByLabelQuery(query){ const hits=[]; const items = doc.allPageItems || doc.pageItems; for (let i=0;i<len(items);i++){ const it=at(items,i); if (labelMatches(readLabel(it), query)) hits.push(it); } if (hits.length !== 1) throw new Error('Expected one object for labelQuery, found '+hits.length); return hits[0]; }
        function resolveItem(a){ if (a.objectId != null) return itemById(a.objectId); if (a.name) return itemByName(a.name); if (a.labelQuery) return itemByLabelQuery(a.labelQuery); throw new Error('objectId, name, or labelQuery is required'); }
        function resolveItems(a){ const ids=a.objectIds||[]; if (!ids.length) throw new Error('objectIds is required'); return ids.map(itemById); }
        function named(coll, name, kind){ const x = coll.itemByName(name); if (!x || x.isValid === false) throw new Error(kind+' not found: '+name); return x; }
        function readLabel(it){ let raw=''; try { raw = it.extractLabel ? it.extractLabel(${q(LABEL_KEY)}) : it.label; } catch(e) {} try { return raw ? JSON.parse(raw) : {}; } catch(e){ return { rawLabel: raw }; } }
        function writeLabel(it, label){ const raw=JSON.stringify(label); if (it.insertLabel) it.insertLabel(${q(LABEL_KEY)}, raw); else it.label=raw; }
        function cleanName(name){ if (!name) return name; if (!/^[a-z0-9]+(?:_[a-z0-9]+)*__(?:[a-z0-9]+_?)*__[a-z0-9_]+$/.test(name) && /[\\/"'\x00-\x1f]/.test(name)) throw new Error('Invalid semantic object name'); return name; }
        function toPt(v, unit){ const n = Number(v); if (!Number.isFinite(n)) throw new Error('Expected finite number'); return unit === 'mm' ? n * 2.8346456693 : n; }
        function boundsInPt(bounds, unit){ if (!Array.isArray(bounds) || bounds.length !== 4) throw new Error('bounds must be [top,left,bottom,right]'); const b=bounds.map((x)=>toPt(x, unit || 'pt')); if (b[2] <= b[0] || b[3] <= b[1]) throw new Error('bounds must have positive width and height'); return b; }
        function roundMaybe(v, step){ return step ? Math.round(v / step) * step : v; }
        function widthOf(b){ return b[3] - b[1]; }
        function heightOf(b){ return b[2] - b[0]; }
        function centerXOf(b){ return (b[1] + b[3]) / 2; }
        function centerYOf(b){ return (b[0] + b[2]) / 2; }
        function pageIndexOf(item){ const parentPage = safe(()=>item.parentPage, null); if (!parentPage) return null; for (let i=0;i<len(doc.pages);i++) if (safe(()=>at(doc.pages,i).id) === safe(()=>parentPage.id)) return i; return null; }
        function collectionIndexById(coll, obj){ const id = safe(()=>obj && obj.id, null); if (id == null) return null; for (let i=0;i<len(coll);i++) if (safe(()=>at(coll,i).id, null) === id) return i; return null; }
        function pageByIndex(index){ if (index == null || index < 0 || index >= len(doc.pages)) throw new Error('pageIndex out of range'); return at(doc.pages, index); }
        function pageBounds(index){ return clone(pageByIndex(index).bounds); }
        function spreadBoundsForPage(index){ const page = pageByIndex(index); const spread = safe(()=>page.parent, null); if (!spread) return clone(page.bounds); const pages = arr(spread.pages, (p)=>safe(()=>p.bounds)); const top = Math.min.apply(null, pages.map((b)=>b[0])); const left = Math.min.apply(null, pages.map((b)=>b[1])); const bottom = Math.max.apply(null, pages.map((b)=>b[2])); const right = Math.max.apply(null, pages.map((b)=>b[3])); return [top,left,bottom,right]; }
        function writableLayer(name) { const layerName = name || 'AGENT_WORK'; let layer = safe(() => doc.layers.itemByName(layerName), null); if (!layer || layer.isValid === false) layer = doc.layers.add({ name: layerName }); layer.visible = true; layer.locked = false; return layer; }
        function rectArea(b) { return Math.max(0, b[3] - b[1]) * Math.max(0, b[2] - b[0]); }
        function intersectBounds(a, b) { const top = Math.max(a[0], b[0]); const left = Math.max(a[1], b[1]); const bottom = Math.min(a[2], b[2]); const right = Math.min(a[3], b[3]); if (bottom <= top || right <= left) return null; return [top, left, bottom, right]; }
        function pageLocalBoundsToDocumentBounds(pageIndex, bounds, unit) { const page = pageByIndex(pageIndex); const pb = clone(page.bounds); const lb = boundsInPt(bounds, unit || 'pt'); return { localBounds: lb, pageBounds: pb, documentBounds: [pb[0] + lb[0], pb[1] + lb[1], pb[0] + lb[2], pb[1] + lb[3]] }; }
        function resolveBoundsForPage(args, fallbackPageIndex) { const pageIndex = args.pageIndex != null ? args.pageIndex : fallbackPageIndex; if (pageIndex == null) throw new Error('pageIndex is required'); const page = pageByIndex(pageIndex); const pb = clone(page.bounds); const rawBounds = boundsInPt(args.bounds, args.unit || 'pt'); const coordinateSpace = args.coordinateSpace || 'page'; if (coordinateSpace === 'document') return { coordinateSpace: 'document', localBounds: null, pageBounds: pb, documentBounds: rawBounds, pageIndex }; if (coordinateSpace !== 'page') throw new Error('coordinateSpace must be "page" or "document"'); return { coordinateSpace: 'page', ...pageLocalBoundsToDocumentBounds(pageIndex, args.bounds, args.unit || 'pt'), pageIndex }; }
        function pageLocalPointToDocumentPoint(pageIndex, point, unit) { if (!Array.isArray(point) || point.length !== 2) throw new Error('point must be [x,y]'); const page = pageByIndex(pageIndex); const pb = clone(page.bounds); const x = toPt(point[0], unit || 'pt'); const y = toPt(point[1], unit || 'pt'); return { localPoint: [x, y], pageBounds: pb, documentPoint: [pb[1] + x, pb[0] + y] }; }
        function resolvePointForPage(args, point, fallbackPageIndex) { const pageIndex = args.pageIndex != null ? args.pageIndex : fallbackPageIndex; if (pageIndex == null) throw new Error('pageIndex is required'); const coordinateSpace = args.coordinateSpace || 'page'; if (coordinateSpace === 'document') { const x = toPt(point[0], args.unit || 'pt'); const y = toPt(point[1], args.unit || 'pt'); return { coordinateSpace: 'document', localPoint: null, pageBounds: clone(pageByIndex(pageIndex).bounds), documentPoint: [x, y], pageIndex }; } if (coordinateSpace !== 'page') throw new Error('coordinateSpace must be "page" or "document"'); return { coordinateSpace: 'page', ...pageLocalPointToDocumentPoint(pageIndex, point, args.unit || 'pt'), pageIndex }; }
        function validateBoundsOnPage(documentBounds, pageBounds, args) { const warnings = []; const decorative = !!(args && (args.decorative === true || args.allowBleed === true || args.role === 'decorative')); const allowBleed = !!(args && args.allowBleed === true); const requirePageIntersection = !(args && args.requirePageIntersection === false); const reject = decorative ? !!(args && args.rejectOutOfPageBounds === true) : !(args && args.rejectOutOfPageBounds === false); const maxOutsideRatio = args && args.maxOutsidePageRatio == null ? (decorative ? 0.85 : 0.25) : Number(args.maxOutsidePageRatio); if (!Array.isArray(documentBounds) || documentBounds.length !== 4) throw new Error('documentBounds must be [top,left,bottom,right]'); if (documentBounds.some((v) => !Number.isFinite(Number(v)))) throw new Error('documentBounds must contain finite numbers'); if (documentBounds[2] <= documentBounds[0] || documentBounds[3] <= documentBounds[1]) throw new Error('documentBounds must have positive width and height'); const pageWidth = pageBounds[3] - pageBounds[1]; const pageHeight = pageBounds[2] - pageBounds[0]; const itemWidth = documentBounds[3] - documentBounds[1]; const itemHeight = documentBounds[2] - documentBounds[0]; if (itemWidth < 0.5 || itemHeight < 0.5) throw new Error('Object bounds are implausibly small'); if (itemWidth > pageWidth * 3 || itemHeight > pageHeight * 3) throw new Error('Object bounds are implausibly large relative to page'); const intersection = intersectBounds(documentBounds, pageBounds); if (!intersection) { const msg = 'Object bounds do not intersect target page'; if (requirePageIntersection && reject) throw new Error(msg); warnings.push(msg); } const itemArea = rectArea(documentBounds); const insideArea = intersection ? rectArea(intersection) : 0; const outsideRatio = itemArea > 0 ? 1 - insideArea / itemArea : 1; if (outsideRatio > maxOutsideRatio) { const msg = 'Object is mostly outside target page: outsideRatio=' + outsideRatio; if (reject) throw new Error(msg); warnings.push(msg); } return { ok: warnings.length === 0, decorative, allowBleed, outsideRatio, intersectsPage: !!intersection, warnings }; }
        function setBoundsRaw(item, bounds){ item.geometricBounds = bounds; return clone(item.geometricBounds); }
        function setBoundsSmart(item, nextBounds, options){ const current = clone(item.geometricBounds); let target = clone(nextBounds); const preserveAspectRatio = !!(options && options.preserveAspectRatio); const preserveCenter = !!(options && options.preserveCenter); const anchor = options && options.anchor || 'topLeft'; const roundTo = options && options.roundTo || null; if (preserveCenter) {
                const w = widthOf(target), h = heightOf(target), cx = centerXOf(current), cy = centerYOf(current);
                target = [cy - h / 2, cx - w / 2, cy + h / 2, cx + w / 2];
            }
            if (preserveAspectRatio) {
                const oldW = widthOf(current), oldH = heightOf(current), ratio = oldW / oldH, targetW = widthOf(target), targetH = heightOf(target);
                let newW = targetW, newH = targetH;
                if (targetW / targetH > ratio) newW = targetH * ratio; else newH = targetW / ratio;
                if (anchor === 'center') {
                    const cx = centerXOf(target), cy = centerYOf(target);
                    target = [cy - newH / 2, cx - newW / 2, cy + newH / 2, cx + newW / 2];
                } else if (anchor === 'bottomRight') {
                    target = [target[2] - newH, target[3] - newW, target[2], target[3]];
                } else {
                    target = [target[0], target[1], target[0] + newH, target[1] + newW];
                }
            }
            if (roundTo) target = target.map((v)=>roundMaybe(v, roundTo));
            return setBoundsRaw(item, target);
        }
        function applyFitMode(item, fitMode){ const { FitOptions } = require('indesign'); const fitMap = { proportionally: FitOptions.PROPORTIONALLY, fillProportionally: FitOptions.FILL_PROPORTIONALLY, contentToFrame: FitOptions.CONTENT_TO_FRAME, frameToContent: FitOptions.FRAME_TO_CONTENT, centerContent: FitOptions.CENTER_CONTENT, PROPORTIONALLY: FitOptions.PROPORTIONALLY, FILL_FRAME: FitOptions.FILL_PROPORTIONALLY, FIT_CONTENT: FitOptions.CONTENT_TO_FRAME, FIT_FRAME: FitOptions.FRAME_TO_CONTENT }; if (fitMode && fitMap[fitMode]) item.fit(fitMap[fitMode]); }
        function linkInfo(item){ return safe(()=>{ const graphic = item.graphics && len(item.graphics) ? at(item.graphics,0) : null; const link = graphic && graphic.itemLink; return link ? { name:safe(()=>link.name), path:safe(()=>link.filePath), status:String(safe(()=>link.status,'')) } : null; }, null); }
        function textExcerpt(item){ return { excerpt:String(safe(()=>item.contents,'') || '').slice(0,500), overset:!!safe(()=>item.overflows,false) }; }
        function isTextFrame(item){ return !!item && /TextFrame/i.test(String(safe(()=>item.constructor && item.constructor.name,''))); }
        function excerptText(value, limit){ return String(value == null ? '' : value).slice(0, limit == null ? 240 : limit); }
        function textFrameDiagnostics(item, options){ const excerptLimit = Number(options && options.excerptLimit != null ? options.excerptLimit : 240); const frameText = safe(()=>item.contents, ''); const story = safe(()=>item.parentStory, null); const storyText = story ? safe(()=>story.contents, '') : ''; return { objectId:safe(()=>item.id, null), name:safe(()=>item.name, null), type:safe(()=>item.constructor && item.constructor.name, null), pageIndex:pageIndexOf(item), bounds:clone(safe(()=>item.geometricBounds, null)), parentStoryId:safe(()=>story && story.id, null), frameExcerpt:excerptText(frameText, excerptLimit), storyExcerpt:excerptText(storyText, excerptLimit), frameLength:String(frameText || '').length, storyLength:String(storyText || '').length, overflows:!!safe(()=>item.overflows,false), hasPreviousTextFrame:!!safe(()=>item.previousTextFrame, null), hasNextTextFrame:!!safe(()=>item.nextTextFrame, null), previousTextFrameId:safe(()=>item.previousTextFrame && item.previousTextFrame.id, null), nextTextFrameId:safe(()=>item.nextTextFrame && item.nextTextFrame.id, null), label:clone(readLabel(item)), objectStyle:safe(()=>item.appliedObjectStyle && item.appliedObjectStyle.name, null), paragraphStyle:safe(()=>item.paragraphs.item(0).appliedParagraphStyle.name, null), characterStyle:safe(()=>item.textStyleRanges.item(0).appliedCharacterStyle.name, null), fillSwatch:safe(()=>item.fillColor && item.fillColor.name, null), strokeSwatch:safe(()=>item.strokeColor && item.strokeColor.name, null), strokeWeight:safe(()=>item.strokeWeight, null), storyFrameCount:safe(()=>story && len(story.textFrames), null), storyTextContainerCount:safe(()=>story && len(story.textContainers), null) }; }
        function textFrameStyleSnapshot(item){ return { objectStyle:safe(()=>item.appliedObjectStyle && item.appliedObjectStyle.name, null), paragraphStyle:safe(()=>item.paragraphs.item(0).appliedParagraphStyle.name, null), characterStyle:safe(()=>item.textStyleRanges.item(0).appliedCharacterStyle.name, null), fillSwatch:safe(()=>item.fillColor && item.fillColor.name, null), strokeSwatch:safe(()=>item.strokeColor && item.strokeColor.name, null), strokeWeight:safe(()=>item.strokeWeight, null) }; }
        function textFrameIsThreadedOrShared(item, diagnostics){ const diag = diagnostics || textFrameDiagnostics(item); return !!(diag.hasPreviousTextFrame || diag.hasNextTextFrame || (diag.parentStoryId != null && ((diag.storyFrameCount != null && diag.storyFrameCount > 1) || (diag.storyTextContainerCount != null && diag.storyTextContainerCount > 1) || (diag.storyLength != null && diag.frameLength != null && diag.storyLength > diag.frameLength)))); }
        function applyTextFrameStyleSnapshot(item, snapshot){ if (!snapshot) return []; const warnings = []; if (snapshot.objectStyle) { try { const s = named(doc.objectStyles, snapshot.objectStyle, 'Object style'); if (item.applyObjectStyle) item.applyObjectStyle(s, false, false); else item.appliedObjectStyle = s; } catch (error) { warnings.push(String(error.message || error)); } } try { applyTextStyles(item, snapshot); } catch (error) { warnings.push(String(error.message || error)); } if (snapshot.fillSwatch) { try { item.fillColor = named(doc.swatches, snapshot.fillSwatch, 'Swatch'); } catch (error) { warnings.push(String(error.message || error)); } } if (snapshot.strokeSwatch) { try { item.strokeColor = named(doc.swatches, snapshot.strokeSwatch, 'Swatch'); } catch (error) { warnings.push(String(error.message || error)); } } if (snapshot.strokeWeight != null) { try { item.strokeWeight = snapshot.strokeWeight; } catch (error) { warnings.push(String(error.message || error)); } } return warnings; }
        function replaceTextFrameContentsSafely(item, text, options){ const policy = options && options.textReplacePolicy ? String(options.textReplacePolicy) : 'isolatedOnly'; if (policy !== 'isolatedOnly') throw new Error(policy === 'replaceStory' ? 'replaceStory is not implemented safely yet' : 'Unsupported textReplacePolicy: ' + policy); if (!isTextFrame(item)) throw new Error('Unsafe text replacement refused: target is not a TextFrame'); const before = textFrameDiagnostics(item, options); if (!safe(()=>item.isValid !== false, true)) throw new Error('Unsafe text replacement refused: target text frame is invalid'); if (textFrameIsThreadedOrShared(item, before)) throw new Error('Unsafe text replacement refused: target text frame is threaded/shared. Use create_text_slot for editable derivative text or pass explicit replacement policy after inspection.'); const preserveStyle = options && options.preserveStyle === false ? false : true; const styleSnapshot = preserveStyle ? textFrameStyleSnapshot(item) : null; const oldFrameExcerpt = before.frameExcerpt; const oldStoryExcerpt = before.storyExcerpt; const nextText = String(text == null ? '' : text); const actions = ['replaceContents']; item.contents = nextText; const styleWarnings = preserveStyle ? applyTextFrameStyleSnapshot(item, styleSnapshot) : []; const after = textFrameDiagnostics(item, options); const observedExcerpt = after.frameExcerpt || ''; const requestedExcerpt = excerptText(nextText, 240); const newTextPrefixOk = nextText.length === 0 ? observedExcerpt.length === 0 : observedExcerpt.length > 0 && requestedExcerpt.startsWith(observedExcerpt); const explicitOldExcerpt = options && options.expectedOldTextExcerpt != null ? String(options.expectedOldTextExcerpt) : ''; const oldExcerptCheck = explicitOldExcerpt ? explicitOldExcerpt.slice(0, Math.min(96, explicitOldExcerpt.length)) : ''; const oldExcerptRequiredGone = !!oldExcerptCheck && nextText.indexOf(oldExcerptCheck) === -1; const oldGoneOk = !oldExcerptRequiredGone || (after.frameExcerpt.indexOf(oldExcerptCheck) === -1 && after.storyExcerpt.indexOf(oldExcerptCheck) === -1); const replacementVerified = newTextPrefixOk && oldGoneOk; if (!replacementVerified) throw new Error('Unsafe text replacement refused: replacement could not be verified. before=' + JSON.stringify({ objectId: before.objectId, name: before.name, frameExcerpt: before.frameExcerpt, storyExcerpt: before.storyExcerpt }) + ' after=' + JSON.stringify({ frameExcerpt: after.frameExcerpt, storyExcerpt: after.storyExcerpt }) + ' checks=' + JSON.stringify({ newTextPrefixOk, oldExcerptCheck, oldExcerptRequiredGone })); const warnings = [].concat(styleWarnings || []); if (after.overflows) warnings.push('Text remains overset after replacement'); return { success:true, resolved:true, replacementVerified, stillOverset:!!after.overflows, before, after, actions, warnings, policy, styleSnapshot, oldFrameExcerpt, oldStoryExcerpt, oldExcerptCheck, oldExcerptRequiredGone, newTextPrefixOk }; }
        function itemSnapshot(item){ return { objectId:safe(()=>item.id), name:safe(()=>item.name), type:safe(()=>item.constructor.name), pageIndex:pageIndexOf(item), bounds:clone(safe(()=>item.geometricBounds, null)), label:clone(readLabel(item)), text:/TextFrame/i.test(safe(()=>item.constructor.name,'')) ? textExcerpt(item) : null, link:linkInfo(item), objectStyle:safe(()=>item.appliedObjectStyle && item.appliedObjectStyle.name, null), fillSwatch:safe(()=>item.fillColor && item.fillColor.name, null), strokeSwatch:safe(()=>item.strokeColor && item.strokeColor.name, null), strokeWeight:safe(()=>item.strokeWeight, null) }; }
        function applyBasics(it,args){ if(args.name) it.name=cleanName(args.name); if(args.label) writeLabel(it,args.label); if(args.objectStyle) { const s=named(doc.objectStyles,args.objectStyle,'Object style'); if(it.applyObjectStyle) it.applyObjectStyle(s, false, false); else it.appliedObjectStyle=s; } if(args.fillSwatch) it.fillColor=named(doc.swatches,args.fillSwatch,'Swatch'); if(args.strokeSwatch) it.strokeColor=named(doc.swatches,args.strokeSwatch,'Swatch'); if(args.strokeWeight!=null) it.strokeWeight=args.strokeWeight; }
        function applyTextStyles(it,args){ const text=safe(()=>it.texts.item(0)); if(!text || text.isValid===false) return; if(args.paragraphStyle){ const s=named(doc.paragraphStyles,args.paragraphStyle,'Paragraph style'); if(text.applyParagraphStyle) text.applyParagraphStyle(s, false); else text.appliedParagraphStyle=s; } if(args.characterStyle){ const s=named(doc.characterStyles,args.characterStyle,'Character style'); if(text.applyCharacterStyle) text.applyCharacterStyle(s); else text.appliedCharacterStyle=s; } }
    `;
}

export class TemplateHandlers {
    static async ensureTemplateReady(options = {}) {
        const { allowSwitchDocument = false, openIfMissing = true, trace } = options;
        const execMeta = trace ? { traceId: trace.traceId, toolName: trace.toolName, phase: 'ensureTemplateReady' } : {};
        let manifest;
        try {
            manifest = validateWorkspaceFiles(loadWorkspace());
        } catch {
            throw new Error(workspaceAttachError());
        }
        assertWorkspacePath(manifest.workingCopyPath, { kind: 'work', manifest });
        const result = await ScriptExecutor.executeViaUXP(buildEnsureTemplateReadyCode(manifest.workingCopyPath, { allowSwitchDocument, openIfMissing }), execMeta);
        if (result?.success === false) throw new Error(result.error || 'Template readiness failed');
        return result;
    }

    static inspectionLogPath(manifest = loadWorkspace()) {
        return assertWorkspacePath(path.join(manifest.workspaceRoot, 'logs', 'derivative_inspections.jsonl'), { kind: 'logs', manifest }).path;
    }

    static loadInspectionSnapshots(manifest = loadWorkspace()) {
        return ensureJsonlArray(this.inspectionLogPath(manifest));
    }

    static appendInspectionSnapshot(manifest, snapshot) {
        appendJsonl(this.inspectionLogPath(manifest), snapshot);
    }

    static resolveDerivativeRecord(manifest, args = {}) {
        if (args.derivativeId) {
            const record = (manifest.derivatives || []).find((entry) => entry.derivativeId === args.derivativeId);
            if (!record) throw new Error(`Unknown derivativeId: ${args.derivativeId}`);
            return record;
        }
        if (args.pageIndex != null) {
            const record = (manifest.derivatives || []).find((entry) => entry.pageIndex === args.pageIndex);
            if (!record) throw new Error(`No derivative mapped to pageIndex ${args.pageIndex}`);
            return record;
        }
        throw new Error('derivativeId or pageIndex is required');
    }

    static async resolveDerivativeTarget(args = {}) {
        if (args.derivativeId) {
            const resolved = unwrapToolResult(await this.resolve_derivative_page({ derivativeId: args.derivativeId }));
            return {
                derivativeId: args.derivativeId,
                pageIndex: resolved.pageIndex,
                pageId: resolved.pageId || null,
                resolvedBy: resolved.resolvedBy || 'derivativeId',
                warnings: resolved.warnings || []
            };
        }
        if (args.pageIndex != null) {
            return {
                derivativeId: args.derivativeId || null,
                pageIndex: args.pageIndex,
                pageId: args.pageId || null,
                resolvedBy: 'pageIndex',
                warnings: []
            };
        }
        throw new Error('derivativeId or pageIndex is required');
    }

    static async createPageRaw(args = {}) { return this.uxpTool('create_page', args); }
    static async createTextFrameRaw(args = {}) { return this.uxpTool('create_text_frame', args); }
    static async createImageFrameRaw(args = {}) { return this.uxpTool('create_image_frame', args); }
    static async createShapeRaw(args = {}) { return this.uxpTool('create_shape', args); }
    static async createLineRaw(args = {}) { return this.uxpTool('create_line', args); }
    static async exportPreviewRaw(kind, args = {}) { return this.exportPreview(kind, args); }
    static async inspectPageItemsRaw(args = {}) { return this.uxpTool('inspect_page_items_v2', args); }

    static async createDerivativePageMarker(args = {}) {
        const { derivativeId, pageIndex } = args;
        return runGuarded(`${jsHelpers()} const args=${q(args)};
            const page = pageByIndex(args.pageIndex);
            const resolved = resolveBoundsForPage({ pageIndex: args.pageIndex, bounds: [0,0,1,1], unit: 'pt', coordinateSpace: 'page', rejectOutOfPageBounds: false, maxOutsidePageRatio: 1 });
            let layer = safe(() => doc.layers.itemByName('MCP_METADATA'), null);
            if (!layer || layer.isValid === false) layer = writableLayer('MCP_METADATA');
            layer.printable = false;
            const marker = page.rectangles.add({ geometricBounds: resolved.documentBounds, itemLayer: layer });
            marker.name = String(args.derivativeId) + '__page_marker';
            marker.nonprinting = true;
            writeLabel(marker, { derivativeId: args.derivativeId, role: 'page_marker', source: 'mcp', nonprinting: true, metadata: true });
            return { success: true, objectId: safe(() => marker.id), name: safe(() => marker.name), pageIndex: args.pageIndex };
        `);
    }

    static async handle(name, args = {}) {
        if (this[name]) return this[name](args);
        return response(this.uxpTool(name, args), name);
    }

    static init_template_workspace(args) {
        return response(initWorkspace({ originalSourcePath: args.originalInddPath, workspaceRoot: args.workspaceRoot, overwriteExistingWorkspace: args.overwriteExistingWorkspace }), 'init_template_workspace');
    }

    static attach_template_workspace(args = {}) {
        return response((async () => workspaceSummary(attachWorkspace(args.workspaceRoot)))(), 'attach_template_workspace');
    }

    static copy_original_to_workspace(args = {}) {
        return response((async () => {
            if (args.originalInddPath && args.workspaceRoot) {
                const manifest = initWorkspace({ originalSourcePath: args.originalInddPath, workspaceRoot: args.workspaceRoot, overwriteExistingWorkspace: args.overwriteExistingWorkspace });
                return workspaceSummary(manifest, { copied: true, verified: true });
            }
            if (args.workspaceRoot && !args.originalInddPath) {
                const manifest = attachWorkspace(args.workspaceRoot);
                return workspaceSummary(manifest, { copied: false, verified: true });
            }
            const manifest = validateWorkspaceFiles(loadWorkspace());
            return workspaceSummary(manifest, { copied: false, verified: true, originalSourcePath: manifest.originalSourcePath || null });
        })(), 'copy_original_to_workspace');
    }

    static get_workspace_status() {
        return response((async () => {
            const m = loadWorkspace();
            const folders = Object.fromEntries(['input','work','previews','exports','versions','logs','assets'].map((d) => [d, fs.existsSync(path.join(m.workspaceRoot, d))]));
            const uxpExecution = getUxpBusyGateStatus();
            const warnings = [];
            let active = null;
            if (uxpExecution.busy) {
                warnings.push('Skipped active document validation because another UXP tool is busy');
            } else {
                try { active = await this.rawValidateActive(); } catch (e) { active = { ok: false, error: e.message }; }
            }
            let bridgeStatus = null;
            try {
                bridgeStatus = await ScriptExecutor.bridgeStatus();
            } catch (error) {
                bridgeStatus = { ok: false, error: error.message };
            }
            return { workspaceRoot: m.workspaceRoot, workingCopyPath: m.workingCopyPath, folders, activeVersionId: m.activeVersionId, versionCount: m.versions.length, previewCount: m.previews.length, derivatives: m.derivatives, activeDocument: active, bridgeStatus, uxpExecution, warnings };
        })(), 'get_workspace_status');
    }

    static validate_workspace_path(args) {
        return response(assertWorkspacePath(args.path, { kind: args.kind }), 'validate_workspace_path');
    }

    static async rawValidateActive(meta = {}) {
        const m = loadWorkspace();
        return ScriptExecutor.executeViaUXP(`
            const expected = ${q(path.resolve(m.workingCopyPath))};
            let activeDocumentPath = null;
            const pathReadWarnings = [];
            let appAvailable = false;
            let documentsAvailable = false;
            let documentCount = null;
            let error = null;
            function nativePath(v) { try { return v ? String(v.nativePath || v.fsName || v) : ''; } catch(e) { return ''; } }
            function joinDocPath(basePath, docName) { const base = String(basePath || '').replace(/[\\/]+$/, ''); if (!base) return ''; return base + '/' + docName; }
            function normalizeDocPath(rawPath, docName) { const base = nativePath(rawPath); const name = String(docName || ''); if (!base) return ''; if (name && !/\.indd$/i.test(base)) return joinDocPath(base, name); return base; }
            if (typeof app === 'undefined' || app == null) {
                error = 'InDesign UXP app object is unavailable';
            } else {
                appAvailable = true;
            }
            if (!error) {
                let documents = null;
                try {
                    documents = app.documents;
                    documentsAvailable = !!documents;
                } catch (e) {
                    error = 'InDesign UXP documents collection is unavailable';
                }
                if (!error && !documents) {
                    error = 'InDesign UXP documents collection is unavailable';
                }
                if (!error) {
                    try {
                        documentCount = Number(documents.length) || 0;
                    } catch (e) {
                        error = 'InDesign UXP documents collection is unavailable';
                    }
                }
                if (!error) {
                    const doc = documentCount ? app.activeDocument : null;
                    if (doc) {
                        const docName = String(doc.name || '');
                        try {
                            activeDocumentPath = normalizeDocPath(await doc.filePath, doc.name) || null;
                        } catch (e) {
                            pathReadWarnings.push({ context: 'activeDocument', name: docName, property: 'filePath', error: String((e && e.message) || e) });
                        }
                        if (!activeDocumentPath) {
                            try {
                                activeDocumentPath = normalizeDocPath(await doc.fullName, doc.name) || null;
                            } catch (e) {
                                pathReadWarnings.push({ context: 'activeDocument', name: docName, property: 'fullName', error: String((e && e.message) || e) });
                            }
                        }
                    }
                }
            }
            return { ok: !error && activeDocumentPath === expected, activeDocumentPath, workingCopyPath: expected, appAvailable, documentsAvailable, documentCount, error, pathReadWarnings };
        `, { ...meta, phase: 'rawValidateActive' });
    }

    static validate_active_document_is_working_copy() {
        return response(this.rawValidateActive(), 'validate_active_document_is_working_copy');
    }

    static open_working_copy() {
        return response((async () => {
            const ready = await this.ensureTemplateReady({ allowSwitchDocument: true, openIfMissing: true });
            const result = {
                success: true,
                documentName: path.basename(ready.workingCopyPath),
                path: ready.workingCopyPath,
                reusedOpenDocument: ready.reusedOpenDocument,
                opened: ready.opened,
                switchedActiveDocument: ready.switchedActiveDocument
            };
            if (ready.pathReadWarnings?.length) result.pathReadWarnings = ready.pathReadWarnings;
            return result;
        })(), 'open_working_copy');
    }

    static save_working_copy() {
        return response((async () => {
            const manifest = loadWorkspace();
            await runGuarded('await doc.save(); return { success:true, path: expected };');
            return { success: true, ...fileStatEvidence(manifest.workingCopyPath) };
        })(), 'save_working_copy');
    }

    static save_version(args = {}) {
        return response((async () => {
            const m = loadWorkspace();
            await runGuarded('await doc.save(); return { success:true };');
            const versionId = nextVersionId(m);
            const versionPath = path.join(m.workspaceRoot, 'versions', `${versionId}.indd`);
            assertWorkspacePath(versionPath, { kind: 'versions', manifest: m });
            fs.copyFileSync(m.workingCopyPath, versionPath);
            const rec = {
                versionId,
                path: versionPath,
                label: args.label || null,
                derivativeId: args.derivativeId || null,
                createdAt: new Date().toISOString(),
                source: 'save_version',
                sourceFile: fileStatEvidence(m.workingCopyPath),
                versionFile: fileStatEvidence(versionPath)
            };
            m.versions.push(rec); m.activeVersionId = versionId; saveWorkspace(m);
            if (args.derivativeId) {
                const derivative = (m.derivatives || []).find((entry) => entry.derivativeId === args.derivativeId);
                upsertDerivativePage(m, args.derivativeId, { versionIds: [...new Set([...(derivative?.versionIds || []), versionId])] });
            }
            return { success: true, versionId, label: rec.label, derivativeId: rec.derivativeId, source: rec.sourceFile, version: rec.versionFile };
        })(), 'save_version');
    }

    static list_versions() { return response(loadWorkspace().versions, 'list_versions'); }

    static rollback_to_version(args = {}) {
        return response((async () => {
            const m = loadWorkspace();
            const rec = m.versions.find((v) => v.versionId === args.versionId);
            if (!rec) throw new Error('Unknown versionId');
            assertWorkspacePath(rec.path, { kind: 'versions', manifest: m });
            fs.copyFileSync(rec.path, m.workingCopyPath);
            m.activeVersionId = rec.versionId; saveWorkspace(m);
            if (args.reopen !== false) await this.open_working_copy({});
            return rec;
        })(), 'rollback_to_version');
    }

    static return_preview_as_image(args = {}) {
        return response((async () => {
            const m = loadWorkspace();
            let rec = null;
            if (args.previewId) {
                rec = (m.previews || []).find((p) => p.previewId === args.previewId) || null;
                if (!rec) {
                    throw new Error(`Unknown previewId: ${args.previewId}. Preview is not recorded in manifest.previews.`);
                }
            } else if (args.path) {
                rec = { path: args.path };
            } else {
                throw new Error('previewId or path is required');
            }
            const checked = assertWorkspacePath(rec.path, { kind: 'previews', manifest: m }).path;
            let stat;
            try {
                stat = fileStatEvidence(checked);
            } catch (error) {
                const previewRef = rec.previewId ? `previewId ${rec.previewId}` : `path ${checked}`;
                throw new Error(`Unable to read preview ${previewRef}: ${error.message}`);
            }
            const info = imageInfo(checked);
            const result = {
                ...rec,
                path: checked,
                filePath: checked,
                mimeType: rec.mimeType || info.mimeType,
                format: rec.format || (info.mimeType === 'image/jpeg' ? 'jpg' : 'png'),
                widthPx: info.widthPx,
                heightPx: info.heightPx,
                sizeBytes: stat.sizeBytes,
                createdAt: rec.createdAt || null
            };
            if (args.returnImage === true) {
                if (args.maxInlineBytes != null && stat.sizeBytes > Number(args.maxInlineBytes)) {
                    throw new Error(`Preview exceeds maxInlineBytes: ${stat.sizeBytes} > ${Number(args.maxInlineBytes)}`);
                }
                result.mcpImage = buildMcpImagePayload(checked, result.mimeType);
            }
            if (args.legacyDataBase64 === true) {
                result.dataBase64 = fs.readFileSync(checked).toString('base64');
            }
            return result;
        })(), 'return_preview_as_image');
    }

    static record_visual_review(args = {}) {
        return response((async () => {
            const m = loadWorkspace();
            const normalized = normalizeDesignQualityReview(args);
            const rubric = normalized.rubric;
            const review = {
                reviewId: `review_${Date.now()}`,
                derivativeId: args.derivativeId,
                targetPreviewId: args.targetPreviewId || null,
                indesignPreviewId: args.indesignPreviewId || null,
                brief: args.brief || '',
                issues: args.issues || [],
                suggestedFixes: args.suggestedFixes || [],
                rubricCompleteness: normalized.rubricCompleteness,
                presentCategories: normalized.presentCategories,
                missingCategories: normalized.missingCategories,
                schemaWarnings: normalized.schemaWarnings,
                ...(rubric ? {
                    designQualityRubric: rubric,
                    overallStatus: rubric.overallStatus ?? null,
                    confidence: rubric.confidence ?? null,
                    sourceEvidence: rubric.sourceEvidence ?? null,
                    categoryRatings: rubric.categories,
                    highSeverityIssues: rubric.highSeverityIssues,
                    blockers: rubric.blockers,
                    warnings: rubric.warnings,
                    recommendedNextBatch: rubric.recommendedNextBatch,
                    doNotChange: rubric.doNotChange
                } : {}),
                timestamp: new Date().toISOString()
            };
            const outstandingIssueCount = rubric
                ? normalized.blockerCount
                : review.issues.length;
            fs.appendFileSync(assertWorkspacePath(path.join(m.workspaceRoot, 'logs', 'visual_reviews.jsonl'), { kind: 'logs', manifest: m }).path, `${JSON.stringify(review)}\n`);
            upsertDerivative(m, args.derivativeId, {
                latestReviewId: review.reviewId,
                outstandingIssueCount,
                ...(rubric ? {
                    latestDesignReviewStatus: review.overallStatus,
                    latestDesignReviewConfidence: review.confidence,
                    unresolvedDesignBlockerCount: normalized.blockerCount,
                    latestDesignRubricCompleteness: normalized.rubricCompleteness,
                    latestDesignMissingCategories: normalized.missingCategories
                } : {})
            });
            return review;
        })(), 'record_visual_review');
    }

    static list_visual_reviews(args = {}) {
        return response((async () => {
            const m = loadWorkspace();
            const p = path.join(m.workspaceRoot, 'logs', 'visual_reviews.jsonl');
            if (!fs.existsSync(p)) return [];
            return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !args.derivativeId || r.derivativeId === args.derivativeId).slice(-(args.limit || 100));
        })(), 'list_visual_reviews');
    }

    static mark_derivative_accepted(args = {}) {
        return response(upsertDerivative(loadWorkspace(), args.derivativeId, { status: 'accepted', acceptedPreviewId: args.acceptedPreviewId || null, versionId: args.versionId || null, notes: args.notes || '' }), 'mark_derivative_accepted');
    }

    static get_derivative_status(args = {}) {
        return response(loadWorkspace().derivatives.find((d) => d.derivativeId === args.derivativeId) || null, 'get_derivative_status');
    }

    static get_runtime_logs(args = {}) {
        return response((async () => {
            const limit = Math.max(1, Number(args.limit || 200));
            const filters = {
                component: args.component || null,
                traceId: args.traceId || null,
                toolName: args.toolName || null,
                phase: args.phase || null,
                event: args.event || null,
                sinceTs: args.sinceTs || null
            };
            const logs = [];
            const sources = [];
            const warnings = [];
            if (args.includeRuntime !== false) {
                let workspaceRoot = null;
                try { workspaceRoot = loadWorkspace().workspaceRoot; } catch {}
                const runtime = readRuntimeLogs({ ...filters, limit, workspaceRoot });
                logs.push(...runtime.logs);
                sources.push(...runtime.sources);
                if (runtime.warnings) warnings.push(...runtime.warnings);
            }
            if (args.includeBridge !== false) {
                const bridge = readBridgeLogs({ ...filters, limit });
                logs.push(...bridge.logs);
                sources.push(...bridge.sources);
                if (bridge.warnings) warnings.push(...bridge.warnings);
            }
            logs.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
            return { success: true, logs: logs.slice(-limit), sources: [...new Set(sources)], warnings: [...new Set(warnings)], limit, order: 'oldest_to_newest', filters };
        })(), 'get_runtime_logs');
    }

    static get_debug_bundle(args = {}) {
        return response((async () => {
            const limit = Math.max(1, Number(args.limit || 200));
            const warnings = [];
            let workspaceStatus = null;
            let derivativeStatus = null;
            let visualReviews = [];
            let inspectionSnapshots = [];
            let runtimeLogs = { logs: [], sources: [], warnings: [] };
            let bridgeLogs = { logs: [], sources: [], warnings: [] };
            try {
                const manifest = loadWorkspace();
                workspaceStatus = {
                    success: true,
                    workspaceRoot: manifest.workspaceRoot,
                    workingCopyPath: manifest.workingCopyPath,
                    inputCopyPath: manifest.inputCopyPath,
                    folders: workspaceFolders(manifest),
                    versionCount: manifest.versions?.length || 0,
                    previewCount: manifest.previews?.length || 0,
                    derivatives: manifest.derivatives || []
                };
                if (args.derivativeId) derivativeStatus = manifest.derivatives.find((d) => d.derivativeId === args.derivativeId) || null;
                if (args.includeVisualReviews !== false) {
                    const p = path.join(manifest.workspaceRoot, 'logs', 'visual_reviews.jsonl');
                    visualReviews = readJsonlRecords(p, { limit }).logs.filter((review) => !args.derivativeId || review.derivativeId === args.derivativeId);
                }
                if (args.includeInspections !== false) {
                    inspectionSnapshots = this.loadInspectionSnapshots(manifest).filter((snapshot) => !args.derivativeId || snapshot.derivativeId === args.derivativeId).slice(-limit);
                }
            } catch (error) {
                warnings.push(error.message);
                workspaceStatus = { success: false, error: error.message };
            }
            try {
                bridgeLogs = readBridgeLogs({ traceId: args.traceId || null, limit });
                if (bridgeLogs.warnings) warnings.push(...bridgeLogs.warnings);
            } catch (error) {
                warnings.push(error.message);
            }
            try {
                let workspaceRoot = null;
                try { workspaceRoot = loadWorkspace().workspaceRoot; } catch {}
                runtimeLogs = readRuntimeLogs({ traceId: args.traceId || null, limit, workspaceRoot });
                if (runtimeLogs.warnings) warnings.push(...runtimeLogs.warnings);
            } catch (error) {
                warnings.push(error.message);
            }
            let bridgeStatus = await ScriptExecutor.bridgeStatus();
            return {
                success: true,
                workspaceStatus,
                bridgeStatus,
                uxpExecution: getUxpBusyGateStatus(),
                runtimeLogs: args.includeLogs === false ? null : runtimeLogs,
                bridgeLogs: args.includeLogs === false ? null : bridgeLogs,
                visualReviews,
                inspectionSnapshots,
                derivativeStatus,
                warnings: [...new Set(warnings)]
            };
        })(), 'get_debug_bundle');
    }

    static create_derivative_page(args = {}) {
        return response((async () => {
            if (!args.derivativeId) throw new Error('derivativeId is required');
            const manifest = loadWorkspace();
            const pageSize = derivativePageSize(args);
            const basePageIndex = args.basePageIndex ?? 0;
            const created = await this.createPageRaw({
                pageWidth: pageSize.width,
                pageHeight: pageSize.height,
                unit: 'pt',
                name: args.name,
                derivativeId: args.derivativeId
            });
            await this.createDerivativePageMarker({ derivativeId: args.derivativeId, pageIndex: created.pageIndex });
            let duplicatedMotifs = [];
            let duplicateWarnings = [];
            let skippedMotifs = [];
            if (args.duplicateBaseMotifs) {
                const dupe = unwrapToolResult(await this.duplicate_items_to_page({
                    sourceLabelQueries: [{ editable: true }],
                    sourcePageIndex: basePageIndex,
                    targetPageIndex: created.pageIndex,
                    preserveRelativePositions: true,
                    labelPatch: { derivativeId: args.derivativeId, duplicatedFromBasePageIndex: basePageIndex },
                    textDuplicateMode: args.textDuplicateMode || 'skip'
                }));
                duplicatedMotifs = dupe.duplicatedObjects || [];
                duplicateWarnings = dupe.warnings || [];
                skippedMotifs = dupe.skippedObjects || [];
            }
            upsertDerivativePage(manifest, args.derivativeId, {
                pageIndex: created.pageIndex,
                pageId: created.pageId ?? null,
                pageName: created.name || null,
                pageBounds: created.pageBounds || null,
                spreadIndex: created.spreadIndex ?? null,
                name: args.name || created.name || null,
                format: args.pageSize || 'custom',
                pageSize,
                basePageIndex,
                status: 'draft'
            });
            return {
                success: true,
                derivativeId: args.derivativeId,
                pageIndex: created.pageIndex,
                pageId: created.pageId ?? null,
                pageName: created.name || null,
                pageBounds: created.pageBounds || null,
                spreadIndex: created.spreadIndex ?? null,
                pageSize,
                ...(duplicatedMotifs.length ? { duplicatedMotifs } : {}),
                ...(skippedMotifs.length ? { skippedMotifs } : {}),
                ...(duplicateWarnings.length ? { duplicateWarnings } : {})
            };
        })(), 'create_derivative_page');
    }

    static duplicate_template_page(args = {}) {
        return response((async () => {
            if (!args.derivativeId) throw new Error('derivativeId is required');
            if (!Number.isInteger(args.sourcePageIndex) || args.sourcePageIndex < 0) throw new Error('sourcePageIndex must be an integer >= 0');
            const textSafetyMode = args.textSafetyMode || 'preserve_but_guard';
            if (textSafetyMode === 'fresh_text_slots') {
                throw new Error('textSafetyMode=fresh_text_slots is not implemented; use preserve_but_guard or create fresh slots explicitly with create_text_slot.');
            }
            const manifest = loadWorkspace();
            const existingDerivative = (manifest.derivatives || []).find((entry) => entry.derivativeId === args.derivativeId);
            if (existingDerivative) {
                throw new Error('derivativeId already exists in workspace manifest: ' + args.derivativeId + ' ' + JSON.stringify({
                    pageIndex: existingDerivative.pageIndex ?? null,
                    pageId: existingDerivative.pageId ?? null,
                    pageName: existingDerivative.pageName || null,
                    source: existingDerivative.source || null,
                    status: existingDerivative.status || null
                }));
            }
            const payload = {
                ...args,
                relabelSlots: args.relabelSlots !== false,
                copyPageLabel: args.copyPageLabel === true,
                requireUniqueSlots: args.requireUniqueSlots !== false,
                includeObjectSummary: args.includeObjectSummary !== false,
                textSafetyMode
            };
            const duplicated = await runGuarded(`${jsHelpers()} const args=${q(payload)};
                const sourcePage = pageByIndex(args.sourcePageIndex);
                const existingMatches = [];
                for (const page of arr(doc.pages, (page) => page)) {
                    const label = readLabel(page);
                    if (label && label.derivativeId === args.derivativeId) {
                        existingMatches.push({
                            objectId: safe(() => page.id, null),
                            name: safe(() => page.name, null),
                            type: 'Page',
                            pageIndex: collectionIndexById(doc.pages, page),
                            label: clone(label)
                        });
                    }
                }
                for (const item of arr(doc.allPageItems || doc.pageItems, (item) => item)) {
                    const label = readLabel(item);
                    if (label && label.derivativeId === args.derivativeId) {
                        existingMatches.push({
                            objectId: safe(() => item.id, null),
                            name: safe(() => item.name, null),
                            type: safe(() => item.constructor && item.constructor.name, null),
                            pageIndex: pageIndexOf(item),
                            label: clone(label)
                        });
                    }
                }
                if (existingMatches.length) {
                    throw new Error('derivativeId already exists in document: ' + args.derivativeId + ' ' + JSON.stringify(existingMatches.slice(0, 10)));
                }
                let createdPage = null;
                try {
                    createdPage = sourcePage.duplicate();
                    if (args.name) createdPage.name = String(args.name);

                    const copiedItems = arr(safe(() => createdPage.allPageItems, createdPage.pageItems), (item) => item)
                        .filter((item) => item && safe(() => item.isValid !== false, true));
                    let removedCopiedMarkers = 0;
                    for (const item of copiedItems.slice()) {
                        const label = readLabel(item);
                        if (label.role === 'page_marker' && label.metadata === true) {
                            try { item.remove(); removedCopiedMarkers += 1; } catch (error) {}
                        }
                    }

                    const pageItems = arr(safe(() => createdPage.allPageItems, createdPage.pageItems), (item) => item)
                        .filter((item) => item && safe(() => item.isValid !== false, true));
                    const sourcePageLabel = readLabel(sourcePage);
                    const pageLabel = Object.assign(
                        {},
                        args.copyPageLabel ? sourcePageLabel : {},
                        { derivativeId: args.derivativeId, role: 'derivative_page', source: 'duplicate_template_page', sourcePageIndex: args.sourcePageIndex }
                    );
                    writeLabel(createdPage, pageLabel);

                    const copiedSlotItems = [];
                    for (const item of pageItems) {
                        let label = readLabel(item);
                        if (typeof label.slot !== 'string' || label.slot.length === 0) continue;
                        if (args.relabelSlots) {
                            label = Object.assign({}, label, {
                                derivativeId: args.derivativeId,
                                duplicatedFromTemplatePageIndex: args.sourcePageIndex
                            });
                            writeLabel(item, label);
                        }
                        copiedSlotItems.push({ item, label });
                    }

                    const duplicateSlotDetails = [];
                    const slotItemsByName = {};
                    for (const candidate of copiedSlotItems) {
                        const slot = candidate.label.slot;
                        const key = String(slot);
                        if (!slotItemsByName[key]) slotItemsByName[key] = [];
                        slotItemsByName[key].push({
                            objectId: safe(() => candidate.item.id, null),
                            name: safe(() => candidate.item.name, null),
                            type: safe(() => candidate.item.constructor && candidate.item.constructor.name, null),
                            pageIndex: pageIndexOf(candidate.item),
                            label: clone(candidate.label)
                        });
                    }
                    for (const [slot, items] of Object.entries(slotItemsByName)) {
                        if (items.length > 1) duplicateSlotDetails.push({ slot, items });
                    }
                    if (args.requireUniqueSlots && duplicateSlotDetails.length) {
                        throw new Error('Duplicate slot labels on copied page: ' + JSON.stringify(duplicateSlotDetails));
                    }

                    const slotCandidates = [];
                    for (const item of pageItems) {
                        if (!isTextFrame(item)) continue;
                        const label = readLabel(item);
                        if (typeof label.slot !== 'string' || label.slot.length === 0) continue;
                        if (args.slotLabelQuery && !labelMatches(label, args.slotLabelQuery)) continue;
                        slotCandidates.push({ item, label, diagnostics: textFrameDiagnostics(item, { excerptLimit: 200 }) });
                    }

                    const textSlots = [];
                    const warnings = [];
                    for (const candidate of slotCandidates) {
                        const threadedOrShared = textFrameIsThreadedOrShared(candidate.item, candidate.diagnostics);
                        let label = candidate.label;
                        if (args.relabelSlots) {
                            label = Object.assign({}, label, {
                                derivativeId: args.derivativeId,
                                duplicatedFromTemplatePageIndex: args.sourcePageIndex,
                                duplicatedTextFrame: true,
                                textSafetyMode: args.textSafetyMode,
                                requiresTextSafetyCheck: true
                            });
                            if (args.textSafetyMode === 'raw') label.rawTextDuplicate = true;
                            writeLabel(candidate.item, label);
                        }
                        if (threadedOrShared) warnings.push('Slot ' + label.slot + ' appears threaded/shared; update_text_slot isolatedOnly will refuse it.');
                        if (candidate.diagnostics.overflows) warnings.push('Slot ' + label.slot + ' is overset on the duplicated page.');
                        textSlots.push({
                            slot: label.slot,
                            role: label.role || null,
                            objectId: safe(() => candidate.item.id, null),
                            name: safe(() => candidate.item.name, null),
                            type: safe(() => candidate.item.constructor && candidate.item.constructor.name, null),
                            bounds: clone(safe(() => candidate.item.geometricBounds, null)),
                            label: clone(label),
                            overflows: !!candidate.diagnostics.overflows,
                            textDiagnostics: Object.assign({}, candidate.diagnostics, { threadedOrShared })
                        });
                    }
                    if (args.textSafetyMode === 'raw' && textSlots.length) warnings.push('textSafetyMode=raw preserves duplicated text state; inspect each slot before replacement.');
                    if (removedCopiedMarkers) warnings.push('Removed ' + removedCopiedMarkers + ' copied metadata page marker(s) before creating the new derivative marker.');

                    const pageIndex = collectionIndexById(doc.pages, createdPage);
                    let marker = null;
                    try {
                        const resolved = resolveBoundsForPage({ pageIndex, bounds: [0, 0, 1, 1], unit: 'pt', coordinateSpace: 'page', rejectOutOfPageBounds: false, maxOutsidePageRatio: 1 });
                        let layer = safe(() => doc.layers.itemByName('MCP_METADATA'), null);
                        if (!layer || layer.isValid === false) layer = writableLayer('MCP_METADATA');
                        layer.printable = false;
                        marker = createdPage.rectangles.add({ geometricBounds: resolved.documentBounds, itemLayer: layer });
                        marker.name = String(args.derivativeId) + '__page_marker';
                        marker.nonprinting = true;
                        writeLabel(marker, { derivativeId: args.derivativeId, role: 'page_marker', source: 'mcp', nonprinting: true, metadata: true });
                    } catch (error) {
                        try { if (createdPage) createdPage.remove(); } catch (removeError) {}
                        throw error;
                    }

                    const placedGraphics = [];
                    const imageSlots = [];
                    if (args.includeObjectSummary) {
                        for (const item of pageItems) {
                            const link = linkInfo(item);
                            if (link) placedGraphics.push({ objectId: safe(() => item.id, null), name: safe(() => item.name, null), type: safe(() => item.constructor && item.constructor.name, null), bounds: clone(safe(() => item.geometricBounds, null)), link });
                        }
                        for (const candidate of copiedSlotItems) {
                            if (isTextFrame(candidate.item)) continue;
                            imageSlots.push({ slot: candidate.label.slot, role: candidate.label.role || null, objectId: safe(() => candidate.item.id, null), name: safe(() => candidate.item.name, null), type: safe(() => candidate.item.constructor && candidate.item.constructor.name, null), bounds: clone(safe(() => candidate.item.geometricBounds, null)), label: clone(candidate.label), link: linkInfo(candidate.item) });
                        }
                    }
                    const bounds = clone(safe(() => createdPage.bounds, null));
                    return {
                        success: true,
                        derivativeId: args.derivativeId,
                        sourcePageIndex: args.sourcePageIndex,
                        pageIndex,
                        pageId: safe(() => createdPage.id, null),
                        pageName: safe(() => createdPage.name, null),
                        pageBounds: bounds,
                        pageSize: bounds ? { width: bounds[3] - bounds[1], height: bounds[2] - bounds[0], unit: 'pt' } : null,
                        spreadIndex: collectionIndexById(doc.spreads, safe(() => createdPage.parent, null)),
                        copiedObjectCount: pageItems.length,
                        textSlots,
                        imageSlots,
                        placedGraphics,
                        marker: marker ? { objectId: safe(() => marker.id, null), name: safe(() => marker.name, null), pageIndex } : null,
                        warnings
                    };
                } catch (error) {
                    if (createdPage) { try { createdPage.remove(); } catch (removeError) {} }
                    throw error;
                }
            `);
            upsertDerivativePage(manifest, args.derivativeId, {
                pageIndex: duplicated.pageIndex,
                pageId: duplicated.pageId ?? null,
                pageName: duplicated.pageName || null,
                pageBounds: duplicated.pageBounds || null,
                pageSize: duplicated.pageSize || null,
                spreadIndex: duplicated.spreadIndex ?? null,
                sourcePageIndex: args.sourcePageIndex,
                source: 'duplicate_template_page',
                status: 'draft',
                name: args.name || duplicated.pageName || null
            });
            return {
                ...duplicated,
                warnings: [...new Set([
                    ...(duplicated.warnings || []),
                    'Full-page duplication and visual fidelity require live Mac/InDesign/UXP validation; this tool is covered locally only.'
                ])],
                unsupportedLiveValidation: true
            };
        })(), 'duplicate_template_page');
    }

    static resolve_derivative_page(args = {}) {
        return response((async () => {
            const manifest = loadWorkspace();
            const derivative = args.derivativeId ? this.resolveDerivativeRecord(manifest, args) : null;
            const pageScan = await runGuarded(`${jsHelpers()} const args=${q(args)};
                function pageRecord(page, resolvedBy, warnings){
                    const spread = safe(() => page.parent, null);
                    const bounds = clone(safe(() => page.bounds, null));
                    return {
                        success: true,
                        pageIndex: collectionIndexById(doc.pages, page),
                        pageId: safe(() => page.id, null),
                        pageName: safe(() => page.name, null),
                        pageBounds: bounds,
                        pageSize: bounds ? { width: bounds[3] - bounds[1], height: bounds[2] - bounds[0], unit: 'pt' } : null,
                        spreadIndex: spread ? collectionIndexById(doc.spreads, spread) : null,
                        resolvedBy,
                        warnings: warnings || []
                    };
                }
                function pageLabel(page){
                    let raw = '';
                    try { raw = page.extractLabel ? page.extractLabel(${q(LABEL_KEY)}) : page.label; } catch(e) {}
                    try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
                }
                const targetDerivativeId = args.derivativeId || null;
                const warnings = [];
                let page = null;
                if (${q(!!derivative)} && ${q(derivative?.pageId ?? null)} != null) {
                    for (let i = 0; i < len(doc.pages); i++) {
                        const candidate = at(doc.pages, i);
                        if (safe(() => candidate.id, null) === ${q(derivative?.pageId ?? null)}) { page = candidate; break; }
                    }
                    if (page) return pageRecord(page, 'pageId', warnings);
                }
                if (targetDerivativeId) {
                    for (let i = 0; i < len(doc.pages); i++) {
                        const candidate = at(doc.pages, i);
                        if (pageLabel(candidate).derivativeId === targetDerivativeId) return pageRecord(candidate, 'pageLabel', warnings);
                    }
                    const items = arr(doc.allPageItems || doc.pageItems, x => x);
                    for (const item of items) {
                        const label = readLabel(item);
                        if (label.derivativeId === targetDerivativeId && label.role === 'page_marker') {
                            const pp = safe(() => item.parentPage, null);
                            if (pp) return pageRecord(pp, 'pageMarker', warnings);
                        }
                    }
                    for (let i = 0; i < len(doc.pages); i++) {
                        const candidate = at(doc.pages, i);
                        if (${q(derivative?.pageName ?? null)} && safe(() => candidate.name, null) === ${q(derivative?.pageName ?? null)}) return pageRecord(candidate, 'pageName', warnings);
                    }
                    for (const item of arr(doc.allPageItems || doc.pageItems, x => x)) {
                        const label = readLabel(item);
                        if (label.derivativeId === targetDerivativeId) {
                            const pp = safe(() => item.parentPage, null);
                            if (pp) return pageRecord(pp, 'objectLabel', warnings);
                        }
                    }
                }
                if (args.pageIndex != null) {
                    const candidate = pageByIndex(args.pageIndex);
                    warnings.push('Resolved by pageIndex fallback only');
                    return pageRecord(candidate, 'pageIndex', warnings);
                }
                throw new Error('Unable to resolve derivative page');
            `);
            const derivativeId = args.derivativeId || derivative?.derivativeId || null;
            const warnings = [...(pageScan.warnings || [])];
            if (derivativeId) {
                if (derivative && derivative.pageIndex != null && derivative.pageIndex !== pageScan.pageIndex) {
                    warnings.push(`Manifest pageIndex updated from ${derivative.pageIndex} to ${pageScan.pageIndex}`);
                }
                upsertDerivativePage(manifest, derivativeId, {
                    pageIndex: pageScan.pageIndex,
                    pageId: pageScan.pageId,
                    pageName: pageScan.pageName,
                    pageBounds: pageScan.pageBounds,
                    spreadIndex: pageScan.spreadIndex,
                    pageSize: pageScan.pageSize
                });
            }
            return { success: true, derivativeId, ...pageScan, warnings };
        })(), 'resolve_derivative_page');
    }

    static inspect_page_geometry(args = {}) {
        return response((async () => {
            const resolved = args.derivativeId ? unwrapToolResult(await this.resolve_derivative_page({ derivativeId: args.derivativeId })) : { pageIndex: args.pageIndex };
            return runGuarded(`${jsHelpers()} const args=${q({ pageIndex: resolved.pageIndex })};
                const page = pageByIndex(args.pageIndex);
                const spread = safe(() => page.parent, null);
                const spreadPages = arr(safe(() => spread.pages, []), (p) => clone(safe(() => p.bounds, null))).filter(Boolean);
                const spreadBounds = spreadPages.length ? [Math.min(...spreadPages.map((b) => b[0])), Math.min(...spreadPages.map((b) => b[1])), Math.max(...spreadPages.map((b) => b[2])), Math.max(...spreadPages.map((b) => b[3]))] : clone(page.bounds);
                const bounds = clone(page.bounds);
                const margins = safe(() => page.marginPreferences, null);
                const docUnits = safe(() => doc.viewPreferences, null);
                return {
                    success: true,
                    pageIndex: args.pageIndex,
                    pageId: safe(() => page.id, null),
                    pageName: safe(() => page.name, null),
                    pageBounds: bounds,
                    pageSize: { width: bounds[3] - bounds[1], height: bounds[2] - bounds[0], unit: 'pt' },
                    spreadIndex: spread ? collectionIndexById(doc.spreads, spread) : null,
                    spreadBounds,
                    rulerOrigin: safe(() => String(docUnits.rulerOrigin), null),
                    facingPages: safe(() => doc.documentPreferences.facingPages, null),
                    marginPreferences: margins ? { top: safe(() => margins.top, 0), bottom: safe(() => margins.bottom, 0), left: safe(() => margins.left, 0), right: safe(() => margins.right, 0), columnCount: safe(() => margins.columnCount, 1), columnGutter: safe(() => margins.columnGutter, 0) } : null,
                    bleed: { top: safe(() => doc.documentPreferences.documentBleedTopOffset, null), bottom: safe(() => doc.documentPreferences.documentBleedBottomOffset, null), insideOrLeft: safe(() => doc.documentPreferences.documentBleedInsideOrLeftOffset, null), outsideOrRight: safe(() => doc.documentPreferences.documentBleedOutsideOrRightOffset, null) },
                    slug: { top: safe(() => doc.documentPreferences.slugTopOffset, null), bottom: safe(() => doc.documentPreferences.slugBottomOffset, null), insideOrLeft: safe(() => doc.documentPreferences.slugInsideOrLeftOffset, null), outsideOrRight: safe(() => doc.documentPreferences.slugRightOrOutsideOffset, null) },
                    documentUnits: { horizontalMeasurementUnits: safe(() => String(docUnits.horizontalMeasurementUnits), null), verticalMeasurementUnits: safe(() => String(docUnits.verticalMeasurementUnits), null), rulerOrigin: safe(() => String(docUnits.rulerOrigin), null) },
                    warnings: []
                };
            `);
        })(), 'inspect_page_geometry');
    }

    static duplicate_items_to_page(args = {}) {
        return response(runGuarded(`${jsHelpers()} const args=${q(args)};
            function collectSourceItems(){
                const hits=[];
                if (Array.isArray(args.sourceObjectIds)) for (const id of args.sourceObjectIds) hits.push(itemById(id));
                if (Array.isArray(args.sourceLabelQueries)) {
                    for (const query of args.sourceLabelQueries) {
                        const items = arr(doc.allPageItems || doc.pageItems, (x)=>x).filter((it)=>labelMatches(readLabel(it), query) && (args.sourcePageIndex == null || pageIndexOf(it) === args.sourcePageIndex));
                        hits.push(...items);
                    }
                }
                const seen = new Set();
                return hits.filter((item)=>{ const id=safe(()=>item.id); if (seen.has(id)) return false; seen.add(id); return true; });
            }
            function transformBounds(bounds){
                if (!Array.isArray(bounds) || bounds.length !== 4) return null;
                const offset = Array.isArray(args.offset) ? [toPt(Number(args.offset[0] || 0), 'pt'), toPt(Number(args.offset[1] || 0), 'pt')] : [0, 0];
                const scale = args.scale == null ? 1 : Number(args.scale);
                const top = bounds[0] + offset[0];
                const left = bounds[1] + offset[1];
                const width = widthOf(bounds) * scale;
                const height = heightOf(bounds) * scale;
                return args.preserveRelativePositions !== false ? [top, left, top + height, left + width] : clone(bounds);
            }
            function textDupMode(){ const mode = String(args.textDuplicateMode || 'skip'); return mode === 'fresh' || mode === 'raw' ? mode : 'skip'; }
            function makeFreshTextFrame(source, targetPage, sourceBounds){
                const fresh = targetPage.textFrames.add();
                const captured = textFrameStyleSnapshot(source);
                const nextBounds = transformBounds(sourceBounds);
                if (nextBounds) fresh.geometricBounds = nextBounds;
                fresh.contents = String(safe(()=>source.contents, '') || '');
                const name = args.renamePrefix ? String(args.renamePrefix) + (safe(()=>source.name) || safe(()=>source.id)) : safe(()=>source.name, null);
                applyBasics(fresh, { name, objectStyle: captured.objectStyle, fillSwatch: captured.fillSwatch, strokeSwatch: captured.strokeSwatch, strokeWeight: captured.strokeWeight, label: Object.assign({}, readLabel(source), args.labelPatch || {}, { textDuplicatedAsFreshFrame: true, storyIsolated: true, sourceObjectId: safe(()=>source.id, null) }) });
                applyTextFrameStyleSnapshot(fresh, captured);
                return { fresh, captured, nextBounds };
            }
            const sourceItems = collectSourceItems();
            if (!sourceItems.length) throw new Error('No source items matched');
            const targetPage = pageByIndex(args.targetPageIndex);
            const mode = textDupMode();
            const duplicatedObjects = [];
            const skippedObjects = [];
            const warnings = [];
            for (const source of sourceItems) {
                const sourceBounds = clone(safe(()=>source.geometricBounds, null));
                const sourceDiag = isTextFrame(source) ? textFrameDiagnostics(source, { excerptLimit: 180 }) : null;
                if (isTextFrame(source) && mode === 'skip') {
                    skippedObjects.push({ sourceObjectId:safe(()=>source.id), name:safe(()=>source.name), type:safe(()=>source.constructor.name), pageIndex:pageIndexOf(source), label:clone(readLabel(source)), reason:'text_frame_skipped_to_avoid_story_thread_state', textDiagnostics:sourceDiag });
                    continue;
                }
                let duplicate;
                let textDuplicate = null;
                if (isTextFrame(source) && mode === 'fresh') {
                    const fresh = makeFreshTextFrame(source, targetPage, sourceBounds);
                    duplicate = fresh.fresh;
                    textDuplicate = { textDuplicateMode: mode, storyIsolated: true, storyDiagnostics: sourceDiag, capturedStyles: fresh.captured };
                    const transformed = fresh.nextBounds;
                    if (transformed) setBoundsRaw(duplicate, transformed);
                } else {
                    duplicate = source.duplicate(targetPage);
                    const duplicateBounds = clone(safe(()=>duplicate.geometricBounds, null));
                    const transformed = transformBounds(duplicateBounds);
                    if (transformed) setBoundsRaw(duplicate, transformed);
                    if (isTextFrame(source) && mode === 'raw') {
                        warnings.push('Raw duplicated text frame may retain story/thread/overset state; do not edit as normal text.');
                        textDuplicate = { textDuplicateMode: mode, storyIsolated: false, storyDiagnostics: sourceDiag, rawTextDuplicate: true };
                    }
                }
                if (args.renamePrefix) duplicate.name = String(args.renamePrefix) + (safe(()=>source.name) || safe(()=>source.id));
                const label = Object.assign({}, readLabel(duplicate), args.labelPatch || {});
                if (textDuplicate) Object.assign(label, textDuplicate);
                if (isTextFrame(source) && mode === 'fresh') Object.assign(label, { textDuplicatedAsFreshFrame: true, storyIsolated: true });
                if (isTextFrame(source) && mode === 'raw') Object.assign(label, { rawTextDuplicate: true });
                writeLabel(duplicate, label);
                duplicatedObjects.push({ sourceObjectId:safe(()=>source.id), objectId:safe(()=>duplicate.id), name:safe(()=>duplicate.name), type:safe(()=>duplicate.constructor.name), pageIndex:args.targetPageIndex, bounds:clone(safe(()=>duplicate.geometricBounds)), label, ...(textDuplicate || {}), ...(isTextFrame(source) ? { textDiagnostics: sourceDiag } : {}) });
            }
            return { success:true, duplicatedObjects, skippedObjects, warnings };
        `), 'duplicate_items_to_page');
    }

    static create_text_slot(args = {}) {
        return response((async () => {
            if (!args.role || !args.slot || !args.bounds || args.text == null) throw new Error('role, slot, bounds, and text are required');
            const target = await this.resolveDerivativeTarget(args);
            const label = shallowMergeLabel({ derivativeId: args.derivativeId, role: args.role, slot: args.slot, source: 'agent_created', editable: true, placeholder: false }, args.label);
            const created = await this.uxpTool('create_text_frame', {
                ...args,
                pageIndex: target.pageIndex,
                name: args.name || `${target.derivativeId || args.derivativeId || 'page'}__${args.role}__text`,
                label,
                text: String(args.text)
            });
            let fitResult = null;
            if (args.autoFit) fitResult = await this.fit_text_to_frame({ objectId: created.objectId });
            return { ...created, label, derivativeId: target.derivativeId || args.derivativeId || null, pageIndex: target.pageIndex, pageId: target.pageId || null, resolvedBy: target.resolvedBy, warnings: [...new Set([...(target.warnings || []), ...(created.warnings || [])])], ...(fitResult ? { fitResult } : {}) };
        })(), 'create_text_slot');
    }

    static create_image_slot(args = {}) {
        return response((async () => {
            if (!args.role || !args.slot || !args.bounds) throw new Error('role, slot, and bounds are required');
            const target = await this.resolveDerivativeTarget(args);
            const manifest = loadWorkspace();
            const imagePath = args.imagePath ? resolveWorkspaceImagePath(args.imagePath, manifest) : null;
            const label = shallowMergeLabel({ derivativeId: args.derivativeId, role: args.role, slot: args.slot, source: 'agent_created', editable: true, placeholder: !imagePath && args.placeholder !== false }, args.label);
            const created = await this.uxpTool('create_image_frame', {
                ...args,
                pageIndex: target.pageIndex,
                imagePath,
                placeholder: !imagePath && args.placeholder !== false,
                name: args.name || `${target.derivativeId || args.derivativeId || 'page'}__${args.role}__image_frame`,
                label
            });
            return { ...created, derivativeId: target.derivativeId || args.derivativeId || null, pageIndex: target.pageIndex, pageId: target.pageId || null, resolvedBy: target.resolvedBy, warnings: [...new Set([...(target.warnings || []), ...(created.warnings || [])])] };
        })(), 'create_image_slot');
    }

    static fit_text_to_frame(args = {}) {
        return response(runGuarded(`${jsHelpers()} const args=${q(args)};
            const it = resolveItem(args);
            if (!isTextFrame(it)) throw new Error('Target is not a text frame');
            const actions = ['heuristic'];
            const textDiagBefore = textFrameDiagnostics(it, { excerptLimit: 200 });
            if (textFrameIsThreadedOrShared(it, textDiagBefore) && args.allowThreadedText !== true) {
                const warnings = ['Target appears threaded/shared; fit heuristic skipped. Use create_text_slot or explicit opt-in after inspection.'];
                return { success:true, objectId:safe(()=>it.id), before:{ ...textDiagBefore, leading:Number(safe(()=>safe(()=>it.texts.item(0), null)?.leading, 0) || 0), pointSize:Number(safe(()=>safe(()=>it.texts.item(0), null)?.pointSize, 0) || 0) }, after:clone(textDiagBefore), actions:['heuristic','skipped_threaded_text'], iterations:0, resolved:false, stillOverset:!!textDiagBefore.overflows, warnings, textDiagnosticsBefore:textDiagBefore, textDiagnosticsAfter:textDiagBefore };
            }
            function firstTextRange(){ return safe(()=>it.texts.item(0), null); }
            function state(){ const t = firstTextRange(); return { pointSize:Number(safe(()=>t.pointSize, 0) || 0), leading:Number(safe(()=>t.leading, 0) || 0), tracking:Number(safe(()=>t.tracking, 0) || 0), bounds:clone(safe(()=>it.geometricBounds)), overset:!!safe(()=>it.overflows,false) }; }
            function applyPointSize(value){ const t = firstTextRange(); if (t) t.pointSize = value; }
            function applyLeading(value){ const t = firstTextRange(); if (t) t.leading = value; }
            function applyTracking(value){ const t = firstTextRange(); if (t) t.tracking = value; }
            const before = state();
            const minPointSize = Number(args.minPointSize ?? 6);
            const maxPointSize = Number(args.maxPointSize ?? (before.pointSize || 72));
            const minLeading = Number(args.minLeading ?? Math.max(6, Math.min(before.leading || before.pointSize || 6, (before.pointSize || 6) * 0.85)));
            const minTracking = Number(args.minTracking ?? -50);
            const maxIterations = Number(args.maxIterations ?? 12);
            const maxGrowPt = args.maxGrowMm != null ? toPt(Number(args.maxGrowMm), args.unit || 'mm') : toPt(10, 'mm');
            let grownPt = 0;
            let iterations = 0;
            while (safe(()=>it.overflows,false) && iterations < maxIterations) {
                iterations += 1;
                const current = state();
                if (current.pointSize > minPointSize) { applyPointSize(Math.max(minPointSize, current.pointSize - 1)); actions.push('reduce_point_size'); continue; }
                if (current.leading > minLeading) { applyLeading(Math.max(minLeading, current.leading - 1)); actions.push('reduce_leading'); continue; }
                if (args.allowTrackingTighten && current.tracking > minTracking) { applyTracking(Math.max(minTracking, current.tracking - 5)); actions.push('tighten_tracking'); continue; }
                if (args.allowFrameGrow) {
                    if (grownPt >= maxGrowPt) break;
                    const currentBounds = clone(it.geometricBounds);
                    const growth = Math.min(maxGrowPt - grownPt, toPt(2, 'mm'));
                    if (growth <= 0) break;
                    grownPt += growth;
                    const nextBounds = (args.growAnchor || 'topLeft') === 'center'
                        ? [currentBounds[0] - growth / 2, currentBounds[1] - growth / 2, currentBounds[2] + growth / 2, currentBounds[3] + growth / 2]
                        : [currentBounds[0], currentBounds[1], currentBounds[2] + growth, currentBounds[3] + growth];
                    setBoundsRaw(it, nextBounds); actions.push('grow_frame'); continue;
                }
                break;
            }
            const after = state();
            const textDiagAfter = textFrameDiagnostics(it, { excerptLimit: 200 });
            const warnings = [];
            if (after.overset) warnings.push('Text still overset after fit heuristic; inspect and resize/rewrite manually.');
            return { success:true, objectId:safe(()=>it.id), before, after, actions, iterations, resolved:after.overset === false, stillOverset:after.overset === true, warnings, textDiagnosticsBefore:textDiagBefore, textDiagnosticsAfter:textDiagAfter };
        `), 'fit_text_to_frame');
    }

    static export_derivative_preview(args = {}) {
        return response((async () => {
            if (!args.derivativeId && args.pageIndex == null) throw new Error('derivativeId or pageIndex is required');
            const resolved = args.derivativeId ? unwrapToolResult(await this.resolve_derivative_page({ derivativeId: args.derivativeId })) : { pageIndex: args.pageIndex, pageId: null };
            const manifest = loadWorkspace();
            const previewSettings = resolvePreviewExportSettings(args);
            const ext = (args.format || 'png').toLowerCase() === 'jpg' ? 'jpg' : 'png';
            const derivativeId = args.derivativeId || this.resolveDerivativeRecord(manifest, { pageIndex: resolved.pageIndex }).derivativeId;
            const existing = (manifest.previews || []).filter((preview) => preview.derivativeId === derivativeId && preview.pageIndex === resolved.pageIndex);
            const outputName = normalizePreviewOutputName(
                args.outputName,
                ext,
                `${derivativeId}__${resolved.pageIndex}__preview_${String(existing.length + 1).padStart(3, '0')}`
            );
            const rec = unwrapToolResult(await this.exportPreview('page', {
                ...args,
                derivativeId,
                pageIndex: resolved.pageIndex,
                format: ext,
                outputName,
                overwrite: args.overwrite,
                previewQuality: previewSettings.previewQuality,
                resolution: previewSettings.resolution
            }));
            const previewId = `preview_${derivativeId}_${String(existing.length + 1).padStart(3, '0')}`;
            const preview = {
                ...rec,
                success: true,
                previewId,
                derivativeId,
                pageId: resolved.pageId || null,
                spreadIndex: resolved.spreadIndex ?? null,
                mimeType: rec.mimeType || (ext === 'jpg' ? 'image/jpeg' : 'image/png'),
                format: ext,
                previewQuality: rec.previewQuality || previewSettings.previewQuality,
                resolution: rec.resolution || previewSettings.resolution,
                createdAt: nowIso(),
            };
            const fresh = loadWorkspace();
            const persistedPreview = { ...preview };
            delete persistedPreview.mcpImage;
            fresh.previews = (fresh.previews || []).filter((item) => item.previewId !== rec.previewId).concat(persistedPreview);
            const derivative = (fresh.derivatives || []).find((item) => item.derivativeId === derivativeId) || null;
            if (!derivative) throw new Error(`Unknown derivativeId: ${derivativeId}`);
            derivative.latestPreviewId = previewId;
            derivative.previewIds = [...new Set([...(derivative.previewIds || []), previewId])];
            derivative.updatedAt = nowIso();
            saveWorkspace(fresh);
            if (args.returnImage !== false) {
                preview.mcpImage = buildMcpImagePayload(preview.path, preview.mimeType);
            }
            return preview;
        })(), 'export_derivative_preview');
    }

    static inspect_derivative(args = {}) {
        return response((async () => {
            const manifest = loadWorkspace();
            const derivative = this.resolveDerivativeRecord(manifest, args);
            const resolved = unwrapToolResult(await this.resolve_derivative_page({ derivativeId: derivative.derivativeId }));
            const itemsResult = await this.inspectPageItemsRaw({ pageIndex: resolved.pageIndex, includeHidden: true, includeTextExcerpt: true });
            const checksResult = args.includeChecks ? unwrapToolResult(await this.run_derivative_checks({ derivativeId: derivative.derivativeId })) : null;
            const objects = itemsResult.items || [];
            const metadataObjects = objects.filter((item) => item.label?.role === 'page_marker' || item.label?.metadata === true);
            const visibleObjects = objects.filter((item) => !metadataObjects.includes(item));
            const textSlots = visibleObjects.filter((item) => item.type && /TextFrame/i.test(item.type));
            const imageSlots = visibleObjects.filter((item) => item.image?.hasPlacedGraphic || /Rectangle|Oval|Polygon/i.test(item.type || '')).filter((item) => item.label?.slot || item.image?.hasPlacedGraphic);
            const vectorObjects = visibleObjects.filter((item) => !item.text && !item.image?.hasPlacedGraphic);
            const unlabeledObjects = objects.filter((item) => !item.label || !Object.keys(item.label).length);
            const previews = (manifest.previews || []).filter((preview) => preview.derivativeId === derivative.derivativeId && preview.pageIndex === resolved.pageIndex);
            const versions = (manifest.versions || []).filter((version) => version.derivativeId === derivative.derivativeId);
            const snapshot = { inspectionId: `inspection_${derivative.derivativeId}_${String((derivative.inspectionIds || []).length + 1).padStart(3, '0')}`, derivativeId: derivative.derivativeId, pageIndex: resolved.pageIndex, pageId: resolved.pageId || null, createdAt: nowIso(), previewId: derivative.latestPreviewId || null, objects: visibleObjects, textSlots, imageSlots, vectorObjects, unlabeledObjects, checks: checksResult?.checks || null };
            this.appendInspectionSnapshot(manifest, snapshot);
            upsertDerivativePage(manifest, derivative.derivativeId, { inspectionIds: [...new Set([...(derivative.inspectionIds || []), snapshot.inspectionId])] });
            return { success:true, derivativeId: derivative.derivativeId, pageIndex: resolved.pageIndex, pageId: resolved.pageId || null, pageName: resolved.pageName || null, pageBounds: resolved.pageBounds || null, pageSize: resolved.pageSize || derivative.pageSize || null, spreadIndex: resolved.spreadIndex ?? null, resolvedBy: resolved.resolvedBy, objectCount: visibleObjects.length, format: derivative.format, objects: args.includeObjectDetails === false ? visibleObjects.map((item) => ({ objectId: item.objectId, name: item.name, type: item.type, bounds: item.bounds, label: item.label })) : visibleObjects, textSlots, imageSlots, vectorObjects, unlabeledObjects, metadataObjects, previews: args.includePreviewHistory ? previews : previews.slice(-1), versions, warnings: resolved.warnings || [], ...(checksResult ? { checks: checksResult.checks } : {}) };
        })(), 'inspect_derivative');
    }

    static apply_layout_recipe(args = {}) {
        return response((async () => {
            if (!args.derivativeId) throw new Error('derivativeId is required');
            const resolvedTarget = await this.resolveDerivativeTarget({ derivativeId: args.derivativeId });
            const result = await runGuarded(`${jsHelpers()} const args=${q({ ...args, resolvedPageIndex: resolvedTarget.pageIndex, resolvedPageId: resolvedTarget.pageId, resolvedBy: resolvedTarget.resolvedBy, pageIdentityWarnings: resolvedTarget.warnings })};
            if (!args.derivativeId) throw new Error('derivativeId is required');
            const edits = Array.isArray(args.edits) ? args.edits : [];
            const mode = args.mode || 'fail_fast';
            if (!edits.length) throw new Error('edits are required');
            if (mode === 'fail_fast') edits.forEach((edit)=>resolveItem(edit));
            const edited = [];
            const errors = [];
            for (const edit of edits) {
                try {
                    const it = resolveItem(edit);
                    const before = itemSnapshot(it);
                    const actions = [];
                    let textReplacement = null;
                    let stillOverset = null;
                    let textWarnings = [];
                    if (edit.setBounds) {
                        if (edit.pageIndex != null && args.resolvedPageIndex != null && edit.pageIndex !== args.resolvedPageIndex && args.allowCrossPageEdit !== true) throw new Error('edit.pageIndex disagrees with resolved derivative page; pass allowCrossPageEdit=true to override');
                        const targetPageIndex = edit.pageIndex != null ? edit.pageIndex : (pageIndexOf(it) != null ? pageIndexOf(it) : args.resolvedPageIndex);
                        if ((edit.coordinateSpace || 'page') === 'page' && targetPageIndex == null) throw new Error('pageIndex is required when target object has no parentPage');
                        const resolved = resolveBoundsForPage({ ...edit, bounds: edit.setBounds, pageIndex: targetPageIndex }, targetPageIndex);
                        const nextBounds = setBoundsSmart(it, resolved.documentBounds, { preserveCenter:edit.preserveCenter, preserveAspectRatio:edit.preserveAspectRatio, anchor:edit.anchor, roundTo:edit.roundTo });
                        validateBoundsOnPage(nextBounds, resolved.pageBounds, edit);
                        actions.push('setBounds');
                    }
                    if (edit.setText != null) {
                        textReplacement = replaceTextFrameContentsSafely(it, edit.setText, { preserveStyle: edit.preserveStyle, textReplacePolicy: edit.textReplacePolicy, expectedOldTextExcerpt: edit.expectedOldTextExcerpt });
                        stillOverset = textReplacement.stillOverset;
                        textWarnings = textReplacement.warnings || [];
                        actions.push('setText');
                    }
                    if (edit.applyStyle) {
                        applyTextStyles(it, edit.applyStyle);
                        if (edit.applyStyle.objectStyle) applyBasics(it, edit.applyStyle);
                        actions.push('applyStyle');
                    }
                    if (edit.applySwatch) {
                        applyBasics(it, edit.applySwatch);
                        const text = safe(()=>it.texts.item(0), null);
                        if (text && edit.applySwatch.textFillSwatch) text.fillColor = named(doc.swatches, edit.applySwatch.textFillSwatch, 'Swatch');
                        actions.push('applySwatch');
                    }
                    if (edit.zOrder === 'front') { it.bringToFront(); actions.push('bringToFront'); }
                    if (edit.zOrder === 'back') { it.sendToBack(); actions.push('sendToBack'); }
                    if (edit.fitMode) { applyFitMode(it, edit.fitMode); actions.push('fitMode'); }
                    if (edit.labelPatch) { writeLabel(it, Object.assign({}, readLabel(it), edit.labelPatch)); actions.push('labelPatch'); }
                    edited.push({ objectId:safe(()=>it.id), name:safe(()=>it.name), before, after:itemSnapshot(it), actions, ...(textReplacement ? { textReplacement, stillOverset, warnings:textWarnings } : {}) });
                } catch (error) {
                    if (mode === 'fail_fast') throw error;
                    errors.push({ edit, error:String(error.message || error) });
                }
            }
            return { success:true, derivativeId:args.derivativeId, pageIdentity:{ derivativeId:args.derivativeId, pageIndex:args.resolvedPageIndex, pageId:args.resolvedPageId || null, resolvedBy:args.resolvedBy || 'derivativeId', warnings:args.pageIdentityWarnings || [] }, edited, ...(errors.length ? { errors } : {}) };
        `, 'apply_layout_recipe');
            return result;
        })(), 'apply_layout_recipe');
    }

    static set_bounds(args = {}) {
        return response(this.uxpTool('set_bounds', args), 'set_bounds');
    }

    static align_items(args = {}) {
        return response((async () => {
            const target = args.derivativeId ? await this.resolveDerivativeTarget({ derivativeId: args.derivativeId }) : (args.pageIndex != null ? { pageIndex: args.pageIndex, pageId: null, resolvedBy: 'pageIndex', warnings: [] } : null);
            const payload = { ...args, pageIndex: target?.pageIndex ?? args.pageIndex ?? null, resolvedPageIndex: target?.pageIndex ?? args.pageIndex ?? null, resolvedPageId: target?.pageId || null, resolvedBy: target?.resolvedBy || null, pageIdentityWarnings: target?.warnings || [] };
            const result = await runGuarded(`${jsHelpers()} const args=${q(payload)};
            const items = resolveItems(args);
            if (!items.length) throw new Error('objectIds are required');
            const before = items.map(itemSnapshot);
            function targetBounds(){
                if (args.alignTo === 'page') return pageBounds(args.pageIndex != null ? args.pageIndex : pageIndexOf(items[0]));
                if (args.alignTo === 'spread') return spreadBoundsForPage(args.pageIndex != null ? args.pageIndex : pageIndexOf(items[0]));
                if (args.alignTo === 'referenceObject') return clone(itemById(args.referenceObjectId).geometricBounds);
                const bounds = items.map((it)=>clone(it.geometricBounds));
                return [Math.min.apply(null,bounds.map((b)=>b[0])), Math.min.apply(null,bounds.map((b)=>b[1])), Math.max.apply(null,bounds.map((b)=>b[2])), Math.max.apply(null,bounds.map((b)=>b[3]))];
            }
            const targetBoundsValue = targetBounds();
            for (const item of items) {
                const bounds = clone(item.geometricBounds);
                const width = widthOf(bounds), height = heightOf(bounds);
                let next = clone(bounds);
                if (args.mode === 'left') next = [bounds[0], targetBoundsValue[1], bounds[0] + height, targetBoundsValue[1] + width];
                else if (args.mode === 'right') next = [bounds[0], targetBoundsValue[3] - width, bounds[0] + height, targetBoundsValue[3]];
                else if (args.mode === 'top') next = [targetBoundsValue[0], bounds[1], targetBoundsValue[0] + height, bounds[1] + width];
                else if (args.mode === 'bottom') next = [targetBoundsValue[2] - height, bounds[1], targetBoundsValue[2], bounds[1] + width];
                else if (args.mode === 'centerX') { const cx = centerXOf(targetBoundsValue); next = [bounds[0], cx - width / 2, bounds[2], cx + width / 2]; }
                else if (args.mode === 'centerY') { const cy = centerYOf(targetBoundsValue); next = [cy - height / 2, bounds[1], cy + height / 2, bounds[3]]; }
                else throw new Error('Unsupported align mode');
                setBoundsRaw(item, next);
            }
            return { success:true, mode:args.mode, alignTo:args.alignTo, before, after:items.map(itemSnapshot), pageIdentity:{ derivativeId:args.derivativeId || null, pageIndex:args.resolvedPageIndex || args.pageIndex || null, pageId:args.resolvedPageId || null, resolvedBy:args.resolvedBy || (args.pageIndex != null ? 'pageIndex' : null), warnings:args.pageIdentityWarnings || [] } };
        `, 'align_items');
            return result;
        })(), 'align_items');
    }

    static distribute_items(args = {}) {
        return response((async () => {
            const target = args.derivativeId ? await this.resolveDerivativeTarget({ derivativeId: args.derivativeId }) : (args.pageIndex != null ? { pageIndex: args.pageIndex, pageId: null, resolvedBy: 'pageIndex', warnings: [] } : null);
            const payload = { ...args, pageIndex: target?.pageIndex ?? args.pageIndex ?? null, resolvedPageIndex: target?.pageIndex ?? args.pageIndex ?? null, resolvedPageId: target?.pageId || null, resolvedBy: target?.resolvedBy || null, pageIdentityWarnings: target?.warnings || [] };
            const result = await runGuarded(`${jsHelpers()} const args=${q(payload)};
            const items = resolveItems(args);
            if (items.length < 2) throw new Error('At least two objects are required');
            const axis = args.axis;
            const mode = args.mode || 'centers';
            const before = items.map(itemSnapshot);
            const sorted = items.slice().sort((a,b)=> axis === 'horizontal' ? centerXOf(a.geometricBounds) - centerXOf(b.geometricBounds) : centerYOf(a.geometricBounds) - centerYOf(b.geometricBounds));
            const fixedSpacing = args.fixedSpacing != null ? toPt(Number(args.fixedSpacing), args.unit || 'pt') : null;
            const container = (()=>{
                if (args.within === 'page') return pageBounds(args.pageIndex != null ? args.pageIndex : pageIndexOf(sorted[0]));
                if (args.within === 'spread') return spreadBoundsForPage(args.pageIndex != null ? args.pageIndex : pageIndexOf(sorted[0]));
                const bounds = sorted.map((it)=>clone(it.geometricBounds));
                return [Math.min.apply(null,bounds.map((b)=>b[0])), Math.min.apply(null,bounds.map((b)=>b[1])), Math.max.apply(null,bounds.map((b)=>b[2])), Math.max.apply(null,bounds.map((b)=>b[3]))];
            })();
            if (mode === 'gaps') {
                let cursor = axis === 'horizontal' ? container[1] : container[0];
                for (const item of sorted) {
                    const b = clone(item.geometricBounds); const width = widthOf(b); const height = heightOf(b);
                    const gap = fixedSpacing != null ? fixedSpacing : ((axis === 'horizontal' ? widthOf(container) : heightOf(container)) - sorted.reduce((sum, it)=>sum + (axis === 'horizontal' ? widthOf(it.geometricBounds) : heightOf(it.geometricBounds)), 0)) / (sorted.length - 1);
                    const next = axis === 'horizontal' ? [b[0], cursor, b[0] + height, cursor + width] : [cursor, b[1], cursor + height, b[1] + width];
                    setBoundsRaw(item, next);
                    cursor += (axis === 'horizontal' ? width : height) + gap;
                }
            } else {
                const first = sorted[0].geometricBounds;
                const last = sorted[sorted.length - 1].geometricBounds;
                const start = axis === 'horizontal' ? centerXOf(first) : centerYOf(first);
                const end = axis === 'horizontal' ? centerXOf(last) : centerYOf(last);
                const step = fixedSpacing != null ? fixedSpacing : (end - start) / (sorted.length - 1);
                sorted.forEach((item, index)=>{
                    const b = clone(item.geometricBounds); const width = widthOf(b); const height = heightOf(b); const targetCenter = fixedSpacing != null ? start + step * index : (index === 0 ? start : index === sorted.length - 1 ? end : start + step * index);
                    const next = axis === 'horizontal' ? [b[0], targetCenter - width / 2, b[2], targetCenter + width / 2] : [targetCenter - height / 2, b[1], targetCenter + height / 2, b[3]];
                    setBoundsRaw(item, next);
                });
            }
            return { success:true, axis, mode, before, after:items.map(itemSnapshot), pageIdentity:{ derivativeId:args.derivativeId || null, pageIndex:args.resolvedPageIndex || args.pageIndex || null, pageId:args.resolvedPageId || null, resolvedBy:args.resolvedBy || (args.pageIndex != null ? 'pageIndex' : null), warnings:args.pageIdentityWarnings || [] } };
        `, 'distribute_items');
            return result;
        })(), 'distribute_items');
    }

    static replace_image_in_frame(args = {}) {
        return response((async () => {
            const manifest = loadWorkspace();
            const imagePath = resolveWorkspaceImagePath(args.imagePath, manifest);
            return runGuarded(`${jsHelpers()} const args=${q({ ...args, imagePath })};
                const it = resolveItem(args);
                const oldBounds = clone(safe(()=>it.geometricBounds));
                it.place(args.imagePath, false);
                applyFitMode(it, args.fitMode || 'proportionally');
                if (args.preserveFrame !== false) setBoundsRaw(it, oldBounds);
                return { success:true, objectId:safe(()=>it.id), name:safe(()=>it.name), bounds:clone(safe(()=>it.geometricBounds)), link:linkInfo(it) };
            `);
        })(), 'replace_image_in_frame');
    }

    static diagnose_visual_mismatch(args = {}) {
        return response((async () => {
            const manifest = loadWorkspace();
            const resolved = args.derivativeId
                ? unwrapToolResult(await this.resolve_derivative_page({ derivativeId: args.derivativeId }))
                : unwrapToolResult(await this.resolve_derivative_page({ pageIndex: args.pageIndex }));
            const derivative = args.derivativeId ? this.resolveDerivativeRecord(manifest, { derivativeId: args.derivativeId }) : null;
            const mismatch = await runGuarded(`${jsHelpers()} const args=${q({
                pageIndex: resolved.pageIndex,
                includeHidden: args.includeHidden !== false,
                minPageCoverageRatio: args.minPageCoverageRatio ?? 0.5,
                limit: args.limit ?? 200
            })};
                const page = pageByIndex(args.pageIndex);
                const pb = clone(page.bounds);
                const pageArea = Math.max(1, rectArea(pb));
                const rawItems = arr(page.allPageItems || page.pageItems, (item)=>item);
                const layersByName = {};
                const suspects = [];
                const likelyCauses = [];
                let visibleItemCount = 0;
                let hiddenItemCount = 0;
                let offPageCount = 0;

                function pushCause(code){
                    if (likelyCauses.indexOf(code) === -1) likelyCauses.push(code);
                }
                function swatchName(value){ return safe(()=>value && value.name, null); }
                function boolOrNull(fn){ const value = safe(fn, null); return value == null ? null : !!value; }
                function textSummary(item){
                    if (!/TextFrame/i.test(String(safe(()=>item.constructor.name,'')))) return null;
                    const excerpt = String(safe(()=>item.contents,'') || '').slice(0, 120);
                    return { excerpt, overset: !!safe(()=>item.overflows, false) };
                }
                function itemVisibleState(item, layer){
                    const layerVisible = boolOrNull(()=>layer.visible);
                    const visible = boolOrNull(()=>item.visible);
                    return visible !== false && layerVisible !== false;
                }
                function severityFor(item){
                    const visible = item.visible !== false;
                    if (visible && item.pageCoverageRatio >= args.minPageCoverageRatio && item.hasFill) return 100;
                    if (visible && item.pageCoverageRatio >= 0.25) return 80;
                    if (item.text && (item.text.overset || !item.text.excerpt.trim())) return 70;
                    if (item.pageCoverageRatio === 0) return 60;
                    if (item.layerVisible === false || item.visible === false || item.nonprinting === true) return 50;
                    if (item.layerLocked === true || item.locked === true) return 40;
                    return 10;
                }
                function reasonFor(item){
                    if (item.visible && item.hasFill && item.pageCoverageRatio >= args.minPageCoverageRatio) return 'Visible filled object covers most of the target page and may occlude lower-layer content.';
                    if (item.layerVisible === false) return 'Object sits on a hidden layer.';
                    if (item.layerLocked === true) return 'Object sits on a locked layer that may block repair.';
                    if (item.visible === false || item.nonprinting === true) return 'Object is hidden or nonprinting.';
                    if (item.text && item.text.overset) return 'Text frame is overset and may not render expected copy.';
                    if (item.text && !item.text.excerpt.trim()) return 'Text frame is empty.';
                    if (item.pageCoverageRatio === 0) return 'Object is entirely off the target page.';
                    if (item.pageCoverageRatio < 0.1) return 'Object is mostly outside the target page.';
                    return 'Structured object exists but needs visual review.';
                }

                for (let index = 0; index < rawItems.length; index++) {
                    if (suspects.length >= args.limit) break;
                    const item = rawItems[index];
                    const layer = safe(()=>item.itemLayer, null);
                    const layerName = safe(()=>layer && layer.name, null) || 'Unassigned';
                    if (!layersByName[layerName]) {
                        layersByName[layerName] = {
                            name: layerName,
                            visible: boolOrNull(()=>layer.visible),
                            locked: boolOrNull(()=>layer.locked),
                            printable: boolOrNull(()=>layer.printable),
                            itemCountOnPage: 0
                        };
                    }
                    layersByName[layerName].itemCountOnPage += 1;

                    const bounds = clone(safe(()=>item.geometricBounds, null));
                    if (!Array.isArray(bounds) || bounds.length !== 4) continue;
                    const intersection = intersectBounds(bounds, pb);
                    const itemArea = Math.max(1, rectArea(bounds));
                    const visible = itemVisibleState(item, layer);
                    if (visible) visibleItemCount += 1;
                    else hiddenItemCount += 1;
                    const insideArea = intersection ? rectArea(intersection) : 0;
                    const pageCoverageRatio = intersection ? Number((insideArea / pageArea).toFixed(4)) : 0;
                    const outsidePageRatio = Number((Math.max(0, 1 - (insideArea / itemArea))).toFixed(4));
                    if (!intersection) offPageCount += 1;
                    if (args.includeHidden !== true && !visible) continue;

                    const info = {
                        objectId: safe(()=>item.id, null),
                        name: safe(()=>item.name, null),
                        type: safe(()=>item.constructor.name, null),
                        bounds,
                        layerName,
                        layerVisible: boolOrNull(()=>layer.visible),
                        layerLocked: boolOrNull(()=>layer.locked),
                        layerPrintable: boolOrNull(()=>layer.printable),
                        visible: boolOrNull(()=>item.visible),
                        locked: boolOrNull(()=>item.locked),
                        nonprinting: boolOrNull(()=>item.nonprinting),
                        fillSwatch: swatchName(safe(()=>item.fillColor, null)),
                        strokeSwatch: swatchName(safe(()=>item.strokeColor, null)),
                        label: readLabel(item),
                        text: textSummary(item),
                        pageCoverageRatio,
                        outsidePageRatio,
                        offPage: !intersection,
                        hasFill: !!swatchName(safe(()=>item.fillColor, null)) && !/None/i.test(String(swatchName(safe(()=>item.fillColor, null)) || ''))
                    };

                    if (info.visible && info.hasFill && info.pageCoverageRatio >= args.minPageCoverageRatio) pushCause('full_page_occluder');
                    if (info.layerVisible === false) pushCause('hidden_layer');
                    if (info.layerLocked === true) pushCause('locked_layer');
                    if (info.visible === false || info.nonprinting === true) pushCause('nonprinting_or_hidden_item');
                    if (info.offPage) pushCause('off_page_objects');
                    if (info.text && (info.text.overset || !info.text.excerpt.trim())) pushCause('overset_or_empty_text');

                    info.reason = reasonFor(info);
                    info.severity = severityFor(info);
                    suspects.push(info);
                }

                suspects.sort((a, b) => b.severity - a.severity || b.pageCoverageRatio - a.pageCoverageRatio || (a.objectId || 0) - (b.objectId || 0));
                const topSuspects = suspects.slice(0, Math.min(args.limit, 25)).map(({ severity, hasFill, offPage, ...rest }) => rest);
                if (!visibleItemCount) pushCause('no_visible_items');
                if (offPageCount && offPageCount === rawItems.length) pushCause('off_page_objects');
                return {
                    success: true,
                    pageIndex: args.pageIndex,
                    pageBounds: pb,
                    summary: {
                        visibleItemCount,
                        hiddenItemCount,
                        likelyMismatch: likelyCauses.length > 0
                    },
                    likelyCauses,
                    topSuspects,
                    layers: Object.values(layersByName)
                };
            `);
            const likelyCauses = [...(mismatch.likelyCauses || [])];
            if (derivative && derivative.pageIndex != null && derivative.pageIndex !== resolved.pageIndex && !likelyCauses.includes('export_page_mismatch')) {
                likelyCauses.push('export_page_mismatch');
            }
            const recommendedNextStep = likelyCauses.includes('full_page_occluder')
                ? 'Use set_item_layer or send_to_back on the suspected full-page object, then export a checkpoint preview.'
                : likelyCauses.includes('hidden_layer') || likelyCauses.includes('locked_layer')
                    ? 'Repair the affected layer visibility or placement explicitly, then export a checkpoint preview.'
                    : 'Compare structured inspection against a checkpoint preview again before making content edits.';
            return {
                success: true,
                derivativeId: args.derivativeId || derivative?.derivativeId || null,
                pageIndex: resolved.pageIndex,
                pageBounds: mismatch.pageBounds,
                summary: mismatch.summary,
                likelyCauses,
                topSuspects: mismatch.topSuspects || [],
                layers: mismatch.layers || [],
                recommendedNextStep
            };
        })(), 'diagnose_visual_mismatch');
    }

    static set_item_layer(args = {}) {
        return response(runGuarded(`${jsHelpers()} const args=${q(args)};
            const targetName = String(args.layerName || '').trim();
            if (!targetName) throw new Error('layerName is required');
            const ids = Array.isArray(args.objectIds) ? args.objectIds : [];
            if (!ids.length) throw new Error('objectIds are required');
            const resolvedItems = ids.map((id) => itemById(id));
            let targetLayer = safe(()=>doc.layers.itemByName(targetName), null);
            let createdLayer = false;
            if (!targetLayer || targetLayer.isValid === false) {
                if (args.createIfMissing === false) throw new Error('Target layer not found and createIfMissing=false');
                targetLayer = doc.layers.add({ name: targetName });
                createdLayer = true;
            }
            const layerWarnings = [];
            if (args.makeLayerVisible !== false && safe(()=>targetLayer.visible, true) === false) {
                targetLayer.visible = true;
                layerWarnings.push('Made target layer visible');
            }
            if (args.unlockLayer !== false && safe(()=>targetLayer.locked, false) === true) {
                targetLayer.locked = false;
                layerWarnings.push('Unlocked target layer');
            }
            const items = [];
            const overallWarnings = [];
            for (const item of resolvedItems) {
                const before = {
                    layerName: safe(()=>item.itemLayer && item.itemLayer.name, null),
                    bounds: clone(safe(()=>item.geometricBounds, null))
                };
                item.itemLayer = targetLayer;
                const actions = ['setLayer'];
                if (args.zOrder === 'front') {
                    item.bringToFront();
                    actions.push('bringToFront');
                } else if (args.zOrder === 'back') {
                    item.sendToBack();
                    actions.push('sendToBack');
                }
                const record = {
                    objectId: safe(()=>item.id),
                    name: safe(()=>item.name),
                    actions
                };
                if (args.returnBeforeAfter === false) {
                    record.layerName = safe(()=>item.itemLayer && item.itemLayer.name, null);
                    record.bounds = clone(safe(()=>item.geometricBounds, null));
                } else {
                    record.before = before;
                    record.after = {
                        layerName: safe(()=>item.itemLayer && item.itemLayer.name, null),
                        bounds: clone(safe(()=>item.geometricBounds, null))
                    };
                }
                if (layerWarnings.length) record.warnings = layerWarnings.slice();
                items.push(record);
            }
            overallWarnings.push(...layerWarnings);
            return {
                success: true,
                layerName: safe(()=>targetLayer.name, targetName),
                createdLayer,
                zOrder: args.zOrder || 'unchanged',
                items,
                warnings: overallWarnings
            };
        `), 'set_item_layer');
    }

    static update_text_slot(args = {}) {
        return response((async () => {
            if (args.text == null) throw new Error('text is required');
            if (args.fit === true) {
                throw new Error('update_text_slot no longer supports fit=true; call fit_text_to_frame separately after inspecting the updated text.');
            }
            const updated = await runGuarded(`${jsHelpers()} const args=${q(args)};
                const it = resolveItem(args);
                const result = replaceTextFrameContentsSafely(it, args.text, { preserveStyle: args.preserveStyle, textReplacePolicy: args.textReplacePolicy, expectedOldTextExcerpt: args.expectedOldTextExcerpt });
                return { ...result, objectId:safe(()=>it.id), name:safe(()=>it.name), type:safe(()=>it.constructor.name), label:readLabel(it) };
            `);
            return updated;
        })(), 'update_text_slot');
    }

    static move_resize_items(args = {}) {
        return response((async () => {
            const target = args.derivativeId ? await this.resolveDerivativeTarget({ derivativeId: args.derivativeId }) : null;
            const payload = { ...args, resolvedPageIndex: target?.pageIndex ?? args.pageIndex ?? null, resolvedPageId: target?.pageId || null, resolvedBy: target?.resolvedBy || null, pageIdentityWarnings: target?.warnings || [] };
            const result = await runGuarded(`${jsHelpers()} const args=${q(payload)};
            const items = resolveItems(args);
            const before = items.map(itemSnapshot);
            const offset = Array.isArray(args.offset) ? [toPt(Number(args.offset[0] || 0), args.unit || 'pt'), toPt(Number(args.offset[1] || 0), args.unit || 'pt')] : [0,0];
            const scale = args.scale == null ? 1 : Number(args.scale);
            const targetPageIndex = args.pageIndex != null ? args.pageIndex : (args.resolvedPageIndex != null ? args.resolvedPageIndex : pageIndexOf(items[0]));
            if (args.targetBox && (args.coordinateSpace || 'page') === 'page' && targetPageIndex == null) throw new Error('pageIndex is required when target items have no parentPage');
            const resolvedTarget = args.targetBox ? resolveBoundsForPage({ ...args, bounds: args.targetBox }, targetPageIndex) : null;
            const targetBox = resolvedTarget ? resolvedTarget.documentBounds : null;
            const sourceBox = (()=>{ const bounds = items.map((it)=>clone(it.geometricBounds)); return [Math.min.apply(null,bounds.map((b)=>b[0])), Math.min.apply(null,bounds.map((b)=>b[1])), Math.max.apply(null,bounds.map((b)=>b[2])), Math.max.apply(null,bounds.map((b)=>b[3]))]; })();
            for (const item of items) {
                if (args.resolvedPageIndex != null && args.derivativeId && args.allowCrossPageEdit !== true) {
                    const itemPageIndex = pageIndexOf(item);
                    if (itemPageIndex != null && itemPageIndex !== args.resolvedPageIndex) throw new Error('Target item is not on resolved derivative page; pass allowCrossPageEdit=true to override');
                }
                const bounds = clone(item.geometricBounds); let next = clone(bounds);
                if (targetBox && args.preserveRelativePositions) {
                    const relTop = (bounds[0] - sourceBox[0]) / Math.max(1, heightOf(sourceBox));
                    const relLeft = (bounds[1] - sourceBox[1]) / Math.max(1, widthOf(sourceBox));
                    const relHeight = heightOf(bounds) / Math.max(1, heightOf(sourceBox));
                    const relWidth = widthOf(bounds) / Math.max(1, widthOf(sourceBox));
                    next = [targetBox[0] + relTop * heightOf(targetBox), targetBox[1] + relLeft * widthOf(targetBox), targetBox[0] + (relTop + relHeight) * heightOf(targetBox), targetBox[1] + (relLeft + relWidth) * widthOf(targetBox)];
                } else {
                    const top = bounds[0] + offset[0], left = bounds[1] + offset[1], width = widthOf(bounds) * scale, height = heightOf(bounds) * scale;
                    next = [top, left, top + height, left + width];
                }
                const applied = setBoundsRaw(item, next);
                const pageIdx = args.pageIndex != null ? args.pageIndex : pageIndexOf(item);
                if (pageIdx != null) validateBoundsOnPage(applied, pageBounds(pageIdx), args);
            }
            return { success:true, before, after:items.map(itemSnapshot), pageBounds:targetPageIndex != null ? pageBounds(targetPageIndex) : null, coordinateSpace:args.coordinateSpace || 'page', pageIdentity:{ derivativeId:args.derivativeId || null, pageIndex:args.resolvedPageIndex || args.pageIndex || null, pageId:args.resolvedPageId || null, resolvedBy:args.resolvedBy || (args.pageIndex != null ? 'pageIndex' : null), warnings:args.pageIdentityWarnings || [] } };
        `, 'move_resize_items');
            return result;
        })(), 'move_resize_items');
    }

    static create_vector_motif(args = {}) {
        return response((async () => {
            const target = args.derivativeId ? await this.resolveDerivativeTarget({ derivativeId: args.derivativeId }) : null;
            const resolvedPageIndex = target?.pageIndex ?? args.pageIndex;
            const payload = { ...args, pageIndex: resolvedPageIndex, resolvedPageIndex, resolvedPageId: target?.pageId || null, resolvedBy: target?.resolvedBy || (args.pageIndex != null ? 'pageIndex' : null), pageIdentityWarnings: target?.warnings || [] };
            const result = await runGuarded(`${jsHelpers()} const args=${q(payload)};
            if (!args.motifId) throw new Error('motifId is required');
            if (args.pageIndex == null) throw new Error('pageIndex or derivativeId is required');
            const page = pageByIndex(args.pageIndex);
            const created = [];
            for (const shape of (args.shapes || [])) {
                let item;
                const layer = writableLayer(shape.layerName || args.layerName || 'AGENT_WORK');
                if (shape.shapeType === 'rectangle' || shape.shapeType === 'oval' || shape.shapeType === 'polygon') {
                    const resolved = resolveBoundsForPage({ ...args, ...shape, pageIndex: args.pageIndex, bounds: shape.bounds, coordinateSpace: shape.coordinateSpace || args.coordinateSpace || 'page' }, args.pageIndex);
                    const boundsValidation = validateBoundsOnPage(resolved.documentBounds, resolved.pageBounds, { ...args, ...shape });
                    item = (shape.shapeType === 'oval' ? page.ovals : shape.shapeType === 'polygon' ? page.polygons : page.rectangles).add();
                    item.itemLayer = layer;
                    item.geometricBounds = resolved.documentBounds;
                    item.__boundsValidation = boundsValidation;
                    item.__localBounds = resolved.localBounds;
                    item.__pageBounds = resolved.pageBounds;
                    item.__documentBounds = resolved.documentBounds;
                }
                else if (shape.shapeType === 'line') { const start = resolvePointForPage({ ...args, ...shape, pageIndex: args.pageIndex, coordinateSpace: shape.coordinateSpace || args.coordinateSpace || 'page' }, shape.start || (shape.points || [])[0] || [0,0], args.pageIndex); const end = resolvePointForPage({ ...args, ...shape, pageIndex: args.pageIndex, coordinateSpace: shape.coordinateSpace || args.coordinateSpace || 'page' }, shape.end || (shape.points || [])[1] || [10,10], args.pageIndex); item = page.graphicLines.add(); item.itemLayer = layer; item.paths.item(0).entirePath = [start.documentPoint, end.documentPoint]; item.__pageBounds = start.pageBounds; }
                else throw new Error('Unsupported shapeType');
                applyBasics(item, shape);
                const label = Object.assign({ derivativeId:args.derivativeId, motifId:args.motifId, source:'agent_created', editable:true }, args.label || {});
                writeLabel(item, label);
                created.push(item);
            }
            let groupId = null;
            if (args.group && created.length > 1) {
                const group = page.groups.add(created);
                writeLabel(group, Object.assign({ derivativeId:args.derivativeId, motifId:args.motifId, source:'agent_created', editable:true }, args.label || {}));
                groupId = safe(()=>group.id);
            }
            return { success:true, motifId:args.motifId, objectIds:created.map((item)=>safe(()=>item.id)), objects:created.map((item)=>({ objectId:safe(()=>item.id), shapeType:safe(()=>item.constructor.name), localBounds:safe(()=>item.__localBounds, null), documentBounds:safe(()=>item.__documentBounds, safe(()=>item.geometricBounds, null)), pageBounds:safe(()=>item.__pageBounds, null), boundsValidation:safe(()=>item.__boundsValidation, null) })), pageIdentity:{ derivativeId:args.derivativeId || null, pageIndex:args.pageIndex ?? null, resolvedPageIndex:args.pageIndex ?? null, resolvedBy:args.resolvedBy || (args.pageIndex != null ? 'pageIndex' : 'derivativeId'), warnings:args.pageIdentityWarnings || [] }, ...(groupId ? { groupId } : {}) };
        `, 'create_vector_motif');
            return result;
        })(), 'create_vector_motif');
    }

    static inspect_layout_grid(args = {}) {
        return response((async () => {
            const items = await this.uxpTool('inspect_page_items_v2', { pageIndex: args.pageIndex ?? 0, includeHidden: args.includeHidden === true, detailLevel: 'summary', limit: args.limit ?? 500, includeTextExcerpt: false, includeTextMetadata: false, includeImageMetadata: false, includePathPoints: false, includeParentItems: false });
            const bundle = await this.uxpTool('inspect_document_bundle', { includeHidden: args.includeHidden === true, includeTextExcerpt: false, allowHeavyInspection: false, includePageItems: false, includeParentPageItems: false, includeStyles: false, includeSwatches: false, includeLayers: false, includeParents: false, includeItemCounts: false, limit: 1, offset: 0 });
            const page = (bundle.pages || []).find((entry) => entry.index === (args.pageIndex ?? 0)) || {};
            const visibleItems = (items.items || []).filter((item) => args.includeHidden || item.visible !== false);
            const xs = visibleItems.flatMap((item) => item.bounds ? [item.bounds[1], item.bounds[3]] : []);
            const ys = visibleItems.flatMap((item) => item.bounds ? [item.bounds[0], item.bounds[2]] : []);
            const widths = visibleItems.map((item) => item.bounds ? item.bounds[3] - item.bounds[1] : null).filter(Number.isFinite);
            const heights = visibleItems.map((item) => item.bounds ? item.bounds[2] - item.bounds[0] : null).filter(Number.isFinite);
            const round = (value) => Math.round(value * 100) / 100;
            const uniqueTop = (values) => [...new Set(values.map(round))].sort((a, b) => a - b).slice(0, 16);
            const spacingRhythm = uniqueTop([...xs, ...ys].slice(1).map((value, index, arr) => index ? value - arr[index - 1] : null).filter((value) => Number.isFinite(value) && value > 0));
            return { success:true, source:'derived_from_page_item_bounds', pageIndex: args.pageIndex ?? 0, margins: page.marginPreferences || null, commonX: uniqueTop(xs), commonY: uniqueTop(ys), commonWidths: uniqueTop(widths), commonHeights: uniqueTop(heights), spacingRhythm, likelyGrid: { columns: uniqueTop(xs).length, rows: uniqueTop(ys).length, confidence: visibleItems.length >= 3 ? 0.5 : 0.2, evidenceObjectIds: visibleItems.slice(0, 12).map((item) => item.objectId) }, warnings:['Heuristic only; derived from page item bounds, not native grid metadata'] };
        })(), 'inspect_layout_grid');
    }

    static analyze_design_system(args = {}) {
        return response((async () => {
            const hardMaxPages = 5;
            const normalizeInt = (value, fallback, min, max) => {
                const parsed = Number(value);
                if (!Number.isFinite(parsed)) return fallback;
                return Math.min(max, Math.max(min, Math.trunc(parsed)));
            };
            const roundPoint = (value) => Math.round(Number(value) * 2) / 2;
            const keyPoint = (value) => roundPoint(value).toFixed(1);
            const formatBounds = (bounds) => Array.isArray(bounds) ? bounds.map((value) => Math.round(Number(value) * 100) / 100) : null;
            const countBy = (map, key, payload = {}) => {
                const existing = map.get(key) || { key, count: 0, evidenceObjectIds: [], ...payload };
                existing.count += 1;
                if (payload.objectId != null && !existing.evidenceObjectIds.includes(payload.objectId)) existing.evidenceObjectIds.push(payload.objectId);
                map.set(key, existing);
                return existing;
            };
            const requestedPageIndex = args.pageIndex != null ? Number(args.pageIndex) : null;
            const requestedPageIndexes = Array.isArray(args.pageIndexes) && args.pageIndexes.length ? args.pageIndexes.map((value) => {
                const parsed = Number(value);
                if (!Number.isFinite(parsed) || parsed < 0) throw new Error('pageIndexes must contain non-negative integers');
                return Math.trunc(parsed);
            }) : (requestedPageIndex != null ? [Math.trunc(requestedPageIndex)] : [0]);
            if (requestedPageIndexes.length > 1 && args.allowHeavyInspection !== true) {
                throw new Error('multi-page design-system analysis requires allowHeavyInspection=true');
            }
            const maxPages = normalizeInt(args.maxPages ?? 1, 1, 1, hardMaxPages);
            const maxItems = normalizeInt(args.maxItems ?? args.limit ?? 100, 100, 1, 500);
            const defaultedPageIndex = args.pageIndex == null && !Array.isArray(args.pageIndexes);
            const warnings = [];
            if (defaultedPageIndex) warnings.push('Defaulted to pageIndex 0 for bounded design-system analysis.');
            if (args.includeHidden === false || args.includeHidden == null) warnings.push('Hidden/nonprinting items are excluded by default.');
            if (args.includeTextExcerpt !== true) warnings.push('Text excerpts are omitted by default.');
            if (args.includeImageMetadata !== true) warnings.push('Image metadata is omitted by default.');
            if (args.includePathPoints !== true) warnings.push('Path points are omitted by default.');
            if (args.allowHeavyInspection !== true) warnings.push('Multi-page or document-wide analysis requires allowHeavyInspection=true.');
            const pageBudgetLimit = Math.min(maxPages, maxItems);
            const analyzedPageIndexes = requestedPageIndexes.slice(0, pageBudgetLimit);
            let truncated = analyzedPageIndexes.length < requestedPageIndexes.length;
            if (truncated) {
                warnings.push(`Requested page scope was truncated to ${analyzedPageIndexes.length} page(s) by maxPages/maxItems.`);
            }
            const rawDetailLevel = args.detailLevel || 'summary';
            let resolvedDetailLevel = rawDetailLevel;
            const needsStandard = args.includeTextMetadata !== false || args.includeImageMetadata === true;
            if (args.includePathPoints === true) {
                if (args.allowHeavyInspection !== true) throw new Error('includePathPoints requires allowHeavyInspection=true');
                if (resolvedDetailLevel !== 'deep') {
                    resolvedDetailLevel = 'deep';
                    warnings.push('detailLevel was upgraded to deep to collect path points.');
                }
            } else if (resolvedDetailLevel === 'summary' && needsStandard) {
                resolvedDetailLevel = 'standard';
                warnings.push('detailLevel was upgraded to standard to collect bounded text or image evidence.');
            }
            const totalPageBudget = analyzedPageIndexes.length || 1;
            const basePageBudget = Math.max(1, Math.floor(maxItems / totalPageBudget));
            const pageBudgets = analyzedPageIndexes.map((_, index) => basePageBudget + (index < (maxItems % totalPageBudget) ? 1 : 0));
            const bundle = await this.uxpTool('inspect_document_bundle', {
                includeHidden: args.includeHidden === true,
                includeTextExcerpt: false,
                allowHeavyInspection: args.allowHeavyInspection === true,
                includePageItems: false,
                includeParentPageItems: false,
                includeStyles: args.includeStyles !== false,
                includeSwatches: args.includeSwatches !== false,
                includeLayers: true,
                includeParents: false,
                includeItemCounts: false,
                limit: maxItems,
                offset: 0
            });
            const pageResults = [];
            const gridResults = [];
            for (let index = 0; index < analyzedPageIndexes.length; index += 1) {
                const pageIndex = analyzedPageIndexes[index];
                const inspected = await this.uxpTool('inspect_page_items_v2', {
                    pageIndex,
                    includeHidden: args.includeHidden === true,
                    includeParentItems: false,
                    limit: pageBudgets[index],
                    offset: 0,
                    includeImageMetadata: args.includeImageMetadata === true,
                    includeTextMetadata: args.includeTextMetadata !== false,
                    includeTextExcerpt: args.includeTextExcerpt === true,
                    includePathPoints: args.includePathPoints === true && args.allowHeavyInspection === true,
                    detailLevel: resolvedDetailLevel
                });
                const grid = args.includeGrid ? unwrapToolResult(await this.inspect_layout_grid({ pageIndex, includeHidden: args.includeHidden === true, limit: pageBudgets[index] })) : null;
                pageResults.push({ pageIndex, inspected, grid });
                if (grid) gridResults.push({ pageIndex, grid });
            }

            const itemEntries = pageResults.flatMap((pageResult) => (pageResult.inspected.items || []).map((item) => ({ ...item, pageIndex: pageResult.pageIndex })));
            const allVisibleItems = itemEntries.filter((item) => args.includeHidden === true || item.visible !== false);
            const pageLookup = new Map((bundle.pages || []).map((page) => [page.index, page]));
            const stylePages = Array.isArray(bundle.pages) ? bundle.pages : [];
            const itemCountByPage = {};
            const totalInspectedItems = pageResults.reduce((sum, pageResult, index) => {
                const count = pageResult.inspected.items?.length || 0;
                itemCountByPage[pageResult.pageIndex] = {
                    returned: count,
                    totalMatched: pageResult.inspected.pagination?.totalMatched ?? count,
                    hasMore: pageResult.inspected.pagination?.hasMore === true,
                    limit: pageResult.inspected.pagination?.limit ?? pageBudgets[index],
                    truncated: pageResult.inspected.pagination?.hasMore === true
                };
                return sum + count;
            }, 0);
            if (pageResults.some((pageResult) => pageResult.inspected.pagination?.hasMore === true)) truncated = true;
            const totalSkippedOrTruncatedItems = pageResults.some((pageResult) => pageResult.inspected.pagination?.hasMore === true)
                ? null
                : pageResults.reduce((sum, pageResult) => sum + Math.max(0, (pageResult.inspected.pagination?.totalMatched || 0) - (pageResult.inspected.pagination?.returned || 0)), 0);
            const fontFamilies = new Map();
            const fontStyles = new Map();
            const paragraphStyles = new Map();
            const characterStyles = new Map();
            const swatchUsage = new Map();
            const swatchEvidence = new Map();
            const typeSizes = new Map();
            const geometryCounts = new Map();
            const recurringGeometry = [];
            const motifCandidates = [];
            const imageRoles = [];
            const colorRoles = [];
            const spacingGaps = new Map();
            const spacingRhythm = new Map();
            const pageZones = [];
            const marginHints = [];
            const textItemCount = allVisibleItems.filter((item) => /TextFrame/i.test(item.type)).length;
            const imageItemCount = allVisibleItems.filter((item) => item.image?.hasPlacedGraphic === true).length;
            const pageBoundsByPage = new Map(stylePages.map((page) => [page.index, page.bounds]));
            const captureSwatch = (role, swatchName, objectId, extra = {}) => {
                if (!swatchName) return;
                const key = `${role}:${swatchName}`;
                const existing = swatchUsage.get(key) || { role, swatchName, count: 0, evidenceObjectIds: [], ...extra };
                existing.count += 1;
                if (objectId != null && !existing.evidenceObjectIds.includes(objectId)) existing.evidenceObjectIds.push(objectId);
                swatchUsage.set(key, existing);
                if (objectId != null) swatchEvidence.set(objectId, swatchName);
            };
            const isLargeItem = (item) => {
                const pageBounds = pageBoundsByPage.get(item.pageIndex) || null;
                const bounds = item.bounds || item.geometricBounds;
                if (!pageBounds || !Array.isArray(bounds)) return false;
                const pageArea = Math.max(1, (pageBounds[3] - pageBounds[1]) * (pageBounds[2] - pageBounds[0]));
                const itemArea = Math.max(0, (bounds[3] - bounds[1]) * (bounds[2] - bounds[0]));
                return itemArea / pageArea >= 0.75;
            };
            for (const item of allVisibleItems) {
                const bounds = item.bounds || item.geometricBounds || null;
                if (item.text?.fontFamily) {
                    const familyKey = item.text.fontFamily;
                    const family = fontFamilies.get(familyKey) || { name: familyKey, count: 0, styles: [], evidenceObjectIds: [] };
                    family.count += 1;
                    if (item.objectId != null && !family.evidenceObjectIds.includes(item.objectId)) family.evidenceObjectIds.push(item.objectId);
                    if (item.text.fontStyle && !family.styles.includes(item.text.fontStyle)) family.styles.push(item.text.fontStyle);
                    fontFamilies.set(familyKey, family);
                }
                if (item.text?.fontStyle) {
                    const styleKey = `${item.text.fontFamily || ''}\t${item.text.fontStyle}`;
                    const style = fontStyles.get(styleKey) || { name: styleKey.trim(), count: 0, evidenceObjectIds: [] };
                    style.count += 1;
                    if (item.objectId != null && !style.evidenceObjectIds.includes(item.objectId)) style.evidenceObjectIds.push(item.objectId);
                    fontStyles.set(styleKey, style);
                }
                if (item.text?.paragraphStyle) {
                    const entry = paragraphStyles.get(item.text.paragraphStyle) || { name: item.text.paragraphStyle, count: 0, evidenceObjectIds: [] };
                    entry.count += 1;
                    if (item.objectId != null && !entry.evidenceObjectIds.includes(item.objectId)) entry.evidenceObjectIds.push(item.objectId);
                    paragraphStyles.set(item.text.paragraphStyle, entry);
                }
                if (item.text?.characterStyle) {
                    const entry = characterStyles.get(item.text.characterStyle) || { name: item.text.characterStyle, count: 0, evidenceObjectIds: [] };
                    entry.count += 1;
                    if (item.objectId != null && !entry.evidenceObjectIds.includes(item.objectId)) entry.evidenceObjectIds.push(item.objectId);
                    characterStyles.set(item.text.characterStyle, entry);
                }
                captureSwatch('fill', item.fillColor?.name, item.objectId, { source: 'item_fill' });
                captureSwatch('stroke', item.strokeColor?.name, item.objectId, { source: 'item_stroke' });
                captureSwatch('text', item.text?.fillColor?.name, item.objectId, { source: 'text_fill' });
                captureSwatch('text-stroke', item.text?.strokeColor?.name, item.objectId, { source: 'text_stroke' });
                if (item.text?.pointSize != null) {
                    const sizeKey = keyPoint(item.text.pointSize);
                    const size = typeSizes.get(sizeKey) || { pointSize: roundPoint(item.text.pointSize), count: 0, role: null, evidenceObjectIds: [] };
                    size.count += 1;
                    if (item.objectId != null && !size.evidenceObjectIds.includes(item.objectId)) size.evidenceObjectIds.push(item.objectId);
                    typeSizes.set(sizeKey, size);
                }
                if (bounds) {
                    const key = `${Math.round(bounds[3] - bounds[1])}x${Math.round(bounds[2] - bounds[0])}`;
                    const geometry = geometryCounts.get(key) || { key, count: 0, evidenceObjectIds: [], bounds: formatBounds(bounds) };
                    geometry.count += 1;
                    if (item.objectId != null && !geometry.evidenceObjectIds.includes(item.objectId)) geometry.evidenceObjectIds.push(item.objectId);
                    geometryCounts.set(key, geometry);
                }
                if (item.label?.motifId || item.label?.role === 'motif') {
                    motifCandidates.push({
                        motifId: item.label.motifId || null,
                        role: item.label.role || null,
                        editable: item.label.editable === true,
                        source: item.label.source || 'label',
                        objectId: item.objectId,
                        name: item.name || null,
                        type: item.type || null,
                        pageIndex: item.pageIndex,
                        bounds: formatBounds(bounds),
                        confidence: 0.8
                    });
                }
                if (item.label?.editable === true) {
                    motifCandidates.push({
                        motifId: item.label.motifId || null,
                        role: item.label.role || item.type || 'editable',
                        editable: true,
                        source: item.label.source || 'editable_label',
                        objectId: item.objectId,
                        name: item.name || null,
                        type: item.type || null,
                        pageIndex: item.pageIndex,
                        bounds: formatBounds(bounds),
                        confidence: 0.7
                    });
                }
                if (item.image?.hasPlacedGraphic === true) {
                    const pageBounds = pageBoundsByPage.get(item.pageIndex) || null;
                    const areaRatio = pageBounds && bounds ? Math.max(0, (bounds[3] - bounds[1]) * (bounds[2] - bounds[0])) / Math.max(1, (pageBounds[3] - pageBounds[1]) * (pageBounds[2] - pageBounds[0])) : null;
                    const topPosition = bounds && pageBounds ? (bounds[0] - pageBounds[0]) / Math.max(1, pageBounds[2] - pageBounds[0]) : null;
                    const leftPosition = bounds && pageBounds ? (bounds[1] - pageBounds[1]) / Math.max(1, pageBounds[3] - pageBounds[1]) : null;
                    const labelRole = item.label?.role || null;
                    let role = labelRole;
                    if (!role) {
                        if (areaRatio != null && areaRatio >= 0.75) role = 'background';
                        else if (areaRatio != null && areaRatio >= 0.2 && (topPosition == null || topPosition <= 0.45)) role = 'hero';
                        else if (areaRatio != null && areaRatio <= 0.1 && (topPosition == null || topPosition <= 0.2 || leftPosition <= 0.2)) role = 'logo';
                        else role = 'supporting';
                    }
                    imageRoles.push({
                        role,
                        objectId: item.objectId,
                        name: item.name || null,
                        type: item.type || null,
                        pageIndex: item.pageIndex,
                        bounds: formatBounds(bounds),
                        labelHint: labelRole,
                        linkName: item.image.linkName || null,
                        confidence: role === 'background' || role === 'logo' ? 0.8 : 0.55
                    });
                }
                if (bounds) {
                    const pageBounds = pageBoundsByPage.get(item.pageIndex) || null;
                    const page = pageLookup.get(item.pageIndex) || null;
                    if (pageBounds && !pageZones.some((zone) => zone.pageIndex === item.pageIndex)) {
                        pageZones.push({
                            pageIndex: item.pageIndex,
                            pageBounds: formatBounds(pageBounds),
                            contentBounds: null,
                            marginHints: page?.marginPreferences || null
                        });
                    }
                }
            }
            for (const zone of pageZones) {
                const bounds = allVisibleItems.filter((item) => item.pageIndex === zone.pageIndex && item.bounds).map((item) => item.bounds);
                if (!bounds.length) continue;
                const top = Math.min(...bounds.map((b) => b[0]));
                const left = Math.min(...bounds.map((b) => b[1]));
                const bottom = Math.max(...bounds.map((b) => b[2]));
                const right = Math.max(...bounds.map((b) => b[3]));
                zone.contentBounds = [Math.round(top * 100) / 100, Math.round(left * 100) / 100, Math.round(bottom * 100) / 100, Math.round(right * 100) / 100];
                const pageBounds = zone.pageBounds;
                zone.margins = pageBounds ? {
                    top: Math.round((top - pageBounds[0]) * 100) / 100,
                    left: Math.round((left - pageBounds[1]) * 100) / 100,
                    bottom: Math.round((pageBounds[2] - bottom) * 100) / 100,
                    right: Math.round((pageBounds[3] - right) * 100) / 100
                } : null;
                marginHints.push({
                    pageIndex: zone.pageIndex,
                    margins: zone.margins,
                    confidence: zone.margins ? 0.55 : 0.2,
                    evidenceObjectIds: allVisibleItems.filter((item) => item.pageIndex === zone.pageIndex).slice(0, 6).map((item) => item.objectId)
                });
            }
            const positionsByPage = new Map();
            for (const item of allVisibleItems) {
                if (!item.bounds || isLargeItem(item)) continue;
                const list = positionsByPage.get(item.pageIndex) || [];
                list.push(item);
                positionsByPage.set(item.pageIndex, list);
            }
            for (const [pageIndex, list] of positionsByPage.entries()) {
                const sortedX = [...list].sort((a, b) => (a.bounds[1] - b.bounds[1]) || (a.bounds[3] - b.bounds[3]));
                const sortedY = [...list].sort((a, b) => (a.bounds[0] - b.bounds[0]) || (a.bounds[2] - b.bounds[2]));
                const edgePairs = [];
                for (let i = 1; i < sortedX.length; i += 1) edgePairs.push({ gap: Math.max(0, roundPoint(sortedX[i].bounds[1] - sortedX[i - 1].bounds[3])), evidenceObjectIds: [sortedX[i - 1].objectId, sortedX[i].objectId] });
                for (let i = 1; i < sortedY.length; i += 1) edgePairs.push({ gap: Math.max(0, roundPoint(sortedY[i].bounds[0] - sortedY[i - 1].bounds[2])), evidenceObjectIds: [sortedY[i - 1].objectId, sortedY[i].objectId] });
                for (const pair of edgePairs) {
                    if (!(pair.gap > 0)) continue;
                    const key = keyPoint(pair.gap);
                    const entry = spacingGaps.get(key) || { value: roundPoint(pair.gap), count: 0, evidenceObjectIds: [] };
                    entry.count += 1;
                    for (const id of pair.evidenceObjectIds) if (id != null && !entry.evidenceObjectIds.includes(id)) entry.evidenceObjectIds.push(id);
                    spacingGaps.set(key, entry);
                }
            }
            const gridHints = [];
            for (const { pageIndex, grid } of gridResults) {
                gridHints.push({
                    pageIndex,
                    commonX: grid.commonX || [],
                    commonY: grid.commonY || [],
                    commonWidths: grid.commonWidths || [],
                    commonHeights: grid.commonHeights || [],
                    spacingRhythm: grid.spacingRhythm || [],
                    likelyGrid: grid.likelyGrid || null,
                    confidence: grid.likelyGrid?.confidence ?? 0.25,
                    evidenceObjectIds: grid.likelyGrid?.evidenceObjectIds || []
                });
            }
            if (!gridHints.length) {
                for (const [pageIndex, list] of positionsByPage.entries()) {
                    const xs = [...new Set(list.flatMap((item) => [item.bounds[1], item.bounds[3]]).map((value) => Math.round(Number(value) * 2) / 2))].sort((a, b) => a - b);
                    const ys = [...new Set(list.flatMap((item) => [item.bounds[0], item.bounds[2]]).map((value) => Math.round(Number(value) * 2) / 2))].sort((a, b) => a - b);
                    const widths = [...new Set(list.map((item) => Math.round((item.bounds[3] - item.bounds[1]) * 2) / 2))].sort((a, b) => a - b);
                    const heights = [...new Set(list.map((item) => Math.round((item.bounds[2] - item.bounds[0]) * 2) / 2))].sort((a, b) => a - b);
                    const rhythm = [...new Set([...xs, ...ys].slice(1).map((value, index, arr) => index ? Math.round((value - arr[index - 1]) * 2) / 2 : null).filter((value) => Number.isFinite(value) && value > 0))].sort((a, b) => a - b);
                    gridHints.push({
                        pageIndex,
                        commonX: xs.slice(0, 16),
                        commonY: ys.slice(0, 16),
                        commonWidths: widths.slice(0, 16),
                        commonHeights: heights.slice(0, 16),
                        spacingRhythm: rhythm.slice(0, 16),
                        likelyGrid: { columns: xs.length, rows: ys.length, confidence: list.length >= 3 ? 0.35 : 0.15, evidenceObjectIds: list.slice(0, 6).map((item) => item.objectId) },
                        confidence: list.length >= 3 ? 0.35 : 0.15,
                        evidenceObjectIds: list.slice(0, 6).map((item) => item.objectId)
                    });
                }
            }
            const gridHintsByPage = new Map(gridHints.map((entry) => [entry.pageIndex, entry]));
            for (const zone of pageZones) {
                const gridHint = gridHintsByPage.get(zone.pageIndex) || null;
                zone.likelyGrid = gridHint?.likelyGrid || null;
                zone.spacingRhythm = gridHint?.spacingRhythm || [];
            }
            const fontUsage = {
                families: [...fontFamilies.values()].sort((a, b) => b.count - a.count).slice(0, 16),
                styles: [...fontStyles.values()].sort((a, b) => b.count - a.count).slice(0, 16),
                paragraphStyles: [...paragraphStyles.values()].sort((a, b) => b.count - a.count).slice(0, 16),
                characterStyles: [...characterStyles.values()].sort((a, b) => b.count - a.count).slice(0, 16)
            };
            const typeScale = [...typeSizes.values()].sort((a, b) => b.count - a.count || b.pointSize - a.pointSize).map((entry, index) => ({
                pointSize: entry.pointSize,
                count: entry.count,
                role: index === 0 ? (entry.pointSize >= 24 ? 'display' : 'heading') : index === 1 ? 'heading' : index === 2 ? 'subheading' : entry.pointSize <= 10 ? 'caption' : 'body',
                evidenceObjectIds: entry.evidenceObjectIds.slice(0, 8),
                confidence: entry.count >= 2 ? 0.7 : 0.45
            }));
            const swatches = [...swatchUsage.values()].sort((a, b) => b.count - a.count).map((entry) => ({ role: entry.role, swatchName: entry.swatchName, count: entry.count, evidenceObjectIds: entry.evidenceObjectIds.slice(0, 8), source: entry.source }));
            const colorRoleSummary = [
                { role: 'text', swatches: swatches.filter((entry) => entry.role === 'text' || entry.role === 'fill').slice(0, 8), confidence: swatches.some((entry) => entry.role === 'text') ? 0.7 : 0.45 },
                { role: 'border', swatches: swatches.filter((entry) => entry.role === 'stroke' || entry.role === 'text-stroke').slice(0, 8), confidence: swatches.some((entry) => entry.role === 'stroke') ? 0.65 : 0.4 },
                { role: 'accent', swatches: swatches.filter((entry) => entry.role === 'fill').slice(0, 8), confidence: swatches.some((entry) => entry.role === 'fill') ? 0.55 : 0.3 },
                { role: 'background', swatches: swatches.filter((entry) => entry.role === 'fill' && allVisibleItems.some((item) => item.objectId && entry.evidenceObjectIds.includes(item.objectId) && isLargeItem(item))).slice(0, 8), confidence: swatches.some((entry) => entry.role === 'fill' && allVisibleItems.some((item) => item.objectId && entry.evidenceObjectIds.includes(item.objectId) && isLargeItem(item))) ? 0.75 : 0.35 }
            ].filter((entry) => entry.swatches.length || entry.confidence >= 0.45);
            const recurringGeometrySummary = [...geometryCounts.values()].filter((entry) => entry.count > 1).slice(0, 24);
            const motifGeometryCandidates = recurringGeometrySummary.map((entry) => ({ motifId: `geometry:${entry.key}`, role: 'repeated-geometry', editable: false, source: 'recurring_geometry', objectId: entry.evidenceObjectIds[0] || null, name: null, type: null, bounds: entry.bounds, count: entry.count, confidence: 0.55 }));
            const motifLabelCandidates = motifCandidates.slice(0, 24);
            const motifSummary = [...motifLabelCandidates, ...motifGeometryCandidates].slice(0, 32);
            const likelyReusableObjects = allVisibleItems.filter((item) => item.label?.editable === true).map((item) => ({ objectId: item.objectId, name: item.name, reason: item.label?.source || 'editable_label' })).slice(0, 32);
            const spacingRhythmSummary = [...spacingGaps.values()].sort((a, b) => b.count - a.count || a.value - b.value).slice(0, 16);
            const imageRoleSummary = imageRoles.slice(0, 16);
            const inspectedObjectIdsBySignal = {
                typeScale: typeScale.flatMap((entry) => entry.evidenceObjectIds || []),
                fontUsage: fontUsage.families.flatMap((entry) => entry.evidenceObjectIds || []).slice(0, 24),
                colorRoles: swatches.flatMap((entry) => entry.evidenceObjectIds || []).slice(0, 24),
                spacingScale: spacingRhythmSummary.flatMap((entry) => entry.evidenceObjectIds || []).slice(0, 24),
                marginHints: marginHints.flatMap((entry) => entry.evidenceObjectIds || []).slice(0, 24),
                gridHints: gridHints.flatMap((entry) => entry.evidenceObjectIds || []).slice(0, 24),
                motifCandidates: motifSummary.flatMap((entry) => [entry.objectId].filter((value) => value != null)).slice(0, 24),
                imageRoles: imageRoleSummary.flatMap((entry) => [entry.objectId].filter((value) => value != null)).slice(0, 24)
            };
            const signalAgreement = [typeScale.length > 0, fontUsage.families.length > 0, swatches.length > 0, spacingRhythmSummary.length > 0, gridHints.length > 0].filter(Boolean).length;
            const sampleCount = allVisibleItems.length;
            let confidenceScore = 0.42;
            if (sampleCount >= 8) confidenceScore += 0.12;
            if (textItemCount >= 3) confidenceScore += 0.12;
            if (typeScale.length >= 3) confidenceScore += 0.12;
            if (signalAgreement >= 4) confidenceScore += 0.1;
            if (truncated || pageResults.some((pageResult) => pageResult.inspected.pagination?.hasMore === true)) confidenceScore -= 0.18;
            if (sampleCount < 3) confidenceScore -= 0.12;
            confidenceScore = Math.max(0.1, Math.min(0.9, confidenceScore));
            const confidence = confidenceScore >= 0.7 ? 'high' : confidenceScore >= 0.45 ? 'medium' : 'low';
            if (sampleCount < 3) warnings.push('Low sample count reduces design-system confidence.');
            if (truncated) warnings.push('Requested pages or item budget were truncated to stay bounded.');
            if (pageResults.some((pageResult) => pageResult.inspected.pagination?.hasMore === true)) warnings.push('Item results were truncated by maxItems.');
            const itemEvidenceSample = args.includeItems === false ? [] : allVisibleItems.slice(0, Math.min(16, maxItems)).map((item) => ({
                objectId: item.objectId,
                name: item.name,
                type: item.type,
                pageIndex: item.pageIndex,
                bounds: item.bounds || item.geometricBounds || null,
                label: item.label || {},
                text: item.text ? {
                    overset: item.text.overset === true,
                    fontFamily: item.text.fontFamily || null,
                    fontStyle: item.text.fontStyle || null,
                    pointSize: item.text.pointSize || null,
                    paragraphStyle: item.text.paragraphStyle || null,
                    characterStyle: item.text.characterStyle || null,
                    excerpt: args.includeTextExcerpt === true ? item.text.excerpt || null : undefined
                } : null,
                image: item.image ? (args.includeImageMetadata === true ? item.image : { hasPlacedGraphic: item.image.hasPlacedGraphic === true }) : null,
                fillColor: item.fillColor || null,
                strokeColor: item.strokeColor || null,
                strokeWeight: item.strokeWeight ?? null
            })).map((item) => {
                if (item.text && item.text.excerpt === undefined) delete item.text.excerpt;
                return item;
            });
            const signals = {
                typeScale,
                fontUsage,
                colorRoles: colorRoleSummary,
                spacingScale: {
                    commonGaps: spacingRhythmSummary,
                    commonWidthHeights: recurringGeometrySummary.map((entry) => ({ key: entry.key, count: entry.count, evidenceObjectIds: entry.evidenceObjectIds.slice(0, 8), bounds: entry.bounds })),
                    confidence: spacingRhythmSummary.length >= 2 ? 'medium' : 'low'
                },
                marginHints,
                gridHints,
                motifCandidates: motifSummary,
                imageRoles: imageRoleSummary
            };
            const pageScope = {
                requestedPageIndex,
                requestedPageIndexes: requestedPageIndexes.slice(),
                analyzedPageIndexes,
                defaultedPageIndex,
                allowHeavyInspection: args.allowHeavyInspection === true
            };
            const limits = {
                maxPages,
                maxItems,
                detailLevel: resolvedDetailLevel,
                includeHidden: args.includeHidden === true,
                includeTextExcerpt: args.includeTextExcerpt === true,
                includeImageMetadata: args.includeImageMetadata === true,
                includePathPoints: args.includePathPoints === true && args.allowHeavyInspection === true,
                includeTextMetadata: args.includeTextMetadata !== false,
                totalInspectedItems,
                totalSkippedOrTruncatedItems
            };
            const provenance = {
                sourcePages: analyzedPageIndexes.slice(),
                inspectedCountsByPage: itemCountByPage,
                evidenceObjectIdsBySignal: inspectedObjectIdsBySignal,
                bundleIncluded: true,
                gridIncluded: args.includeGrid === true,
                swatchesIncluded: args.includeSwatches !== false,
                stylesIncluded: args.includeStyles !== false,
                truncated,
                limitsApplied: {
                    maxPages,
                    maxItems,
                    detailLevel: resolvedDetailLevel,
                    includeHidden: args.includeHidden === true,
                    includeTextExcerpt: args.includeTextExcerpt === true,
                    includeImageMetadata: args.includeImageMetadata === true,
                    includePathPoints: args.includePathPoints === true && args.allowHeavyInspection === true,
                    includeTextMetadata: args.includeTextMetadata !== false,
                    pageBudgetLimit,
                    perPageBudgets: pageBudgets,
                    totalInspectedItems,
                    totalSkippedOrTruncatedItems
                },
                confidenceScore
            };
            return {
                success: true,
                source: 'heuristic_bounded_design_system_analysis',
                pageScope,
                limits,
                truncated,
                confidence,
                signals,
                warnings,
                provenance,
                fonts: fontUsage.families,
                swatches,
                textHierarchy: typeScale,
                recurringGeometry: recurringGeometrySummary,
                motifs: motifSummary,
                likelyReusableObjects,
                pageZones,
                spacingRhythm: spacingRhythmSummary.map((entry) => entry.value),
                itemEvidenceSample,
                colorRoles: colorRoleSummary,
                imageRoles: imageRoleSummary
            };
        })(), 'analyze_design_system');
    }

    static compare_derivative_state(args = {}) {
        return response((async () => {
            const manifest = loadWorkspace();
            const derivative = this.resolveDerivativeRecord(manifest, args);
            const snapshots = this.loadInspectionSnapshots(manifest).filter((snapshot) => snapshot.derivativeId === derivative.derivativeId);
            const previous = args.previousInspectionId ? snapshots.find((snapshot) => snapshot.inspectionId === args.previousInspectionId) : args.previousPreviewId ? snapshots.find((snapshot) => snapshot.previewId === args.previousPreviewId) : snapshots.at(-2);
            const current = args.currentPreviewId ? snapshots.find((snapshot) => snapshot.previewId === args.currentPreviewId) : snapshots.at(-1);
            if (!previous || !current) throw new Error('Need previous and current inspection snapshots');
            const byId = (list) => new Map((list || []).map((item) => [item.objectId, item]));
            const prevMap = byId(previous.objects);
            const currMap = byId(current.objects);
            const changedObjects = [];
            const addedObjects = [];
            const removedObjects = [];
            const changedBounds = [];
            const changedText = [];
            const changedStyles = [];
            for (const [id, item] of currMap.entries()) {
                if (!prevMap.has(id)) { addedObjects.push(item); continue; }
                const prior = prevMap.get(id);
                if (JSON.stringify(prior) !== JSON.stringify(item)) changedObjects.push({ objectId:id, before:prior, after:item });
                if (JSON.stringify(prior.bounds) !== JSON.stringify(item.bounds)) changedBounds.push({ objectId:id, before:prior.bounds, after:item.bounds });
                if (JSON.stringify(prior.text) !== JSON.stringify(item.text)) changedText.push({ objectId:id, before:prior.text, after:item.text });
                if (prior.objectStyle !== item.objectStyle || prior.fillSwatch !== item.fillSwatch || prior.strokeSwatch !== item.strokeSwatch || prior.strokeWeight !== item.strokeWeight) changedStyles.push({ objectId:id, before:{ objectStyle:prior.objectStyle, fillSwatch:prior.fillSwatch, strokeSwatch:prior.strokeSwatch, strokeWeight:prior.strokeWeight }, after:{ objectStyle:item.objectStyle, fillSwatch:item.fillSwatch, strokeSwatch:item.strokeSwatch, strokeWeight:item.strokeWeight } });
            }
            for (const [id, item] of prevMap.entries()) if (!currMap.has(id)) removedObjects.push(item);
            return { success:true, derivativeId: derivative.derivativeId, changedObjects, addedObjects, removedObjects, changedBounds, changedText, changedStyles };
        })(), 'compare_derivative_state');
    }

    static run_derivative_checks(args = {}) {
        return response((async () => {
            if (!args.derivativeId && args.pageIndex == null) throw new Error('derivativeId or pageIndex is required');
            const manifest = loadWorkspace();
            let derivative = null;
            if (args.derivativeId) {
                derivative = this.resolveDerivativeRecord(manifest, args);
            } else if (args.pageIndex != null) {
                derivative = (manifest.derivatives || []).find((entry) => entry.pageIndex === args.pageIndex) || null;
            }
            const traceId = args.diagnostics ? (args.traceId || generateTraceId()) : null;
            const trace = traceId ? { traceId, toolName: 'run_derivative_checks' } : null;
            const phases = [];
            const naTrace = { traceId: 'na', toolName: 'run_derivative_checks' };

            function recordPhase(phase, durationMs, ok, extra = {}) {
                if (traceId) phases.push({ phase, durationMs, ok, ...extra });
            }

            async function runPhase(phase, fn) {
                const start = Date.now();
                try {
                    const result = await timedPhase(trace || naTrace, phase, fn);
                    recordPhase(phase, Date.now() - start, true);
                    return result;
                } catch (error) {
                    recordPhase(phase, Date.now() - start, false, { error: error.message });
                    throw error;
                }
            }

            const resolved = unwrapToolResult(await runPhase('resolve_derivative_page', () =>
                args.derivativeId
                    ? this.resolve_derivative_page({ derivativeId: args.derivativeId, trace })
                    : this.resolve_derivative_page({ pageIndex: args.pageIndex, trace })
            ));
            const pageIndex = resolved.pageIndex;

            const itemsResult = await runPhase('inspect_page_items_v2', () =>
                this.inspectPageItemsRaw({
                    pageIndex,
                    includeHidden: true,
                    includeTextExcerpt: args.includeOversetExcerpt === true,
                    includeTextMetadata: false,
                    includeImageMetadata: false,
                    includePathPoints: false,
                    limit: args.limit ?? 500,
                    detailLevel: 'summary',
                    trace
                })
            );

            const objects = (itemsResult.items || []).filter((item) => !(item.label?.role === 'page_marker' || item.label?.metadata === true));
            const oversetIssues = objects.filter((item) => item.text?.overset).map((item) => ({ objectId: item.objectId, name: item.name, evidence: item.text.excerpt || null }));
            const visibleReference = objects.filter((item) => item.label?.referenceOnly && item.visible !== false).map((item) => ({ objectId: item.objectId, name: item.name }));
            const unlabeled = objects.filter((item) => !item.label || !Object.keys(item.label).length).map((item) => ({ objectId: item.objectId, name: item.name }));

            // Determine whether to run document-global link/font checks
            const shouldCheckLinks = args.requireNoMissingLinks === true || args.includeDocumentLinkCheck === true;
            const shouldCheckFonts = args.requireNoMissingFonts === true || args.includeDocumentFontCheck === true;

            // Phase: check_missing_links (document-global, opt-in)
            let linksResult = null;
            if (shouldCheckLinks) {
                linksResult = await runPhase('check_missing_links', () => this.uxpTool('check_missing_links', { trace }));
            }

            // Phase: check_missing_fonts (document-global, opt-in)
            let fontsResult = null;
            if (shouldCheckFonts) {
                fontsResult = await runPhase('check_missing_fonts', () => this.uxpTool('check_missing_fonts', { trace }));
            }

            // Phase: post_process
            const ppStart = Date.now();
            const checks = {
                oversetText: { ok: oversetIssues.length === 0, issues: oversetIssues },
                missingLinks: shouldCheckLinks
                    ? { ok: (linksResult?.issues || []).length === 0, issues: linksResult?.issues || [] }
                    : { ok: true, skipped: true, scope: 'document', reason: 'Document-global link check not requested' },
                missingFonts: shouldCheckFonts
                    ? { ok: (fontsResult?.issues || []).length === 0, issues: fontsResult?.issues || [] }
                    : { ok: true, skipped: true, scope: 'document', reason: 'Document-global font check not requested' },
                visibleReferenceUnderlay: { ok: visibleReference.length === 0, issues: visibleReference },
                unlabeledObjects: { ok: unlabeled.length === 0, issues: unlabeled }
            };
            const issues = [];
            if (args.requireNoOverset && !checks.oversetText.ok) issues.push({ check: 'oversetText', issues: checks.oversetText.issues });
            if (args.requireNoVisibleReferenceUnderlay && !checks.visibleReferenceUnderlay.ok) issues.push({ check: 'visibleReferenceUnderlay', issues: checks.visibleReferenceUnderlay.issues });
            if (args.requireLabels && !checks.unlabeledObjects.ok) issues.push({ check: 'unlabeledObjects', issues: checks.unlabeledObjects.issues });
            if (args.requireNoMissingLinks && checks.missingLinks.skipped !== true && !checks.missingLinks.ok) issues.push({ check: 'missingLinks', issues: checks.missingLinks.issues });
            if (args.requireNoMissingFonts && checks.missingFonts.skipped !== true && !checks.missingFonts.ok) issues.push({ check: 'missingFonts', issues: checks.missingFonts.issues });
            recordPhase('post_process', Date.now() - ppStart, true);

            // Phase: manifest_update
            const muStart = Date.now();
            if (derivative) {
                upsertDerivativePage(manifest, derivative.derivativeId, { checkHistory: [...(derivative.checkHistory || []), { createdAt: nowIso(), checks, ok: issues.length === 0 }] });
            }
            recordPhase('manifest_update', Date.now() - muStart, true);

            const result = {
                success: true,
                ok: issues.length === 0,
                derivativeId: derivative?.derivativeId,
                pageIndex,
                pageId: resolved.pageId || null,
                checks,
                issues,
                warnings: resolved.warnings || []
            };

            if (args.diagnostics) {
                result.diagnostics = {
                    traceId,
                    phases,
                    counts: {
                        inspectedItems: objects.length,
                        textFrames: objects.filter((o) => o.type && /TextFrame/i.test(o.type)).length,
                        oversetTextFrames: oversetIssues.length,
                        visibleReferenceItems: visibleReference.length,
                        unlabeledObjects: unlabeled.length,
                        documentLinkCheckSkipped: !shouldCheckLinks,
                        documentFontCheckSkipped: !shouldCheckFonts
                    }
                };
            }

            return result;
        })(), 'run_derivative_checks');
    }

    static get_document_stress_summary(args = {}) {
        return response((async () => {
            const trace = args.diagnostics
                ? { traceId: args.traceId || generateTraceId(), toolName: 'get_document_stress_summary' }
                : null;

            const result = await runGuarded(`
                function at(c,i){ return c.item ? c.item(i) : c[i]; }
                function len(c){ try { return c.length || 0; } catch(e) { return 0; } }
                function safe(fn, fallback=null){ try { return fn(); } catch(e){ return fallback; } }
                function arr(c, fn){ const out=[]; for (let i=0;i<len(c);i++){ try { out.push(fn(at(c,i), i)); } catch(e){ out.push({ index:i, warning:String(e) }); } } return out; }

                const items = doc.allPageItems || doc.pageItems;
                const linkStatusCounts = {};
                for (let i=0;i<len(doc.links);i++){
                    const s = String(safe(()=>at(doc.links,i).status,''));
                    linkStatusCounts[s] = (linkStatusCounts[s] || 0) + 1;
                }

                const fontStatusCounts = {};
                for (let i=0;i<len(doc.fonts);i++){
                    const s = String(safe(()=>at(doc.fonts,i).status,''));
                    fontStatusCounts[s] = (fontStatusCounts[s] || 0) + 1;
                }

                const pages = arr(doc.pages, (p,i) => ({
                    pageIndex: i,
                    name: safe(()=>p.name),
                    itemCount: safe(()=>len(p.allPageItems || p.pageItems), 0)
                }));

                const layers = arr(doc.layers, (l) => l);

                return {
                    success: true,
                    pageCount: len(doc.pages),
                    spreadCount: len(doc.spreads),
                    layerCount: len(doc.layers),
                    hiddenLayerCount: layers.filter(l => safe(()=>l.visible) === false).length,
                    lockedLayerCount: layers.filter(l => safe(()=>l.locked) === true).length,
                    swatchCount: len(doc.swatches),
                    paragraphStyleCount: len(doc.paragraphStyles),
                    characterStyleCount: len(doc.characterStyles),
                    objectStyleCount: len(doc.objectStyles),
                    documentPageItemCount: len(items),
                    linkCount: len(doc.links),
                    linkStatusCounts,
                    fontCount: len(doc.fonts),
                    fontStatusCounts,
                    parentPageCount: len(doc.masterSpreads || []),
                    pages
                };
            `, { trace, phase: 'get_document_stress_summary' });

            return result;
        })(), 'get_document_stress_summary');
    }

    static export_page_preview(args = {}) { return this.exportPreview('page', args); }
    static export_spread_preview(args = {}) { return this.exportPreview('spread', args); }

    static place_image(args = {}) {
        return response((async () => {
            const m = loadWorkspace();
            const requestedPath = args.imagePath || args.filePath;
            const imagePath = (() => {
                try { return assertWorkspacePath(requestedPath, { kind: 'assets', manifest: m }).path; }
                catch { return assertWorkspacePath(requestedPath, { kind: 'input', manifest: m }).path; }
            })();
            return runGuarded(`${jsHelpers()} const args=${q({ ...args, imagePath })};
                const { FitOptions } = require('indesign');
                const it = resolveItem(args);
                it.place(args.imagePath, false);
                const fitMap = { contentToFrame: FitOptions.CONTENT_TO_FRAME, FIT_CONTENT: FitOptions.CONTENT_TO_FRAME, frameToContent: FitOptions.FRAME_TO_CONTENT, FIT_FRAME: FitOptions.FRAME_TO_CONTENT, proportionally: FitOptions.PROPORTIONALLY, PROPORTIONALLY: FitOptions.PROPORTIONALLY, fillProportionally: FitOptions.FILL_PROPORTIONALLY, FILL_FRAME: FitOptions.FILL_PROPORTIONALLY, centerContent: FitOptions.CENTER_CONTENT };
                if (args.fitMode && fitMap[args.fitMode]) it.fit(fitMap[args.fitMode]);
                return { success:true, action:'place_image', imagePath:args.imagePath, fitMode:args.fitMode||null, ...meta(it), link:safe(()=>({ name:it.graphics.item(0).itemLink.name, status:String(it.graphics.item(0).itemLink.status), path:it.graphics.item(0).itemLink.filePath }), null), warnings:['Path strings are docs-verified but pending live UXP validation'] };
            `);
        })(), 'place_image');
    }

    static create_reference_underlay(args = {}) {
        return response((async () => {
            const m = loadWorkspace();
            const requestedPath = args.imagePath || args.filePath;
            const imagePath = (() => {
                try { return assertWorkspacePath(requestedPath, { kind: 'assets', manifest: m }).path; }
                catch { return assertWorkspacePath(requestedPath, { kind: 'input', manifest: m }).path; }
            })();
            const target = args.derivativeId ? await this.resolveDerivativeTarget({ derivativeId: args.derivativeId }) : null;
            return runGuarded(`${jsHelpers()} const args=${q({ ...args, imagePath, pageIndex: target?.pageIndex ?? args.pageIndex ?? null, resolvedPageIndex: target?.pageIndex ?? args.pageIndex ?? null, resolvedPageId: target?.pageId || null, resolvedBy: target?.resolvedBy || null, pageIdentityWarnings: target?.warnings || [] })};
                const { FitOptions } = require('indesign');
                const layerName = args.layerName || 'REFERENCE_UNDERLAY';
                let layer = doc.layers.itemByName(layerName);
                if (!layer || layer.isValid === false) layer = doc.layers.add({ name: layerName });
                layer.visible = true; layer.locked = false; layer.printable = false;
                if (args.pageIndex == null) throw new Error('pageIndex or derivativeId is required');
                const p = pageByIndex(args.pageIndex);
                const resolved = resolveBoundsForPage(args);
                const boundsValidation = validateBoundsOnPage(resolved.documentBounds, resolved.pageBounds, args);
                const rect = p.rectangles.add({ geometricBounds: resolved.documentBounds, itemLayer: layer });
                rect.name = args.name || 'reference_underlay';
                writeLabel(rect, { referenceOnly:true, source:'reference_underlay', ...(args.label||{}) });
                rect.nonprinting = true;
                rect.place(args.imagePath, false);
                rect.fit(FitOptions.FILL_PROPORTIONALLY);
                rect.sendToBack(); layer.locked = args.lockLayer !== false;
                return { success:true, action:'create_reference_underlay', layerName, imagePath:args.imagePath, coordinateSpace:resolved.coordinateSpace, localBounds:resolved.localBounds, documentBounds:resolved.documentBounds, pageBounds:resolved.pageBounds, boundsValidation, pageIdentity:{ derivativeId:args.derivativeId || null, pageIndex:args.resolvedPageIndex || args.pageIndex || null, pageId:args.resolvedPageId || null, resolvedBy:args.resolvedBy || (args.pageIndex != null ? 'pageIndex' : null), warnings:args.pageIdentityWarnings || [] }, ...meta(rect), warnings:['Path-string placement/layer properties pending live UXP validation'] };
            `);
        })(), 'create_reference_underlay');
    }

    static hide_reference_underlay(args = {}) {
        return response(runGuarded(`
            const layer = doc.layers.itemByName(${q(args.layerName || 'REFERENCE_UNDERLAY')});
            if (!layer || layer.isValid === false) return { success:false, error:'Reference underlay layer not found' };
            layer.visible = false;
            return { success:true, action:'hide_reference_underlay', layerName:layer.name };
        `), 'hide_reference_underlay');
    }

    static remove_reference_underlay(args = {}) {
        return response(runGuarded(`
            const layer = doc.layers.itemByName(${q(args.layerName || 'REFERENCE_UNDERLAY')});
            if (!layer || layer.isValid === false) return { success:false, error:'Reference underlay layer not found' };
            layer.locked = false;
            const count = layer.pageItems ? layer.pageItems.length : 0;
            for (let i=count-1;i>=0;i--) layer.pageItems.item(i).remove();
            if (${q(args.removeLayer !== false)}) layer.remove();
            return { success:true, action:'remove_reference_underlay', removedItems:count };
        `), 'remove_reference_underlay');
    }

    static exportPreview(kind, args) {
        return response((async () => {
            const m = loadWorkspace();
            const execMeta = args.trace ? { traceId: args.trace.traceId, toolName: args.trace.toolName, phase: `exportPreview_${kind}` } : {};
            await this.ensureTemplateReady({ allowSwitchDocument: true, openIfMissing: true, trace: args.trace });
            const previewSettings = resolvePreviewExportSettings(args);
            const ext = (args.format || 'png').toLowerCase() === 'jpg' ? 'jpg' : 'png';
            const outputName = normalizePreviewOutputName(args.outputName, ext, `${kind}_${args.pageIndex ?? args.spreadIndex}`);
            const out = assertWorkspacePath(path.join(m.workspaceRoot, 'previews', outputName), { kind: 'previews', manifest: m }).path;
            if (fs.existsSync(out) && !args.overwrite) throw new Error('Preview exists; set overwrite=true');
            const resolved = args.derivativeId ? unwrapToolResult(await this.resolve_derivative_page({ derivativeId: args.derivativeId })) : null;
            const pageIndex = resolved?.pageIndex ?? args.pageIndex ?? null;
            await runGuarded(`
                const out = ${q(out)};
                const isJpg = ${q(ext === 'jpg')};
                const pageIndex = ${q(pageIndex)};
                const spreadIndex = ${q(args.spreadIndex ?? null)};
                const resolution = ${q(previewSettings.resolution)};
                let pageString = null;
                if (${q(kind)} === 'page') {
                    if (pageIndex === null || pageIndex < 0 || pageIndex >= doc.pages.length) throw new Error('pageIndex out of range');
                    const page = doc.pages.item ? doc.pages.item(pageIndex) : doc.pages[pageIndex];
                    pageString = String(page.name || (pageIndex + 1));
                } else {
                    if (spreadIndex === null || spreadIndex < 0 || spreadIndex >= doc.spreads.length) throw new Error('spreadIndex out of range');
                    const spread = doc.spreads.item(spreadIndex);
                    const names = [];
                    for (let i=0;i<spread.pages.length;i++) names.push(String(spread.pages.item(i).name || (i+1)));
                    pageString = names.join(',');
                }
                try {
                    if (isJpg && app.jpegExportPreferences) {
                        app.jpegExportPreferences.pageString = pageString;
                        app.jpegExportPreferences.exportResolution = resolution;
                    }
                    if (!isJpg && app.pngExportPreferences) {
                        app.pngExportPreferences.pageString = pageString;
                        app.pngExportPreferences.exportResolution = resolution;
                        if (${q(args.transparentBackground ?? null)} !== null) app.pngExportPreferences.transparentBackground = ${q(args.transparentBackground ?? null)};
                    }
                } catch(e) {}
                try {
                    await doc.exportFile(isJpg ? 'jpg' : 'png', out, false);
                } catch(firstError) {
                    const { ExportFormat } = require('indesign');
                    await doc.exportFile(isJpg ? ExportFormat.jpegType : ExportFormat.pngType, out, false);
                }
                return { success:true, path: out };
            `, { trace: execMeta });
            const stat = fileStatEvidence(out);
            const info = imageInfo(out);
            if (!info.widthPx || !info.heightPx) throw new Error('Preview exported but dimensions are invalid');
            const rec = {
                success: true,
                previewId: `preview_${Date.now()}_${kind}_${pageIndex ?? args.spreadIndex ?? 0}`,
                path: out,
                filePath: out,
                mimeType: info.mimeType,
                format: ext,
                previewQuality: previewSettings.previewQuality,
                resolution: previewSettings.resolution,
                widthPx: info.widthPx,
                heightPx: info.heightPx,
                sizeBytes: stat.sizeBytes,
                pageIndex,
                pageId: resolved?.pageId || null,
                spreadIndex: args.spreadIndex ?? null,
                derivativeId: args.derivativeId || null,
                createdAt: new Date().toISOString(),
            };
            if (args.returnImage !== false) {
                rec.mcpImage = buildMcpImagePayload(out, info.mimeType);
            }
            const persisted = { ...rec };
            delete persisted.mcpImage;
            m.previews.push(persisted); saveWorkspace(m);
            return rec;
        })(), `export_${kind}_preview`);
    }

    static verify_template_roundtrip(args = {}) {
        return response((async () => {
            const traceId = args.diagnostics ? (args.traceId || generateTraceId()) : null;
            const trace = traceId ? { traceId, toolName: 'verify_template_roundtrip' } : null;
            const phases = [];

            async function runPhase(phase, fn) {
                const start = Date.now();
                try {
                    const result = await fn();
                    if (traceId) phases.push({ phase, durationMs: Date.now() - start, ok: true });
                    return result;
                } catch (error) {
                    if (traceId) phases.push({ phase, durationMs: Date.now() - start, ok: false, error: error.message });
                    throw error;
                }
            }

            await runPhase('ensureTemplateReady', () =>
                this.ensureTemplateReady({ allowSwitchDocument: true, openIfMissing: true, trace })
            );
            const resolved = unwrapToolResult(await runPhase('resolve_derivative_page', () =>
                args.derivativeId
                    ? this.resolve_derivative_page({ derivativeId: args.derivativeId, trace })
                    : this.resolve_derivative_page({ pageIndex: args.pageIndex, trace })
            ));
            const save = unwrapToolResult(await runPhase('save_working_copy', () => this.save_working_copy({ trace })));
            const itemsResult = unwrapToolResult(await runPhase('inspect_page_items_v2', () =>
                this.inspectPageItemsRaw({ pageIndex: resolved.pageIndex, includeHidden: true, includeTextExcerpt: args.includeTextExcerpt === true, includeTextMetadata: false, includeImageMetadata: false, includePathPoints: false, limit: args.limit ?? 500, detailLevel: 'summary', trace })
            ));
            const visibleItems = (itemsResult.items || []).filter((item) => !(item.label?.role === 'page_marker' || item.label?.metadata === true));
            const checks = unwrapToolResult(await runPhase('run_derivative_checks', () =>
                this.run_derivative_checks({
                    derivativeId: args.derivativeId || undefined,
                    pageIndex: resolved.pageIndex,
                    requireNoOverset: args.requireNoOverset !== false,
                    requireNoMissingLinks: args.requireNoMissingLinks === true,
                    diagnostics: args.diagnostics === true,
                    traceId
                })
            ));
            const issues = [];
            if (visibleItems.length < (args.expectedMinItems ?? 1)) issues.push({ check: 'expectedMinItems', expectedMinItems: args.expectedMinItems ?? 1, actual: visibleItems.length });
            if (checks.ok === false) issues.push(...(checks.issues || []));
            let preview = null;
            if (args.requirePreview !== false) {
                preview = unwrapToolResult(await runPhase('export_derivative_preview', () =>
                    this.export_derivative_preview({
                        derivativeId: args.derivativeId,
                        pageIndex: resolved.pageIndex,
                        overwrite: args.overwritePreview !== false,
                        previewQuality: args.previewQuality || 'checkpoint',
                        returnImage: false,
                        trace
                    })
                ));
                if (!preview?.sizeBytes || !preview?.widthPx || !preview?.heightPx) issues.push({ check: 'preview', issue: 'Preview evidence missing or zero-sized' });
            }
            const result = {
                success: true,
                ok: issues.length === 0,
                derivativeId: args.derivativeId || null,
                pageIndex: resolved.pageIndex,
                pageId: resolved.pageId || null,
                itemCount: visibleItems.length,
                save,
                checks: checks.checks || null,
                preview,
                issues,
                warnings: resolved.warnings || []
            };
            if (args.diagnostics && traceId) {
                result.diagnostics = { traceId, phases };
            }
            return result;
        })(), 'verify_template_roundtrip');
    }

    static finalize_derivative(args = {}) {
        return response((async () => {
            if (!args.derivativeId) throw new Error('derivativeId is required');
            const traceId = args.diagnostics ? (args.traceId || generateTraceId()) : null;
            const trace = traceId ? { traceId, toolName: 'finalize_derivative' } : null;
            const phases = [];

            async function runPhase(phase, fn) {
                const start = Date.now();
                try {
                    const result = await fn();
                    if (traceId) phases.push({ phase, durationMs: Date.now() - start, ok: true });
                    return result;
                } catch (error) {
                    if (traceId) phases.push({ phase, durationMs: Date.now() - start, ok: false, error: error.message });
                    throw error;
                }
            }

            await runPhase('ensureTemplateReady', () =>
                this.ensureTemplateReady({ allowSwitchDocument: true, openIfMissing: true, trace })
            );
            const inspection = unwrapToolResult(await runPhase('inspect_derivative', () =>
                this.inspect_derivative({ derivativeId: args.derivativeId, includeChecks: true, includePreviewHistory: true, trace })
            ));
            const save = unwrapToolResult(await runPhase('save_working_copy', () => this.save_working_copy({ trace })));
            const version = args.saveVersion === false ? null : unwrapToolResult(await runPhase('save_version', () =>
                this.save_version({ derivativeId: args.derivativeId, label: args.versionLabel || null, trace })
            ));
            const preview = args.requirePreview === false ? null : unwrapToolResult(await runPhase('export_derivative_preview', () =>
                this.export_derivative_preview({
                    derivativeId: args.derivativeId,
                    overwrite: true,
                    previewQuality: args.previewQuality || 'final',
                    returnImage: false,
                    trace
                })
            ));
            const roundtrip = unwrapToolResult(await runPhase('verify_template_roundtrip', () =>
                this.verify_template_roundtrip({
                    derivativeId: args.derivativeId,
                    expectedMinItems: args.expectedMinItems ?? 1,
                    requirePreview: args.requirePreview !== false,
                    requireNoOverset: args.requireNoOverset !== false,
                    requireNoMissingLinks: args.requireNoMissingLinks === true,
                    overwritePreview: true,
                    previewQuality: args.previewQuality || 'checkpoint',
                    diagnostics: args.diagnostics === true,
                    traceId
                })
            ));
            const result = {
                success: true,
                ok: !!roundtrip?.ok,
                derivativeId: args.derivativeId,
                inspection,
                save,
                version,
                preview,
                roundtrip,
                issues: roundtrip.issues || []
            };
            if (args.diagnostics && traceId) {
                result.diagnostics = { traceId, phases };
            }
            return result;
        })(), 'finalize_derivative');
    }

    static build_derivative_from_recipe(args = {}) {
        return response((async () => {
            if (!args.derivativeId) throw new Error('derivativeId is required');
            if (!Array.isArray(args.items)) throw new Error('items are required');
            await this.ensureTemplateReady({ allowSwitchDocument: true, openIfMissing: true });
            const mode = args.mode || 'fail_fast';
            const createdObjectIds = [];
            let page = unwrapToolResult(await this.create_derivative_page(args));
            const resolvedPage = await this.resolveDerivativeTarget({ derivativeId: args.derivativeId });
            const pageWarnings = [];
            if (page.pageIndex != null && resolvedPage.pageIndex != null && page.pageIndex !== resolvedPage.pageIndex) pageWarnings.push(`Resolved derivative pageIndex ${resolvedPage.pageIndex} differs from create_derivative_page result ${page.pageIndex}; using resolved durable page identity`);
            let failedStep = null;
            try {
                for (const item of args.items) {
                    const common = { ...args, ...item, derivativeId: args.derivativeId, pageIndex: resolvedPage.pageIndex, coordinateSpace: item.coordinateSpace || args.coordinateSpace || 'page', layerName: item.layerName || args.layerName || 'AGENT_WORK', rejectOutOfPageBounds: item.rejectOutOfPageBounds ?? args.rejectOutOfPageBounds, maxOutsidePageRatio: item.maxOutsidePageRatio ?? args.maxOutsidePageRatio, label: shallowMergeLabel({ derivativeId: args.derivativeId, role: item.role, slot: item.slot, motifId: item.motifId, source: 'agent_created', editable: true }, item.label) };
                    let result;
                    if (item.type === 'text') result = unwrapToolResult(await this.create_text_slot({ ...common, role: item.role || 'body', slot: item.slot || item.role || `text_${createdObjectIds.length + 1}`, text: item.text || '', bounds: item.bounds, autoFit: item.autoFit, preserveStyle: item.preserveStyle, textReplacePolicy: item.textReplacePolicy }));
                    else if (item.type === 'image') result = unwrapToolResult(await this.create_image_slot({ ...common, role: item.role || 'image', slot: item.slot || item.role || `image_${createdObjectIds.length + 1}`, bounds: item.bounds, imagePath: item.imagePath, placeholder: item.placeholder !== false, fitMode: item.fitMode }));
                    else if (item.type === 'shape') result = await this.createShapeRaw({ ...common, shapeType: item.shapeType || 'rectangle' });
                    else if (item.type === 'line') result = await this.createLineRaw({ ...common, start: item.start, end: item.end });
                    else throw new Error(`Unsupported recipe item type: ${item.type}`);
                    if (result?.objectId != null) createdObjectIds.push(result.objectId);
                    else if (Array.isArray(result?.objectIds)) createdObjectIds.push(...result.objectIds);
                    else throw new Error(`Recipe item did not return objectId/objectIds for type ${item.type}`);
                }
            } catch (error) {
                failedStep = String(error.message || error);
                if (mode === 'fail_fast') {
                    const roundtrip = await this.verify_template_roundtrip({ derivativeId: args.derivativeId, expectedMinItems: 0, requirePreview: false, requireNoOverset: false }).then(unwrapToolResult).catch(() => null);
                    return { success: true, ok: false, derivativeId: args.derivativeId, pageIndex: resolvedPage.pageIndex, pageId: resolvedPage.pageId || null, createdObjectIds, failedStep, roundtrip, pageIdentityWarnings: pageWarnings };
                }
            }
            if (Array.isArray(args.edits) && args.edits.length) await this.apply_layout_recipe({ derivativeId: args.derivativeId, edits: args.edits, mode });
            const inspectionSummary = unwrapToolResult(await this.inspect_derivative({ derivativeId: args.derivativeId, includeChecks: true, includeObjectDetails: false }));
            const checks = unwrapToolResult(await this.run_derivative_checks({ derivativeId: args.derivativeId, ...(args.checks || {}) }));
            const save = unwrapToolResult(await this.save_working_copy({}));
            const version = args.saveVersion === false ? null : unwrapToolResult(await this.save_version({ derivativeId: args.derivativeId, label: args.versionLabel || null }));
            const preview = args.exportPreview === false ? null : unwrapToolResult(await this.export_derivative_preview({
                derivativeId: args.derivativeId,
                overwrite: true,
                previewQuality: args.previewQuality || 'checkpoint',
                returnImage: false
            }));
            const roundtrip = unwrapToolResult(await this.verify_template_roundtrip({
                derivativeId: args.derivativeId,
                expectedMinItems: Math.max(1, createdObjectIds.length),
                requirePreview: args.exportPreview !== false,
                requireNoOverset: args.checks?.requireNoOverset !== false,
                requireNoMissingLinks: args.checks?.requireNoMissingLinks === true,
                overwritePreview: true,
                previewQuality: args.previewQuality || 'checkpoint'
            }));
            return { success: true, ok: !!roundtrip?.ok, derivativeId: args.derivativeId, pageIndex: resolvedPage.pageIndex, pageId: resolvedPage.pageId || null, resolvedBy: resolvedPage.resolvedBy, createdObjectIds, inspectionSummary, checks: checks.checks || null, save, version, preview, roundtrip, pageIdentityWarnings: pageWarnings, ...(failedStep ? { failedStep } : {}) };
        })(), 'build_derivative_from_recipe');
    }

    static uxpTool(name, args) {
        // Extract trace from args to propagate through, remove before stringifying
        const trace = args && args.trace;
        let cleanArgs = trace ? { ...args } : args;
        if (cleanArgs && cleanArgs.trace) delete cleanArgs.trace;
        if (name === 'create_image_frame' && (cleanArgs.imagePath || cleanArgs.filePath)) {
            const m = loadWorkspace();
            const requestedPath = cleanArgs.imagePath || cleanArgs.filePath;
            const imagePath = (() => {
                try { return assertWorkspacePath(requestedPath, { kind: 'assets', manifest: m }).path; }
                catch { return assertWorkspacePath(requestedPath, { kind: 'input', manifest: m }).path; }
            })();
            cleanArgs = { ...cleanArgs, imagePath };
        }
        const a = q(cleanArgs);
        const execMeta = trace ? { traceId: trace.traceId, toolName: trace.toolName, phase: name } : {};
        if (['inspect_document_bundle','inspect_page_items_v2','inspect_styles','inspect_swatches','inspect_layers','inspect_parent_pages','check_overset_text','check_missing_links','check_missing_fonts','check_hidden_or_locked_problem_items','run_preflight','run_template_preflight'].includes(name)) {
            return runGuarded(`${jsHelpers()} const args=${a}; ${inspectionAndChecks(name)}`, { trace, phase: name });
        }
        return runGuarded(`${jsHelpers()} const args=${a}; ${layoutAndLabels(name)}`, { trace, phase: name });
    }
}

function inspectionAndChecks(name) {
    const common = `
        function enumString(v){ try { return v == null ? null : String(v); } catch(e){ return null; } }
        function idOf(x){ return safe(()=>x && x.id, null); }
        function collectionIndexById(coll, obj) {
            const id = idOf(obj);
            if (id == null) return null;
            for (let i=0;i<len(coll);i++) if (idOf(at(coll,i)) === id) return i;
            return null;
        }
        function clampInt(value, fallback, minValue, maxValue) {
            const num = Number(value == null ? fallback : value);
            if (!Number.isFinite(num)) return fallback;
            const rounded = Math.floor(num);
            return Math.max(minValue, Math.min(maxValue, rounded));
        }
        function swatchRef(x){
            if (!x || x.isValid === false) return null;
            return {
                id: safe(()=>x.id),
                name: safe(()=>x.name),
                type: safe(()=>x.constructor.name),
                colorModel: safe(()=>enumString(x.model)),
                colorSpace: safe(()=>enumString(x.space)),
                colorValue: safe(()=>x.colorValue),
                tint: safe(()=>x.tintValue, null)
            };
        }
        function marginInfo(m){
            if (!m || m.isValid === false) return null;
            return {
                top: safe(()=>m.top),
                bottom: safe(()=>m.bottom),
                left: safe(()=>m.left),
                right: safe(()=>m.right),
                inside: safe(()=>m.left),
                outside: safe(()=>m.right),
                columnCount: safe(()=>m.columnCount),
                columnGutter: safe(()=>m.columnGutter)
            };
        }
        function pageSizeFromBounds(b){ return Array.isArray(b) && b.length === 4 ? { width: b[3]-b[1], height: b[2]-b[0] } : null; }
        function styleGroupName(s){ const p = safe(()=>s.parent, null); const t = safe(()=>p && p.constructor && p.constructor.name, ''); return /Group/i.test(t) ? safe(()=>p.name, null) : null; }
        function paragraphStyleInfo(s,i){ return { index:i, id:safe(()=>s.id), name:safe(()=>s.name), group:styleGroupName(s), basedOn:safe(()=>s.basedOn && s.basedOn.name, null), fontFamily:safe(()=>s.appliedFont && s.appliedFont.fontFamily, null), fontStyle:safe(()=>s.fontStyle, null), pointSize:safe(()=>s.pointSize, null), leading:safe(()=>s.leading, null), tracking:safe(()=>s.tracking, null), fillColor:swatchRef(safe(()=>s.fillColor, null)), justification:safe(()=>enumString(s.justification), null), leftIndent:safe(()=>s.leftIndent, null), rightIndent:safe(()=>s.rightIndent, null), firstLineIndent:safe(()=>s.firstLineIndent, null), spaceBefore:safe(()=>s.spaceBefore, null), spaceAfter:safe(()=>s.spaceAfter, null) }; }
        function characterStyleInfo(s,i){ return { index:i, id:safe(()=>s.id), name:safe(()=>s.name), group:styleGroupName(s), basedOn:safe(()=>s.basedOn && s.basedOn.name, null), fontFamily:safe(()=>s.appliedFont && s.appliedFont.fontFamily, null), fontStyle:safe(()=>s.fontStyle, null), pointSize:safe(()=>s.pointSize, null), leading:safe(()=>s.leading, null), tracking:safe(()=>s.tracking, null), fillColor:swatchRef(safe(()=>s.fillColor, null)) }; }
        function objectStyleInfo(s,i){ return { index:i, id:safe(()=>s.id), name:safe(()=>s.name), group:styleGroupName(s), basedOn:safe(()=>s.basedOn && s.basedOn.name, null), fillColor:swatchRef(safe(()=>s.fillColor, null)), strokeColor:swatchRef(safe(()=>s.strokeColor, null)), strokeWeight:safe(()=>s.strokeWeight, null), enableFill:safe(()=>s.enableFill, null), enableStroke:safe(()=>s.enableStroke, null), enableParagraphStyle:safe(()=>s.enableParagraphStyle, null), appliedParagraphStyle:safe(()=>s.appliedParagraphStyle && s.appliedParagraphStyle.name, null) }; }
        function pageInfo(p,i, options){ const b = safe(()=>p.bounds, null); const info = { index:i, id:safe(()=>p.id), name:safe(()=>p.name), bounds:b, pageSize:pageSizeFromBounds(b), side:safe(()=>enumString(p.side), null), appliedParent:safe(()=>p.appliedMaster && p.appliedMaster.name, null), marginPreferences:marginInfo(safe(()=>p.marginPreferences, null)) }; if (options && options.includeItemCounts === true) info.itemCount = safe(()=>len(p.pageItems || p.allPageItems), null); return info; }
        function spreadInfo(s,i, options){ const info = { index:i, id:safe(()=>s.id), name:safe(()=>s.name), pages:arr(s.pages,(p)=>({ index:collectionIndexById(doc.pages, p), id:safe(()=>p.id), name:safe(()=>p.name) })) }; if (options && options.includeItemCounts === true) info.itemCount = safe(()=>len(s.pageItems || s.allPageItems), null); return info; }
        function parentPageInfo(m,i, options){ const mid = idOf(m); const appliedPages = arr(doc.pages,(p,pi)=>safe(()=>p.appliedMaster && p.appliedMaster.id, null) === mid ? pi : null).filter(x=>x !== null); const info = { index:i, id:safe(()=>m.id), name:safe(()=>m.name), pageCount:safe(()=>len(m.pages), null), appliedPages, pages:arr(m.pages,(p,pi)=>({ index:pi, name:safe(()=>p.name), bounds:safe(()=>p.bounds), pageSize:pageSizeFromBounds(safe(()=>p.bounds, null)), margins:marginInfo(safe(()=>p.marginPreferences, null)) })) }; if (options && options.includePageItems === true) { const limit = clampInt(options.limit, 100, 1, 500); const offset = clampInt(options.offset, 0, 0, 2147483647); const pageItems = arr(m.allPageItems || m.pageItems || [], x=>x); const sliced = pageItems.slice(offset, offset + limit); info.pageItemsSummary = sliced.map((it, index) => itemInfoSummary(it, index, options)); info.pageItemsPagination = { totalMatched: pageItems.length, returned: info.pageItemsSummary.length, offset, limit, hasMore: offset + info.pageItemsSummary.length < pageItems.length }; } return info; }
        function itemTypeName(it){ return safe(()=>it.constructor.name, ''); }
        function itemTypeMatches(it, typeFilter){ if (!typeFilter || (Array.isArray(typeFilter) && !typeFilter.length)) return true; const actual = itemTypeName(it).toLowerCase(); const types = Array.isArray(typeFilter) ? typeFilter : [typeFilter]; return types.some((type) => String(type || '').toLowerCase() === actual); }
        function itemLayer(it){ return safe(()=>it.itemLayer, null); }
        function itemVisible(it){ return safe(()=>it.visible, true) !== false; }
        function layerVisible(it){ const layer = itemLayer(it); return safe(()=>layer && layer.visible, true) !== false; }
        function itemMatchesCheapFilters(it, options){ if (!it || it.isValid === false) return false; if (options.includeHidden !== true && (!itemVisible(it) || !layerVisible(it))) return false; if (!itemTypeMatches(it, options.type)) return false; if (options.layerName && safe(()=>itemLayer(it).name, null) !== options.layerName) return false; if (options.namePrefix && !String(safe(()=>it.name, '') || '').startsWith(options.namePrefix)) return false; if (options.labelQuery && !labelMatches(readLabel(it), options.labelQuery)) return false; return true; }
        function itemMatchesNonVisibilityFilters(it, options){ if (!it || it.isValid === false) return false; if (!itemTypeMatches(it, options.type)) return false; if (options.layerName && safe(()=>itemLayer(it).name, null) !== options.layerName) return false; if (options.namePrefix && !String(safe(()=>it.name, '') || '').startsWith(options.namePrefix)) return false; if (options.labelQuery && !labelMatches(readLabel(it), options.labelQuery)) return false; return true; }
        function pageIndexForItem(it){ const pp = safe(()=>it.parentPage, null); return pp ? collectionIndexById(doc.pages, pp) : null; }
        function spreadIndexForItem(it){ const pp = safe(()=>it.parentPage, null); const sp = pp ? safe(()=>pp.parent, null) : safe(()=>it.parent, null); return sp ? collectionIndexById(doc.spreads, sp) : null; }
        function textInfoForItem(it, options){ const isText = /TextFrame/i.test(itemTypeName(it)); if (!isText) return null; const text = { overset: !!safe(()=>it.overflows, false) }; if (options && options.includeTextExcerpt === true) text.excerpt = String(safe(()=>it.contents, '') || '').slice(0, 200); if (options && options.includeTextMetadata === true) { const range = safe(()=>it.textStyleRanges && it.textStyleRanges.item(0), null); const firstChar = safe(()=>it.characters && it.characters.item(0), null); const textStory = safe(()=>it.texts && it.texts.item(0), null); const para = safe(()=>it.paragraphs && it.paragraphs.item(0), null); text.storyId = safe(()=>it.parentStory && it.parentStory.id, null); text.paragraphStyle = safe(()=>para && para.appliedParagraphStyle && para.appliedParagraphStyle.name, safe(()=>textStory && textStory.appliedParagraphStyle && textStory.appliedParagraphStyle.name, null)); text.characterStyle = safe(()=>range && range.appliedCharacterStyle && range.appliedCharacterStyle.name, null); text.fontFamily = safe(()=>range && range.appliedFont && range.appliedFont.fontFamily, safe(()=>firstChar && firstChar.appliedFont && firstChar.appliedFont.fontFamily, null)); text.fontStyle = safe(()=>range && range.fontStyle, safe(()=>firstChar && firstChar.fontStyle, null)); text.pointSize = safe(()=>range && range.pointSize, safe(()=>firstChar && firstChar.pointSize, null)); text.leading = safe(()=>range && range.leading, safe(()=>firstChar && firstChar.leading, null)); text.tracking = safe(()=>range && range.tracking, safe(()=>firstChar && firstChar.tracking, null)); text.justification = safe(()=>enumString(para && para.justification), null); } return text; }
        function imageInfoForItem(it, options){ const hasPlacedGraphic = safe(()=>it.graphics && len(it.graphics) > 0, false); if (!hasPlacedGraphic) return null; const info = { hasPlacedGraphic:true }; if (options && options.includeImageMetadata === true) { const g = safe(()=>at(it.graphics,0), null); const link = safe(()=>g && g.itemLink, null); info.linkName = safe(()=>link && link.name, null); info.linkPath = safe(()=>link && link.filePath, null); info.linkStatus = safe(()=>enumString(link && link.status), null); info.effectivePpi = safe(()=>g && g.effectivePpi, null); info.actualPpi = safe(()=>g && g.actualPpi, null); } return info; }
        function shapeInfoForItem(it, options){ const type = itemTypeName(it); const info = { shapeType:/Oval/i.test(type) ? 'oval' : /Polygon/i.test(type) ? 'polygon' : /GraphicLine/i.test(type) ? 'line' : /Rectangle|TextFrame/i.test(type) ? 'rectangle' : type, cornerRadius:safe(()=>it.topLeftCornerRadius, null) }; if (options && options.includePathPoints === true) { const path0 = safe(()=>it.paths && len(it.paths) ? at(it.paths,0) : null, null); if (path0) { info.pathPointCount = safe(()=>len(path0.pathPoints), 0); info.pathPoints = arr(path0.pathPoints, (pt)=>({ anchor:safe(()=>pt.anchor, null), leftDirection:safe(()=>pt.leftDirection, null), rightDirection:safe(()=>pt.rightDirection, null), pointType:safe(()=>enumString(pt.pointType), null) })); } } return info; }
        function baseItemInfo(it,i, options){ const layer = itemLayer(it); return { objectId:safe(()=>it.id), name:safe(()=>it.name), type:itemTypeName(it), index:i, zOrderIndex:safe(()=>it.index, null), pageIndex:pageIndexForItem(it), spreadIndex:spreadIndexForItem(it), layerName:safe(()=>layer && layer.name, null), layerId:safe(()=>layer && layer.id, null), layerVisible:safe(()=>layer && layer.visible, null), bounds:safe(()=>it.geometricBounds, null), geometricBounds:safe(()=>it.geometricBounds, null), rotation:safe(()=>it.rotationAngle, null), locked:safe(()=>it.locked, false), visible:safe(()=>it.visible, true), fillColor:swatchRef(safe(()=>it.fillColor, null)), strokeColor:swatchRef(safe(()=>it.strokeColor, null)), strokeWeight:safe(()=>it.strokeWeight, null), opacity:safe(()=>it.transparencySettings.blendingSettings.opacity, null), appliedObjectStyle:safe(()=>it.appliedObjectStyle && it.appliedObjectStyle.name, null), parentOrigin:safe(()=>it.overriddenMasterPageItem ? { objectId:it.overriddenMasterPageItem.id, name:it.overriddenMasterPageItem.name } : null, null), overridden:safe(()=>it.overridden, null), label:readLabel(it), text:textInfoForItem(it, options), image:imageInfoForItem(it, options), shape:shapeInfoForItem(it, options) }; }
        function itemInfoSummary(it,i, options){ const layer = itemLayer(it); const type = itemTypeName(it); const isText = /TextFrame/i.test(type); const hasGraphic = safe(()=>it.graphics && len(it.graphics) > 0, false); return { objectId:safe(()=>it.id), name:safe(()=>it.name), type, index:i, pageIndex:pageIndexForItem(it), spreadIndex:spreadIndexForItem(it), layerName:safe(()=>layer && layer.name, null), layerVisible:safe(()=>layer && layer.visible, null), locked:safe(()=>it.locked, false), visible:safe(()=>it.visible, true), bounds:safe(()=>it.geometricBounds, null), geometricBounds:safe(()=>it.geometricBounds, null), label:readLabel(it), text:isText ? { overset:!!safe(()=>it.overflows,false) } : null, image:hasGraphic ? { hasPlacedGraphic:true } : null }; }
        function itemInfoStandard(it,i, options){ return baseItemInfo(it, i, options); }
        function itemInfoDeep(it,i, options){ return baseItemInfo(it, i, options); }
        function inspectPageItemsBounded(options){ const warnings = []; const limit = clampInt(options.limit, 200, 1, 500); const offset = clampInt(options.offset, 0, 0, 2147483647); const candidates = getItemCandidates(options, warnings); const matched = []; for (let i=0;i<candidates.length;i++) { const it = candidates[i]; if (!itemMatchesCheapFilters(it, options)) continue; matched.push({ item: it, sourceIndex: i }); } const sliced = matched.slice(offset, offset + limit); const serializer = options.detailLevel === 'deep' ? itemInfoDeep : options.detailLevel === 'standard' ? itemInfoStandard : itemInfoSummary; const items = sliced.map((entry) => serializer(entry.item, entry.sourceIndex, options)); if (offset + items.length < matched.length) warnings.push({ code: 'RESULT_TRUNCATED', message: 'More matching page items are available; use offset/limit to paginate.' }); if (options.detailLevel === 'deep' && options.includePathPoints !== true) warnings.push({ code: 'PATH_POINTS_OMITTED', message: 'Path points are omitted unless includePathPoints=true.' }); return { items, pagination: { totalMatched: matched.length, returned: items.length, offset, limit, hasMore: offset + items.length < matched.length }, warnings }; }
        function dedupeItemsById(items){ const seen = {}; const out = []; for (let i=0;i<items.length;i++) { const it = items[i]; const id = idOf(it); const key = id == null ? 'index:' + i : 'id:' + id; if (seen[key]) continue; seen[key] = true; out.push(it); } return out; }
        function getItemCandidates(options, warnings){ if (options.pageIndex != null) { const page = at(doc.pages, options.pageIndex); if (!page) throw new Error('pageIndex out of range'); const items = arr(page.allPageItems || page.pageItems || [], x=>x); if (options.includeParentItems === true) return dedupeItemsById(items.concat(arr(safe(()=>page.masterPageItems, []), x=>x))); warnings.push({ code: 'MASTER_PAGE_ITEMS_OMITTED', message: 'Parent/master page items are omitted by default; set includeParentItems=true to include page.masterPageItems.' }); return items; } if (options.spreadIndex != null) { const spread = at(doc.spreads, options.spreadIndex); if (!spread) throw new Error('spreadIndex out of range'); return arr(spread.allPageItems || spread.pageItems || [], x=>x); } if (options.allowHeavyInspection !== true) throw new Error('inspect_page_items_v2 requires pageIndex or spreadIndex unless allowHeavyInspection=true'); warnings.push({ code: 'DOCUMENT_WIDE_ITEM_SOURCE', message: 'Document-wide item source used; scope page item inspection with pageIndex or spreadIndex when possible.' }); return arr(doc.allPageItems || doc.pageItems || [], x=>x); }
        function inspectStyles(){ return { styles: { paragraph: arr(doc.paragraphStyles, paragraphStyleInfo), character: arr(doc.characterStyles, characterStyleInfo), object: arr(doc.objectStyles, objectStyleInfo), table: arr(safe(()=>doc.tableStyles, []), (x,i)=>({index:i,id:safe(()=>x.id),name:safe(()=>x.name),basedOn:safe(()=>x.basedOn && x.basedOn.name,null),group:styleGroupName(x)})), cell: arr(safe(()=>doc.cellStyles, []), (x,i)=>({index:i,id:safe(()=>x.id),name:safe(()=>x.name),basedOn:safe(()=>x.basedOn && x.basedOn.name,null),group:styleGroupName(x)})) }, warnings: [] }; }
        function inspectSwatches(){ return { swatches: arr(doc.swatches, (x,i)=>({index:i, ...swatchRef(x), usageCount:null, usageCountAvailable:false})), warnings: [] }; }
        function inspectLayers(options){ return { layers: arr(doc.layers, (x,i)=>{ const layer = { index:i, id:safe(()=>x.id), name:safe(()=>x.name), visible:safe(()=>x.visible), locked:safe(()=>x.locked), printable:safe(()=>x.printable), color:safe(()=>enumString(x.layerColor), null) }; if (options && options.includeItemCounts === true) layer.itemCount = safe(()=>len(x.pageItems), null); return layer; }), warnings: [] }; }
        function inspectParentPages(options){ return { parentPages: arr(doc.masterSpreads || [], (m,i)=>parentPageInfo(m, i, options)), warnings: [] }; }
        function checkMissingLinks(){ const issues = []; for (let i=0;i<len(doc.links);i++) { const l = at(doc.links, i); const status = safe(()=>String(l.status), ''); if (!/normal|ok/i.test(status)) issues.push({ linkName:safe(()=>l.name), status, path:safe(()=>l.filePath) }); } return { check:'missing_links', ok: issues.length === 0, issues, warnings: [] }; }
        function checkMissingFonts(){ const issues = []; for (let i=0;i<len(doc.fonts);i++) { const f = at(doc.fonts, i); const status = safe(()=>String(f.status), ''); if (/missing|substitut/i.test(status)) issues.push({ fontName:safe(()=>f.name), status }); } return { check:'missing_fonts', ok: issues.length === 0, issues, warnings: [] }; }
        function checkOversetText(options){ const candidates = getItemCandidates(options, []); const matches = []; for (let i=0;i<candidates.length;i++) { const it = candidates[i]; if (!itemMatchesCheapFilters(it, options)) continue; if (!/TextFrame/i.test(itemTypeName(it))) continue; if (!safe(()=>it.overflows, false)) continue; const issue = { objectId:safe(()=>it.id), objectName:safe(()=>it.name), pageIndex:pageIndexForItem(it), summary: 'Text frame is overset' }; if (options && options.includeTextExcerpt === true) issue.textExcerpt = String(safe(()=>it.contents, '') || '').slice(0, 200); matches.push(issue); } const limit = clampInt(options.limit, 200, 1, 500); const offset = clampInt(options.offset, 0, 0, 2147483647); const issues = matches.slice(offset, offset + limit); const warnings = []; if (offset + issues.length < matches.length) warnings.push({ code: 'RESULT_TRUNCATED', message: 'More overset text matches are available; use offset/limit to paginate.' }); return { check:'overset_text', ok: matches.length === 0, issues, pagination: { totalMatched: matches.length, returned: issues.length, offset, limit, hasMore: offset + issues.length < matches.length }, warnings }; }
        function checkHiddenOrLockedProblemItems(options){ const candidates = getItemCandidates(options, []); const matches = []; for (let i=0;i<candidates.length;i++) { const it = candidates[i]; if (!itemMatchesNonVisibilityFilters(it, options)) continue; const label = readLabel(it) || {}; if ((label.source === 'agent_created' && (safe(()=>it.locked, false) || safe(()=>it.visible, true) === false)) || (label.referenceOnly && safe(()=>it.visible, true) !== false)) { matches.push({ objectId:safe(()=>it.id), objectName:safe(()=>it.name), summary:'Generated/reference item visibility or lock needs review' }); } } const limit = clampInt(options.limit, 200, 1, 500); const offset = clampInt(options.offset, 0, 0, 2147483647); const issues = matches.slice(offset, offset + limit); const warnings = []; if (offset + issues.length < matches.length) warnings.push({ code: 'RESULT_TRUNCATED', message: 'More hidden/locked matches are available; use offset/limit to paginate.' }); return { check:'hidden_or_locked_problem_items', ok: matches.length === 0, issues, pagination: { totalMatched: matches.length, returned: issues.length, offset, limit, hasMore: offset + issues.length < matches.length }, warnings }; }
        function runPreflight(options){ const warnings = []; const links = checkMissingLinks(); const fonts = checkMissingFonts(); const canRunItemChecks = options.pageIndex != null || options.spreadIndex != null || options.allowHeavyInspection === true; let overset = { check:'overset_text', ok:true, issues:[], skipped:true, warnings:[] }; let hiddenLocked = { check:'hidden_or_locked_problem_items', ok:true, issues:[], skipped:true, warnings:[] }; if (canRunItemChecks) { overset = checkOversetText(options); hiddenLocked = checkHiddenOrLockedProblemItems(options); } else { warnings.push('Heavy item checks were skipped; pass pageIndex, spreadIndex, or allowHeavyInspection=true to run overset and hidden/locked checks.'); } const checks = { missingLinks: links, missingFonts: fonts, oversetText: overset, hiddenOrLocked: hiddenLocked }; const issues = [...links.issues, ...fonts.issues, ...(overset.issues || []), ...(hiddenLocked.issues || [])]; return { ok: issues.length === 0, checks, issues, warnings: warnings.concat(links.warnings || [], fonts.warnings || [], overset.warnings || [], hiddenLocked.warnings || []) }; }
    `;
    return `${common}
        if (${q(name)} === 'inspect_page_items_v2') {
            const inspected = inspectPageItemsBounded(args);
            return { success:true, items:inspected.items, pagination:inspected.pagination, warnings:inspected.warnings };
        }
        if (${q(name)} === 'inspect_document_bundle') {
            const dp = doc.documentPreferences;
            if (args.includePageItems === true && args.allowHeavyInspection !== true) return { success:false, error:'inspect_document_bundle requires allowHeavyInspection=true when includePageItems=true' };
            if (args.includeParentPageItems === true && args.allowHeavyInspection !== true) return { success:false, error:'inspect_document_bundle requires allowHeavyInspection=true when includeParentPageItems=true' };
            const documentUnits = { horizontalMeasurementUnits:safe(()=>enumString(doc.viewPreferences.horizontalMeasurementUnits), null), verticalMeasurementUnits:safe(()=>enumString(doc.viewPreferences.verticalMeasurementUnits), null), rulerOrigin:safe(()=>enumString(doc.viewPreferences.rulerOrigin), null) };
            const document = { name:doc.name, path:expected, pageCount:len(doc.pages), facingPages:safe(()=>dp.facingPages, null), pageWidth:safe(()=>dp.pageWidth, null), pageHeight:safe(()=>dp.pageHeight, null), pageSize:safe(()=>dp.pageSize, null), pageOrientation:safe(()=>enumString(dp.pageOrientation), null), bleed:{ top:safe(()=>dp.documentBleedTopOffset, null), bottom:safe(()=>dp.documentBleedBottomOffset, null), insideOrLeft:safe(()=>dp.documentBleedInsideOrLeftOffset, null), outsideOrRight:safe(()=>dp.documentBleedOutsideOrRightOffset, null), uniform:safe(()=>dp.documentBleedUniformSize, null) }, slug:{ top:safe(()=>dp.slugTopOffset, null), bottom:safe(()=>dp.slugBottomOffset, null), insideOrLeft:safe(()=>dp.slugInsideOrLeftOffset, null), outsideOrRight:safe(()=>dp.slugRightOrOutsideOffset, null), uniform:safe(()=>dp.documentSlugUniformSize, null) }, documentUnits };
            const pages = arr(doc.pages, (p,i)=>pageInfo(p, i, args));
            const spreads = arr(doc.spreads, (s,i)=>spreadInfo(s, i, args));
            const bundle = { success:true, document, pageCount:len(doc.pages), pageSizes:pages.map(p=>({pageIndex:p.index, ...(p.pageSize||{})})), facingPages:document.facingPages, margins:pages.map(p=>({pageIndex:p.index, margins:p.marginPreferences})), bleed:document.bleed, slug:document.slug, spreads, pages, documentUnits, basicPreflightState:safe(()=>({ preflightOff:doc.preflightOptions.preflightOff }), null), warnings:[] };
            if (args.includeStyles !== false) bundle.styles = inspectStyles().styles;
            if (args.includeSwatches !== false) bundle.swatches = inspectSwatches().swatches;
            if (args.includeLayers !== false) bundle.layers = inspectLayers(args).layers;
            if (args.includeParents !== false) bundle.parentPages = inspectParentPages({ includePageItems:false, allowHeavyInspection:false, limit:args.limit, offset:args.offset }).parentPages;
            bundle.fonts = arr(doc.fonts,(f)=>({name:safe(()=>f.name),fontFamily:safe(()=>f.fontFamily,null),fontStyle:safe(()=>f.fontStyleName,null),status:safe(()=>String(f.status))}));
            bundle.links = arr(doc.links,(l)=>({name:safe(()=>l.name),status:safe(()=>String(l.status)),path:safe(()=>l.filePath)}));
            if (args.includePageItems === true) {
                bundle.pageItems = inspectPageItemsBounded({ ...args, allowHeavyInspection:true, detailLevel:args.detailLevel || 'summary' });
            }
            if (args.includeParentPageItems === true) {
                bundle.parentPages = inspectParentPages({ includePageItems:true, allowHeavyInspection:true, limit:args.limit, offset:args.offset }).parentPages;
            }
            return bundle;
        }
        if (${q(name)} === 'inspect_styles') return { success:true, ...inspectStyles() };
        if (${q(name)} === 'inspect_swatches') return { success:true, ...inspectSwatches() };
        if (${q(name)} === 'inspect_layers') return { success:true, ...inspectLayers(args) };
        if (${q(name)} === 'inspect_parent_pages') {
            if (args.includePageItems === true && args.allowHeavyInspection !== true) return { success:false, error:'inspect_parent_pages requires allowHeavyInspection=true when includePageItems=true' };
            return { success:true, ...inspectParentPages(args) };
        }
        if (${q(name)} === 'check_missing_links') return { success:true, ...checkMissingLinks() };
        if (${q(name)} === 'check_missing_fonts') return { success:true, ...checkMissingFonts() };
        if (${q(name)} === 'check_overset_text') {
            if (args.pageIndex == null && args.spreadIndex == null && args.allowHeavyInspection !== true) return { success:false, error:'check_overset_text requires pageIndex, spreadIndex, or allowHeavyInspection=true' };
            return { success:true, ...checkOversetText(args) };
        }
        if (${q(name)} === 'check_hidden_or_locked_problem_items') {
            if (args.pageIndex == null && args.spreadIndex == null && args.allowHeavyInspection !== true) return { success:false, error:'check_hidden_or_locked_problem_items requires pageIndex, spreadIndex, or allowHeavyInspection=true' };
            return { success:true, ...checkHiddenOrLockedProblemItems(args) };
        }
        if (${q(name)} === 'run_preflight' || ${q(name)} === 'run_template_preflight') {
            const preflight = runPreflight(args);
            return { success:true, ...preflight };
        }
        return { success:false, error:'Unsupported inspection/check tool: ${q(name)}' };
    `;
}

function buildCreateObjectScript() {
    return `
        function pagePresetSize(name) {
            const k = String(name || '').toLowerCase();
            if (k === 'a5') return { width: 148, height: 210, unit: 'mm' };
            if (k === 'a3') return { width: 297, height: 420, unit: 'mm' };
            if (k === 'square') return { width: 210, height: 210, unit: 'mm' };
            if (k === 'social_square') return { width: 1080, height: 1080, unit: 'pt' };
            return null;
        }
        function pageDims(args) {
            let w = args.pageWidth ?? args.width;
            let h = args.pageHeight ?? args.height;
            let u = args.unit || 'pt';
            const preset = pagePresetSize(args.pageSize);
            if (preset) { w = preset.width; h = preset.height; u = preset.unit; }
            if (w == null && h == null) return null;
            if (!(Number.isFinite(Number(w)) && Number.isFinite(Number(h)))) throw new Error('pageWidth/pageHeight must be finite numbers');
            w = toPt(Number(w), u); h = toPt(Number(h), u);
            if (w <= 0 || h <= 0) throw new Error('pageWidth/pageHeight must be positive');
            if (args.orientation === 'landscape' && h > w) { const t = w; w = h; h = t; }
            if (args.orientation === 'portrait' && w > h) { const t = w; w = h; h = t; }
            return { width:w, height:h };
        }
        function applyPageMargins(p,args) {
            if (args.marginTop == null && args.marginBottom == null && args.marginLeft == null && args.marginRight == null) return null;
            const m = p.marginPreferences;
            if (args.marginTop != null) m.top = toPt(Number(args.marginTop), args.unit || 'pt');
            if (args.marginBottom != null) m.bottom = toPt(Number(args.marginBottom), args.unit || 'pt');
            if (args.marginLeft != null) m.left = toPt(Number(args.marginLeft), args.unit || 'pt');
            if (args.marginRight != null) m.right = toPt(Number(args.marginRight), args.unit || 'pt');
            return { top:safe(()=>m.top), bottom:safe(()=>m.bottom), left:safe(()=>m.left), right:safe(()=>m.right) };
        }
        if (n === 'create_page') {
            const dims = pageDims(args);
            if (dims && !safe(()=>at(doc.pages,0).adjustLayout, null)) throw new Error('Page.adjustLayout is not available; cannot safely set per-page size');
            const p = doc.pages.add();
            try {
                if (args.name) p.name=args.name;
                if (args.derivativeId) { try { p.insertLabel(${q(LABEL_KEY)}, JSON.stringify({ derivativeId: args.derivativeId, role: 'derivative_page', source: 'mcp' })); } catch(e) { p.label = JSON.stringify({ derivativeId: args.derivativeId, role: 'derivative_page', source: 'mcp' }); } }
                if (dims) p.adjustLayout({ width:dims.width, height:dims.height });
                const margins = applyPageMargins(p,args);
                const bounds = clone(safe(()=>p.bounds));
                if (dims) {
                    const actual = boundsSize(bounds || [0,0,0,0]);
                    if (Math.abs(actual.width - dims.width) > 0.5 || Math.abs(actual.height - dims.height) > 0.5) {
                        const documentUnits = safe(() => ({
                            horizontalMeasurementUnits: String(doc.viewPreferences.horizontalMeasurementUnits),
                            verticalMeasurementUnits: String(doc.viewPreferences.verticalMeasurementUnits),
                            rulerOrigin: String(doc.viewPreferences.rulerOrigin)
                        }), null);
                        throw new Error('Geometry unit mismatch after create_page: requested ' + dims.width + 'x' + dims.height + 'pt, got ' + actual.width + 'x' + actual.height + ' from page.bounds. pageBounds=' + JSON.stringify(bounds) + '. documentUnits=' + JSON.stringify(documentUnits) + '. Refusing to continue because MCP geometry must be canonical pt.');
                    }
                }
                return { success:true, pageIndex:collectionIndexById(doc.pages, p), pageId:safe(()=>p.id), name:safe(()=>p.name), pageBounds:bounds, spreadIndex:collectionIndexById(doc.spreads, safe(()=>p.parent, null)), derivativeId:args.derivativeId||null, pageSize:safe(()=>({ width:p.bounds[3]-p.bounds[1], height:p.bounds[2]-p.bounds[0], unit:'pt' }), dims), margins };
            } catch (e) { try { p.remove(); } catch(_) {} throw e; }
        }
        if (n === 'duplicate_page') { const src=at(doc.pages,args.pageIndex||0); const p=src.duplicate(); return { success:true, pageIndex:collectionIndexById(doc.pages, p), pageId:safe(()=>p.id), name:safe(()=>p.name), pageBounds:clone(safe(()=>p.bounds)), spreadIndex:collectionIndexById(doc.spreads, safe(()=>p.parent, null)), derivativeId:args.derivativeId||null, pageSize:safe(()=>({ width:p.bounds[3]-p.bounds[1], height:p.bounds[2]-p.bounds[0], unit:'pt' }), null) }; }
        if (n === 'create_text_frame') { if (args.pageIndex == null) throw new Error('pageIndex is required'); const p=pageByIndex(args.pageIndex); const resolved = resolveBoundsForPage(args); const boundsValidation = validateBoundsOnPage(resolved.documentBounds, resolved.pageBounds, args); const layer = writableLayer(args.layerName || 'AGENT_WORK'); it=p.textFrames.add(); it.itemLayer = layer; it.geometricBounds=resolved.documentBounds; it.contents=args.text||args.content||''; applyBasics(it,args); applyTextStyles(it,args); return { success:true, ...meta(it), unit:'pt', coordinateSpace:resolved.coordinateSpace, localBounds:resolved.localBounds, documentBounds:resolved.documentBounds, pageBounds:resolved.pageBounds, boundsValidation, text:textExcerpt(it) }; }
        if (n === 'create_image_frame' || n === 'create_shape') { if (args.pageIndex == null) throw new Error('pageIndex is required'); const p=pageByIndex(args.pageIndex); const resolved = resolveBoundsForPage(args); const boundsValidation = validateBoundsOnPage(resolved.documentBounds, resolved.pageBounds, args); const layer = writableLayer(args.layerName || 'AGENT_WORK'); const type=args.shapeType||'rectangle'; it=(type==='oval'?p.ovals:type==='polygon'?p.polygons:p.rectangles).add(); it.itemLayer = layer; it.geometricBounds=resolved.documentBounds; applyBasics(it,args); if(n==='create_image_frame' && args.imagePath){ it.place(args.imagePath, false); if (args.fitMode) applyFitMode(it, args.fitMode); } return { success:true, ...meta(it), unit:'pt', coordinateSpace:resolved.coordinateSpace, localBounds:resolved.localBounds, documentBounds:resolved.documentBounds, pageBounds:resolved.pageBounds, boundsValidation, hasPlacedGraphic:!!linkInfo(it), link:linkInfo(it) }; }
        if (n === 'create_line') { if (args.pageIndex == null) throw new Error('pageIndex is required'); const p=pageByIndex(args.pageIndex); const layer = writableLayer(args.layerName || 'AGENT_WORK'); const start = resolvePointForPage(args, args.start); const end = resolvePointForPage(args, args.end); it=p.graphicLines.add(); it.itemLayer = layer; it.paths.item(0).entirePath=[start.documentPoint,end.documentPoint]; applyBasics(it,args); const lineBounds = clone(safe(()=>it.geometricBounds, null)); const boundsValidation = lineBounds ? validateBoundsOnPage(lineBounds, start.pageBounds, { ...args, rejectOutOfPageBounds: args.rejectOutOfPageBounds !== false }) : { ok:true, outsideRatio:0, intersectsPage:true, warnings:[] }; return { success:true, ...meta(it), unit:'pt', coordinateSpace:start.coordinateSpace, localStart:start.localPoint, localEnd:end.localPoint, documentStart:start.documentPoint, documentEnd:end.documentPoint, pageBounds:start.pageBounds, boundsValidation }; }
    `;
}

function buildGeometryScript() {
    return `
        if (n === 'set_text_content') { it=resolveItem(args); const result = replaceTextFrameContentsSafely(it, args.text, { preserveStyle: args.preserveStyle, textReplacePolicy: args.textReplacePolicy, expectedOldTextExcerpt: args.expectedOldTextExcerpt }); return { success:true, ...result, ...meta(it), text:textExcerpt(it), warnings:[...(result.warnings || []), 'set_text_content uses safe text replacement'] }; }
        if (n === 'set_bounds' || n === 'resize_item') { if(n==='resize_item' && args.delta) throw new Error('resize_item does not accept delta; use move_item for delta moves'); if(!args.bounds) throw new Error('bounds are required'); it=resolveItem(args); old=clone(safe(()=>it.geometricBounds)); const targetPageIndex = args.pageIndex != null ? args.pageIndex : pageIndexOf(it); if ((args.coordinateSpace || 'page') === 'page' && targetPageIndex == null) throw new Error('pageIndex is required when target object has no parentPage'); const resolved = resolveBoundsForPage(args, targetPageIndex); const validatedTarget = setBoundsSmart(it, resolved.documentBounds, { preserveCenter:args.preserveCenter, preserveAspectRatio:args.preserveAspectRatio, anchor:args.anchor, roundTo:args.roundTo }); const boundsValidation = validateBoundsOnPage(validatedTarget, resolved.pageBounds, args); return { success:true, objectId:safe(()=>it.id), oldBounds:old, newBounds:validatedTarget, localBounds:resolved.localBounds, documentBounds:validatedTarget, pageBounds:resolved.pageBounds, coordinateSpace:resolved.coordinateSpace, boundsValidation, unit:'pt', ...(args.returnBeforeAfter ? { before:old, after:clone(safe(()=>it.geometricBounds)) } : {}) }; }
        if (n === 'move_item') { if(!args.delta) throw new Error('delta is required'); it=resolveItem(args); old=clone(safe(()=>it.geometricBounds)); const dy=toPt(args.delta[0]||0,args.unit), dx=toPt(args.delta[1]||0,args.unit); const b=[old[0]+dy, old[1]+dx, old[2]+dy, old[3]+dx]; const next = setBoundsRaw(it, b); const targetPageIndex = args.pageIndex != null ? args.pageIndex : pageIndexOf(it); const pb = targetPageIndex == null ? null : pageBounds(targetPageIndex); const boundsValidation = pb ? validateBoundsOnPage(next, pb, args) : null; return { success:true, objectId:safe(()=>it.id), oldBounds:old, newBounds:next, pageBounds:pb, boundsValidation, unit:'pt' }; }
        if (n === 'rotate_item') { it=resolveItem(args); old=safe(()=>it.rotationAngle,0); it.rotationAngle=args.degrees||0; return { success:true, objectId:safe(()=>it.id), oldRotation:old, newRotation:safe(()=>it.rotationAngle) }; }
        if (n === 'lock_item' || n === 'unlock_item') { it=resolveItem(args); it.locked=n==='lock_item'; return { success:true, ...meta(it) }; }
        if (n === 'rename_page_item') { if (!args.newName) throw new Error('newName is required'); it=resolveItem(args); old=safe(()=>it.name); it.name=cleanName(args.newName); return { success:true, objectId:safe(()=>it.id), oldName:old, newName:safe(()=>it.name), name:safe(()=>it.name) }; }
    `;
}

function buildStyleScript() {
    return `
        if (n === 'bring_to_front' || n === 'send_to_back') { it=resolveItem(args); old=safe(()=>it.geometricBounds); if(n==='bring_to_front') it.bringToFront(); else it.sendToBack(); return { success:true, action:n, oldBounds:old, ...meta(it), warnings:['Docs-verified; pending live UXP validation'] }; }
        if (n === 'fit_content_to_frame' || n === 'fit_frame_to_content') { const { FitOptions } = require('indesign'); it=resolveItem(args); old=safe(()=>it.geometricBounds); const mode=n==='fit_content_to_frame'?FitOptions.CONTENT_TO_FRAME:FitOptions.FRAME_TO_CONTENT; it.fit(mode); return { success:true, action:n, fitMode:n==='fit_content_to_frame'?'CONTENT_TO_FRAME':'FRAME_TO_CONTENT', oldBounds:old, ...meta(it), warnings:['Docs-verified; pending live UXP validation'] }; }
        if (n === 'apply_swatches') { it=resolveItem(args); const applied={}, warnings=[]; if(args.fillSwatch){ it.fillColor=named(doc.swatches,args.fillSwatch,'Swatch'); applied.fillSwatch=args.fillSwatch; } if(args.strokeSwatch){ it.strokeColor=named(doc.swatches,args.strokeSwatch,'Swatch'); applied.strokeSwatch=args.strokeSwatch; } if(args.strokeWeight!=null){ it.strokeWeight=args.strokeWeight; applied.strokeWeight=args.strokeWeight; } const text=safe(()=>it.texts.item(0)); if(text && text.isValid!==false){ if(args.textFillSwatch){ text.fillColor=named(doc.swatches,args.textFillSwatch,'Swatch'); applied.textFillSwatch=args.textFillSwatch; } if(args.textStrokeSwatch){ text.strokeColor=named(doc.swatches,args.textStrokeSwatch,'Swatch'); applied.textStrokeSwatch=args.textStrokeSwatch; } } else if(args.textFillSwatch || args.textStrokeSwatch) warnings.push('Text swatch requested but object has no text content'); return { success:true, action:n, applied, ...meta(it), warnings }; }
        if (n === 'apply_styles') { it=resolveItem(args); const applied={}, warnings=[]; const clear=args.clearOverrides===true; const text=safe(()=>it.texts.item(0)); if(args.paragraphStyle){ const s=named(doc.paragraphStyles,args.paragraphStyle,'Paragraph style'); if(text && text.isValid!==false){ if(text.applyParagraphStyle) text.applyParagraphStyle(s, clear); else text.appliedParagraphStyle=s; applied.paragraphStyle=args.paragraphStyle; } else warnings.push('Paragraph style requested but object has no text content'); } if(args.characterStyle){ const s=named(doc.characterStyles,args.characterStyle,'Character style'); if(text && text.isValid!==false){ if(text.applyCharacterStyle) text.applyCharacterStyle(s); else text.appliedCharacterStyle=s; applied.characterStyle=args.characterStyle; } else warnings.push('Character style requested but object has no text content'); } if(args.objectStyle){ const s=named(doc.objectStyles,args.objectStyle,'Object style'); if(it.applyObjectStyle) it.applyObjectStyle(s, clear, false); else it.appliedObjectStyle=s; applied.objectStyle=args.objectStyle; } return { success:true, action:n, applied, clearOverrides:clear, ...meta(it), warnings }; }
        if (n === 'group_items') { const items=resolveItems(args); const parent=safe(()=>items[0].parentPage, null) || safe(()=>items[0].parent, null) || doc; const g=parent.groups.add(items); if(args.name) g.name=args.name; if(args.label) writeLabel(g,args.label); return { success:true, action:n, group:meta(g), childIds:items.map(x=>safe(()=>x.id)), warnings:['Plain item arrays/common parent are pending live UXP validation'] }; }
        if (n === 'ungroup_items') { it=resolveItem(args); const kids=arr(it.allPageItems||[], x=>safe(()=>x.id)); it.ungroup(); return { success:true, action:n, objectId:args.objectId||null, childIds:kids, warnings:['Pending live UXP validation'] }; }
    `;
}

function buildLabelScript() {
    return `
        if (n === 'label_object') { it=resolveItem(args); const label=args.merge===false?args.label:{...readLabel(it),...(args.label||{})}; writeLabel(it,label); return { success:true, objectId:safe(()=>it.id), label }; }
        if (n === 'get_object_label') { it=resolveItem(args); return { success:true, objectId:safe(()=>it.id), label:readLabel(it) }; }
        if (n === 'find_objects_by_label' || n === 'list_named_objects') { const query=args.labelQuery||null; const hits=arr(doc.allPageItems||doc.pageItems,(x)=>({ ...itemSnapshot(x), visible:safe(()=>x.visible,true) })).filter(x=>(args.includeHidden || x.visible!==false) && (!args.namePrefix || String(x.name||'').startsWith(args.namePrefix)) && (args.pageIndex == null || x.pageIndex === args.pageIndex) && (!query || labelMatches(x.label, query))); return { success:true, objects:hits }; }
    `;
}

function buildAlignDistributeScript() {
    return `
        if (n === 'align_items') { const { AlignOptions, AlignDistributeBounds } = require('indesign'); const items=resolveItems(args); const before=items.map(x=>({objectId:safe(()=>x.id), bounds:safe(()=>x.geometricBounds)})); const alignMap={left:'LEFT_EDGES',right:'RIGHT_EDGES',top:'TOP_EDGES',bottom:'BOTTOM_EDGES',centerX:'HORIZONTAL_CENTERS',centerY:'VERTICAL_CENTERS'}; const boundsMap={page:'PAGE_BOUNDS',spread:'SPREAD_BOUNDS',selection:'ITEM_BOUNDS',itemsBoundingBox:'ITEM_BOUNDS',referenceObject:'KEY_OBJECT'}; const opt=AlignOptions[alignMap[args.mode]||args.mode]; const bound=AlignDistributeBounds[boundsMap[args.alignTo]||'ITEM_BOUNDS']; const ref=args.referenceObjectId?itemById(args.referenceObjectId):undefined; doc.align(items,opt,bound,ref); return { success:true, action:n, mode:args.mode, alignTo:args.alignTo||'itemsBoundingBox', before, after:items.map(x=>({objectId:safe(()=>x.id), bounds:safe(()=>x.geometricBounds)})), warnings:['Legacy native align fallback; deterministic handler should be preferred'] }; }
        if (n === 'distribute_items') { const { DistributeOptions, AlignDistributeBounds } = require('indesign'); const items=resolveItems(args); const before=items.map(x=>({objectId:safe(()=>x.id), bounds:safe(()=>x.geometricBounds)})); const distMap={horizontal:'HORIZONTAL_SPACE',vertical:'VERTICAL_SPACE'}; const boundsMap={page:'PAGE_BOUNDS',spread:'SPREAD_BOUNDS',itemsBoundingBox:'ITEM_BOUNDS'}; const opt=DistributeOptions[distMap[args.axis]||args.mode||args.axis]; const bound=AlignDistributeBounds[boundsMap[args.within]||'ITEM_BOUNDS']; doc.distribute(items,opt,bound,args.fixedSpacing!=null,args.fixedSpacing||0); return { success:true, action:n, axis:args.axis, before, after:items.map(x=>({objectId:safe(()=>x.id), bounds:safe(()=>x.geometricBounds)})), warnings:['Legacy native distribute fallback; deterministic handler should be preferred'] }; }
    `;
}

function layoutAndLabels(name) {
    return `
        const n = ${q(name)};
        let it, old;
        ${buildCreateObjectScript()}
        ${buildGeometryScript()}
        ${buildStyleScript()}
        ${buildLabelScript()}
        ${buildAlignDistributeScript()}
        if (n === 'create_reference_underlay' || n === 'hide_reference_underlay' || n === 'remove_reference_underlay') return { success:false, error:n+' should have been handled before generic template dispatch.' };
        return { success:false, error:'Template tool not implemented: '+n };
    `;
}
