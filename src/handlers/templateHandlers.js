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

const LABEL_KEY = 'mcpTemplateLabel';

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
        function documentsCollection() {
            try { return app.documents || []; } catch (e) { return []; }
        }
        function documentCount(coll) {
            try { return Number(coll && coll.length) || 0; } catch (e) { return 0; }
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
        const documents = documentsCollection();
        const count = documentCount(documents);
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
        function validateBoundsOnPage(documentBounds, pageBounds, args) { const warnings = []; const reject = args.rejectOutOfPageBounds !== false; const maxOutsideRatio = args.maxOutsidePageRatio == null ? 0.25 : Number(args.maxOutsidePageRatio); if (!Array.isArray(documentBounds) || documentBounds.length !== 4) throw new Error('documentBounds must be [top,left,bottom,right]'); if (documentBounds.some((v) => !Number.isFinite(Number(v)))) throw new Error('documentBounds must contain finite numbers'); if (documentBounds[2] <= documentBounds[0] || documentBounds[3] <= documentBounds[1]) throw new Error('documentBounds must have positive width and height'); const pageWidth = pageBounds[3] - pageBounds[1]; const pageHeight = pageBounds[2] - pageBounds[0]; const itemWidth = documentBounds[3] - documentBounds[1]; const itemHeight = documentBounds[2] - documentBounds[0]; if (itemWidth < 0.5 || itemHeight < 0.5) throw new Error('Object bounds are implausibly small'); if (itemWidth > pageWidth * 3 || itemHeight > pageHeight * 3) throw new Error('Object bounds are implausibly large relative to page'); const intersection = intersectBounds(documentBounds, pageBounds); if (!intersection) { if (reject) throw new Error('Object bounds do not intersect target page'); warnings.push('Object bounds do not intersect target page'); } const itemArea = rectArea(documentBounds); const insideArea = intersection ? rectArea(intersection) : 0; const outsideRatio = itemArea > 0 ? 1 - insideArea / itemArea : 1; if (outsideRatio > maxOutsideRatio) { const msg = 'Object is mostly outside target page: outsideRatio=' + outsideRatio; if (reject) throw new Error(msg); warnings.push(msg); } return { ok: warnings.length === 0, outsideRatio, intersectsPage: !!intersection, warnings }; }
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
            function nativePath(v) { try { return v ? String(v.nativePath || v.fsName || v) : ''; } catch(e) { return ''; } }
            function joinDocPath(basePath, docName) { const base = String(basePath || '').replace(/[\\/]+$/, ''); if (!base) return ''; return base + '/' + docName; }
            function normalizeDocPath(rawPath, docName) { const base = nativePath(rawPath); const name = String(docName || ''); if (!base) return ''; if (name && !/\.indd$/i.test(base)) return joinDocPath(base, name); return base; }
            try {
                const doc = app.documents.length ? app.activeDocument : null;
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
            } catch(e) {}
            return { ok: activeDocumentPath === expected, activeDocumentPath, workingCopyPath: expected, pathReadWarnings };
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
            if (args.returnImage !== false) {
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
            const review = { reviewId: `review_${Date.now()}`, derivativeId: args.derivativeId, targetPreviewId: args.targetPreviewId || null, indesignPreviewId: args.indesignPreviewId || null, brief: args.brief || '', issues: args.issues || [], suggestedFixes: args.suggestedFixes || [], timestamp: new Date().toISOString() };
            fs.appendFileSync(assertWorkspacePath(path.join(m.workspaceRoot, 'logs', 'visual_reviews.jsonl'), { kind: 'logs', manifest: m }).path, `${JSON.stringify(review)}\n`);
            upsertDerivative(m, args.derivativeId, { latestReviewId: review.reviewId, outstandingIssueCount: review.issues.length });
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
            if (args.duplicateBaseMotifs) {
                const dupe = await this.duplicate_items_to_page({
                    sourceLabelQueries: [{ editable: true }],
                    sourcePageIndex: basePageIndex,
                    targetPageIndex: created.pageIndex,
                    preserveRelativePositions: true,
                    labelPatch: { derivativeId: args.derivativeId, duplicatedFromBasePageIndex: basePageIndex }
                });
                duplicatedMotifs = dupe.duplicatedObjects;
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
                ...(duplicatedMotifs.length ? { duplicatedMotifs } : {})
            };
        })(), 'create_derivative_page');
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
            const sourceItems = collectSourceItems();
            if (!sourceItems.length) throw new Error('No source items matched');
            const targetPage = pageByIndex(args.targetPageIndex);
            const offset = Array.isArray(args.offset) ? [toPt(Number(args.offset[0] || 0), 'pt'), toPt(Number(args.offset[1] || 0), 'pt')] : [0,0];
            const scale = args.scale == null ? 1 : Number(args.scale);
            const duplicatedObjects = [];
            for (const source of sourceItems) {
                const duplicate = source.duplicate(targetPage);
                const before = clone(safe(()=>duplicate.geometricBounds));
                let after = before;
                if (after && args.preserveRelativePositions !== false) {
                    const top = before[0] + offset[0], left = before[1] + offset[1], width = widthOf(before) * scale, height = heightOf(before) * scale;
                    after = [top, left, top + height, left + width];
                    setBoundsRaw(duplicate, after);
                }
                if (args.renamePrefix) duplicate.name = String(args.renamePrefix) + (safe(()=>source.name) || safe(()=>source.id));
                const label = Object.assign({}, readLabel(duplicate), args.labelPatch || {});
                writeLabel(duplicate, label);
                duplicatedObjects.push({ sourceObjectId:safe(()=>source.id), objectId:safe(()=>duplicate.id), name:safe(()=>duplicate.name), type:safe(()=>duplicate.constructor.name), pageIndex:args.targetPageIndex, bounds:clone(safe(()=>duplicate.geometricBounds)), label });
            }
            return { success:true, duplicatedObjects };
        `), 'duplicate_items_to_page');
    }

    static create_text_slot(args = {}) {
        return response((async () => {
            if (!args.derivativeId || !args.role || !args.slot || args.pageIndex == null || !args.bounds || args.text == null) throw new Error('derivativeId, role, slot, pageIndex, bounds, and text are required');
            const label = shallowMergeLabel({ derivativeId: args.derivativeId, role: args.role, slot: args.slot, source: 'agent_created', editable: true, placeholder: false }, args.label);
            const created = await this.uxpTool('create_text_frame', {
                ...args,
                name: args.name || `${args.derivativeId}__${args.role}__text`,
                label,
                text: String(args.text)
            });
            let fitResult = null;
            if (args.autoFit) fitResult = await this.fit_text_to_frame({ objectId: created.objectId });
            return { ...created, label, ...(fitResult ? { fitResult } : {}) };
        })(), 'create_text_slot');
    }

    static create_image_slot(args = {}) {
        return response((async () => {
            if (!args.derivativeId || !args.role || !args.slot || args.pageIndex == null || !args.bounds) throw new Error('derivativeId, role, slot, pageIndex, and bounds are required');
            const manifest = loadWorkspace();
            const imagePath = args.imagePath ? resolveWorkspaceImagePath(args.imagePath, manifest) : null;
            const label = shallowMergeLabel({ derivativeId: args.derivativeId, role: args.role, slot: args.slot, source: 'agent_created', editable: true, placeholder: !imagePath && args.placeholder !== false }, args.label);
            return this.uxpTool('create_image_frame', {
                ...args,
                imagePath,
                placeholder: !imagePath && args.placeholder !== false,
                name: args.name || `${args.derivativeId}__${args.role}__image_frame`,
                label
            });
        })(), 'create_image_slot');
    }

    static fit_text_to_frame(args = {}) {
        return response(runGuarded(`${jsHelpers()} const args=${q(args)};
            const it = resolveItem(args);
            if (!/TextFrame/i.test(String(safe(()=>it.constructor.name,'')))) throw new Error('Target is not a text frame');
            const actions = ['heuristic'];
            function firstTextRange(){ return safe(()=>it.texts.item(0), null) || safe(()=>it.parentStory.texts.item(0), null); }
            function state(){ const t = firstTextRange(); return { pointSize:Number(safe(()=>t.pointSize, 0) || 0), leading:Number(safe(()=>t.leading, 0) || 0), tracking:Number(safe(()=>t.tracking, 0) || 0), bounds:clone(safe(()=>it.geometricBounds)), overset:!!safe(()=>it.overflows,false) }; }
            function applyPointSize(value){ const t = firstTextRange(); if (t) t.pointSize = value; }
            function applyLeading(value){ const t = firstTextRange(); if (t) t.leading = value; }
            function applyTracking(value){ const t = firstTextRange(); if (t) t.tracking = value; }
            const before = state();
            const minPointSize = Number(args.minPointSize ?? 6);
            const maxPointSize = Number(args.maxPointSize ?? before.pointSize || 72);
            const minLeading = Number(args.minLeading ?? Math.max(6, before.leading || before.pointSize || 6));
            const minTracking = Number(args.minTracking ?? -50);
            const maxIterations = Number(args.maxIterations ?? 12);
            let iterations = 0;
            while (safe(()=>it.overflows,false) && iterations < maxIterations) {
                iterations += 1;
                const current = state();
                if (current.pointSize > minPointSize) { applyPointSize(Math.max(minPointSize, current.pointSize - 1)); actions.push('reduce_point_size'); continue; }
                if (current.leading > minLeading) { applyLeading(Math.max(minLeading, current.leading - 1)); actions.push('reduce_leading'); continue; }
                if (args.allowTrackingTighten && current.tracking > minTracking) { applyTracking(Math.max(minTracking, current.tracking - 5)); actions.push('tighten_tracking'); continue; }
                if (args.allowFrameGrow) {
                    const maxGrowPt = args.maxGrowMm != null ? toPt(Number(args.maxGrowMm), args.unit || 'mm') : toPt(10, 'mm');
                    const currentBounds = clone(it.geometricBounds);
                    const growth = Math.min(maxGrowPt, toPt(2, 'mm'));
                    const nextBounds = (args.growAnchor || 'topLeft') === 'center'
                        ? [currentBounds[0] - growth / 2, currentBounds[1] - growth / 2, currentBounds[2] + growth / 2, currentBounds[3] + growth / 2]
                        : [currentBounds[0], currentBounds[1], currentBounds[2] + growth, currentBounds[3] + growth];
                    setBoundsRaw(it, nextBounds); actions.push('grow_frame'); continue;
                }
                break;
            }
            const after = state();
            return { success:true, objectId:safe(()=>it.id), before, after, actions };
        `), 'fit_text_to_frame');
    }

    static export_derivative_preview(args = {}) {
        return response((async () => {
            if (!args.derivativeId && args.pageIndex == null) throw new Error('derivativeId or pageIndex is required');
            const resolved = args.derivativeId ? unwrapToolResult(await this.resolve_derivative_page({ derivativeId: args.derivativeId })) : { pageIndex: args.pageIndex, pageId: null };
            const manifest = loadWorkspace();
            const ext = (args.format || 'png').toLowerCase() === 'jpg' ? 'jpg' : 'png';
            const derivativeId = args.derivativeId || this.resolveDerivativeRecord(manifest, { pageIndex: resolved.pageIndex }).derivativeId;
            const existing = (manifest.previews || []).filter((preview) => preview.derivativeId === derivativeId && preview.pageIndex === resolved.pageIndex);
            const outputName = normalizePreviewOutputName(
                args.outputName,
                ext,
                `${derivativeId}__${resolved.pageIndex}__preview_${String(existing.length + 1).padStart(3, '0')}`
            );
            const rec = unwrapToolResult(await this.exportPreview('page', { ...args, derivativeId, pageIndex: resolved.pageIndex, format: ext, outputName, overwrite: args.overwrite }));
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
        return response(runGuarded(`${jsHelpers()} const args=${q(args)};
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
                    if (edit.setBounds) {
                        const targetPageIndex = edit.pageIndex != null ? edit.pageIndex : pageIndexOf(it);
                        if ((edit.coordinateSpace || 'page') === 'page' && targetPageIndex == null) throw new Error('pageIndex is required when target object has no parentPage');
                        const resolved = resolveBoundsForPage({ ...edit, bounds: edit.setBounds }, targetPageIndex);
                        const nextBounds = setBoundsSmart(it, resolved.documentBounds, { preserveCenter:edit.preserveCenter, preserveAspectRatio:edit.preserveAspectRatio, anchor:edit.anchor, roundTo:edit.roundTo });
                        validateBoundsOnPage(nextBounds, resolved.pageBounds, edit);
                        actions.push('setBounds');
                    }
                    if (edit.setText != null) { it.contents = String(edit.setText); actions.push('setText'); }
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
                    edited.push({ objectId:safe(()=>it.id), name:safe(()=>it.name), before, after:itemSnapshot(it), actions });
                } catch (error) {
                    if (mode === 'fail_fast') throw error;
                    errors.push({ edit, error:String(error.message || error) });
                }
            }
            return { success:true, derivativeId:args.derivativeId, edited, ...(errors.length ? { errors } : {}) };
        `), 'apply_layout_recipe');
    }

    static set_bounds(args = {}) {
        return response(this.uxpTool('set_bounds', args), 'set_bounds');
    }

    static align_items(args = {}) {
        return response(runGuarded(`${jsHelpers()} const args=${q(args)};
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
            const target = targetBounds();
            for (const item of items) {
                const bounds = clone(item.geometricBounds);
                const width = widthOf(bounds), height = heightOf(bounds);
                let next = clone(bounds);
                if (args.mode === 'left') next = [bounds[0], target[1], bounds[0] + height, target[1] + width];
                else if (args.mode === 'right') next = [bounds[0], target[3] - width, bounds[0] + height, target[3]];
                else if (args.mode === 'top') next = [target[0], bounds[1], target[0] + height, bounds[1] + width];
                else if (args.mode === 'bottom') next = [target[2] - height, bounds[1], target[2], bounds[1] + width];
                else if (args.mode === 'centerX') { const cx = centerXOf(target); next = [bounds[0], cx - width / 2, bounds[2], cx + width / 2]; }
                else if (args.mode === 'centerY') { const cy = centerYOf(target); next = [cy - height / 2, bounds[1], cy + height / 2, bounds[3]]; }
                else throw new Error('Unsupported align mode');
                setBoundsRaw(item, next);
            }
            return { success:true, mode:args.mode, alignTo:args.alignTo, before, after:items.map(itemSnapshot) };
        `), 'align_items');
    }

    static distribute_items(args = {}) {
        return response(runGuarded(`${jsHelpers()} const args=${q(args)};
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
            return { success:true, axis, mode, before, after:items.map(itemSnapshot) };
        `), 'distribute_items');
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

    static update_text_slot(args = {}) {
        return response((async () => {
            if (args.text == null) throw new Error('text is required');
            const updated = await runGuarded(`${jsHelpers()} const args=${q(args)};
                const it = resolveItem(args);
                const prior = /TextFrame/i.test(String(safe(()=>it.constructor.name,''))) ? clone(itemSnapshot(it)) : null;
                const textStyles = prior && args.preserveStyle !== false ? { paragraphStyle:safe(()=>it.paragraphs.item(0).appliedParagraphStyle.name, null), characterStyle:safe(()=>it.textStyleRanges.item(0).appliedCharacterStyle.name, null) } : null;
                it.contents = String(args.text);
                if (textStyles) applyTextStyles(it, textStyles);
                return { success:true, objectId:safe(()=>it.id), name:safe(()=>it.name), text:textExcerpt(it) };
            `);
            let fitResult = null;
            if (args.fit) fitResult = await this.fit_text_to_frame({ objectId: updated.objectId });
            return { ...updated, ...(fitResult ? { fitResult } : {}) };
        })(), 'update_text_slot');
    }

    static move_resize_items(args = {}) {
        return response(runGuarded(`${jsHelpers()} const args=${q(args)};
            const items = resolveItems(args);
            const before = items.map(itemSnapshot);
            const offset = Array.isArray(args.offset) ? [toPt(Number(args.offset[0] || 0), args.unit || 'pt'), toPt(Number(args.offset[1] || 0), args.unit || 'pt')] : [0,0];
            const scale = args.scale == null ? 1 : Number(args.scale);
            const targetPageIndex = args.pageIndex != null ? args.pageIndex : pageIndexOf(items[0]);
            if (args.targetBox && (args.coordinateSpace || 'page') === 'page' && targetPageIndex == null) throw new Error('pageIndex is required when target items have no parentPage');
            const resolvedTarget = args.targetBox ? resolveBoundsForPage({ ...args, bounds: args.targetBox }, targetPageIndex) : null;
            const targetBox = resolvedTarget ? resolvedTarget.documentBounds : null;
            const sourceBox = (()=>{ const bounds = items.map((it)=>clone(it.geometricBounds)); return [Math.min.apply(null,bounds.map((b)=>b[0])), Math.min.apply(null,bounds.map((b)=>b[1])), Math.max.apply(null,bounds.map((b)=>b[2])), Math.max.apply(null,bounds.map((b)=>b[3]))]; })();
            for (const item of items) {
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
            return { success:true, before, after:items.map(itemSnapshot), pageBounds:targetPageIndex != null ? pageBounds(targetPageIndex) : null, coordinateSpace:args.coordinateSpace || 'page' };
        `), 'move_resize_items');
    }

    static create_vector_motif(args = {}) {
        return response(runGuarded(`${jsHelpers()} const args=${q(args)};
            if (!args.derivativeId || args.pageIndex == null || !args.motifId) throw new Error('derivativeId, pageIndex, and motifId are required');
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
            return { success:true, motifId:args.motifId, objectIds:created.map((item)=>safe(()=>item.id)), objects:created.map((item)=>({ objectId:safe(()=>item.id), shapeType:safe(()=>item.constructor.name), localBounds:safe(()=>item.__localBounds, null), documentBounds:safe(()=>item.__documentBounds, safe(()=>item.geometricBounds, null)), pageBounds:safe(()=>item.__pageBounds, null), boundsValidation:safe(()=>item.__boundsValidation, null) })), ...(groupId ? { groupId } : {}) };
        `), 'create_vector_motif');
    }

    static inspect_layout_grid(args = {}) {
        return response((async () => {
            const items = await this.uxpTool('inspect_page_items_v2', { pageIndex: args.pageIndex ?? 0, includeHidden: args.includeHidden === true, detailLevel: 'summary', limit: args.limit ?? 500, includeTextExcerpt: false, includeTextMetadata: false, includeImageMetadata: false, includePathPoints: false });
            const bundle = await this.uxpTool('inspect_document_bundle', {});
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
            const pageIndex = args.pageIndex ?? 0;
            const bundle = await this.uxpTool('inspect_document_bundle', {});
            const items = args.includeItems === false ? { items: [] } : await this.uxpTool('inspect_page_items_v2', { pageIndex, includeHidden: false, includeTextExcerpt: false, includeTextMetadata: true, includeImageMetadata: false, includePathPoints: false, detailLevel: 'standard', limit: args.limit ?? 500 });
            const grid = args.includeGrid ? await this.inspect_layout_grid({ pageIndex, limit: args.limit }) : null;
            const visibleItems = items.items || [];
            const fontCounts = new Map();
            const geometryCounts = new Map();
            for (const item of visibleItems) {
                if (item.text?.fontFamily) fontCounts.set(item.text.fontFamily, (fontCounts.get(item.text.fontFamily) || 0) + 1);
                if (item.bounds) {
                    const key = `${Math.round(item.bounds[3] - item.bounds[1])}x${Math.round(item.bounds[2] - item.bounds[0])}`;
                    geometryCounts.set(key, { key, count: (geometryCounts.get(key)?.count || 0) + 1, evidenceObjectIds: [...(geometryCounts.get(key)?.evidenceObjectIds || []), item.objectId] });
                }
            }
            return { success:true, source:'derived_from_document_inspection', fonts:[...fontCounts.entries()].map(([name,count])=>({ name, count })).sort((a,b)=>b.count-a.count), swatches:(bundle.swatches || []).map((swatch)=>({ name: swatch.name, evidence: 'document_swatches' })), textHierarchy:visibleItems.filter((item)=>item.text?.pointSize).map((item)=>({ pointSize:item.text.pointSize, paragraphStyle:item.text.paragraphStyle, objectId:item.objectId, confidence:0.6 })).slice(0,24), recurringGeometry:[...geometryCounts.values()].filter((entry)=>entry.count > 1), motifs:args.includeMotifs ? visibleItems.filter((item)=>item.label?.motifId).map((item)=>({ motifId:item.label.motifId, objectId:item.objectId, confidence:0.7 })) : [], likelyReusableObjects:visibleItems.filter((item)=>item.label?.editable === true).map((item)=>({ objectId:item.objectId, name:item.name, reason:'editable_label' })), pageZones:grid ? [{ pageIndex, likelyGrid:grid.likelyGrid, spacingRhythm:grid.spacingRhythm }] : [], spacingRhythm:grid?.spacingRhythm || [], warnings:['Heuristic summary of existing design signals only; does not infer creative intent'] };
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
            return runGuarded(`${jsHelpers()} const args=${q({ ...args, imagePath })};
                const { FitOptions } = require('indesign');
                const layerName = args.layerName || 'REFERENCE_UNDERLAY';
                let layer = doc.layers.itemByName(layerName);
                if (!layer || layer.isValid === false) layer = doc.layers.add({ name: layerName });
                layer.visible = true; layer.locked = false; layer.printable = false;
                if (args.pageIndex == null) throw new Error('pageIndex is required');
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
                return { success:true, action:'create_reference_underlay', layerName, imagePath:args.imagePath, coordinateSpace:resolved.coordinateSpace, localBounds:resolved.localBounds, documentBounds:resolved.documentBounds, pageBounds:resolved.pageBounds, boundsValidation, ...meta(rect), warnings:['Path-string placement/layer properties pending live UXP validation'] };
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
                        if (${q(args.resolution || null)} !== null) app.jpegExportPreferences.exportResolution = ${q(args.resolution || null)};
                    }
                    if (!isJpg && app.pngExportPreferences) {
                        app.pngExportPreferences.pageString = pageString;
                        if (${q(args.resolution || null)} !== null) app.pngExportPreferences.exportResolution = ${q(args.resolution || null)};
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
                    this.export_derivative_preview({ derivativeId: args.derivativeId, pageIndex: resolved.pageIndex, overwrite: args.overwritePreview !== false, trace })
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
                this.export_derivative_preview({ derivativeId: args.derivativeId, overwrite: true, trace })
            ));
            const roundtrip = unwrapToolResult(await runPhase('verify_template_roundtrip', () =>
                this.verify_template_roundtrip({
                    derivativeId: args.derivativeId,
                    expectedMinItems: args.expectedMinItems ?? 1,
                    requirePreview: args.requirePreview !== false,
                    requireNoOverset: args.requireNoOverset !== false,
                    requireNoMissingLinks: args.requireNoMissingLinks === true,
                    overwritePreview: true,
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
            let failedStep = null;
            try {
                for (const item of args.items) {
                    const common = { ...args, ...item, derivativeId: args.derivativeId, pageIndex: page.pageIndex, coordinateSpace: item.coordinateSpace || args.coordinateSpace || 'page', layerName: item.layerName || args.layerName || 'AGENT_WORK', rejectOutOfPageBounds: item.rejectOutOfPageBounds ?? args.rejectOutOfPageBounds, maxOutsidePageRatio: item.maxOutsidePageRatio ?? args.maxOutsidePageRatio, label: shallowMergeLabel({ derivativeId: args.derivativeId, role: item.role, slot: item.slot, motifId: item.motifId, source: 'agent_created', editable: true }, item.label) };
                    let result;
                    if (item.type === 'text') result = await this.createTextFrameRaw({ ...common, text: item.text || '' });
                    else if (item.type === 'image') result = await this.createImageFrameRaw({ ...common, imagePath: item.imagePath, placeholder: item.placeholder !== false, fitMode: item.fitMode });
                    else if (item.type === 'shape') result = await this.createShapeRaw({ ...common, shapeType: item.shapeType || 'rectangle' });
                    else if (item.type === 'line') result = await this.createLineRaw({ ...common, start: item.start, end: item.end });
                    else throw new Error(`Unsupported recipe item type: ${item.type}`);
                    createdObjectIds.push(result.objectId);
                }
            } catch (error) {
                failedStep = String(error.message || error);
                if (mode === 'fail_fast') {
                    const roundtrip = await this.verify_template_roundtrip({ derivativeId: args.derivativeId, expectedMinItems: 0, requirePreview: false, requireNoOverset: false }).then(unwrapToolResult).catch(() => null);
                    return { success: true, ok: false, derivativeId: args.derivativeId, pageIndex: page.pageIndex, createdObjectIds, failedStep, roundtrip };
                }
            }
            if (Array.isArray(args.edits) && args.edits.length) await this.apply_layout_recipe({ derivativeId: args.derivativeId, edits: args.edits, mode });
            const inspectionSummary = unwrapToolResult(await this.inspect_derivative({ derivativeId: args.derivativeId, includeChecks: true, includeObjectDetails: false }));
            const checks = unwrapToolResult(await this.run_derivative_checks({ derivativeId: args.derivativeId, ...(args.checks || {}) }));
            const save = unwrapToolResult(await this.save_working_copy({}));
            const version = args.saveVersion === false ? null : unwrapToolResult(await this.save_version({ derivativeId: args.derivativeId, label: args.versionLabel || null }));
            const preview = args.exportPreview === false ? null : unwrapToolResult(await this.export_derivative_preview({ derivativeId: args.derivativeId, overwrite: true }));
            const roundtrip = unwrapToolResult(await this.verify_template_roundtrip({ derivativeId: args.derivativeId, expectedMinItems: Math.max(1, createdObjectIds.length), requirePreview: args.exportPreview !== false, requireNoOverset: args.checks?.requireNoOverset !== false, requireNoMissingLinks: args.checks?.requireNoMissingLinks === true, overwritePreview: true }));
            return { success: true, ok: !!roundtrip?.ok, derivativeId: args.derivativeId, pageIndex: page.pageIndex, pageId: page.pageId || null, createdObjectIds, inspectionSummary, checks: checks.checks || null, save, version, preview, roundtrip, ...(failedStep ? { failedStep } : {}) };
        })(), 'build_derivative_from_recipe');
    }

    static uxpTool(name, args) {
        // Extract trace from args to propagate through, remove before stringifying
        const trace = args && args.trace;
        const cleanArgs = trace ? { ...args } : args;
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
        if (n === 'set_text_content') { it=resolveItem(args); it.contents=args.text||''; return { success:true, ...meta(it), text:textExcerpt(it) }; }
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
