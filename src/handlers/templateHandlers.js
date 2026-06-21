import fs from 'node:fs';
import path from 'node:path';
import { ScriptExecutor } from '../core/scriptExecutor.js';
import { formatResponse, formatErrorResponse } from '../utils/stringUtils.js';
import { initWorkspace, loadWorkspace, getWorkspace, saveWorkspace, nextVersionId, upsertDerivative } from '../core/workspaceState.js';
import { assertWorkspacePath, safeBasename } from '../utils/pathGuard.js';
import { imageInfo } from '../utils/imageInfo.js';

const LABEL_KEY = 'mcpTemplateLabel';

function response(promise, op) {
    return Promise.resolve(promise).then((r) => formatResponse(r, op)).catch((e) => formatErrorResponse(e.message, op));
}

function q(value) { return JSON.stringify(value); }

function activeGuardCode(body) {
    const { workingCopyPath } = getWorkspace();
    return `
        const expected = ${q(path.resolve(workingCopyPath))};
        if (!app.documents || app.documents.length === 0) return { success:false, error:'No document open' };
        const doc = app.activeDocument;
        let activePath = '';
        function nativePath(v) { try { return v ? String(v.nativePath || v.fsName || v) : ''; } catch(e) { return ''; } }
        try { activePath = nativePath(await doc.filePath) || nativePath(await doc.fullName); } catch(e) {}
        if (!activePath || activePath !== expected) return { success:false, error:'Active document is not workspace working copy', activeDocumentPath: activePath || null, workingCopyPath: expected };
        ${body}
    `;
}

async function runGuarded(body) {
    const result = await ScriptExecutor.executeViaUXP(activeGuardCode(body));
    if (result?.success === false) throw new Error(result.error || 'Template tool failed');
    return result;
}

function jsHelpers() {
    return `
        function at(c, i){ return c.item ? c.item(i) : c[i]; }
        function len(c){ try { return c.length || 0; } catch(e) { return 0; } }
        function arr(c, fn){ const out=[]; for (let i=0;i<len(c);i++){ try { out.push(fn(at(c,i), i)); } catch(e){ out.push({ index:i, warning:String(e) }); } } return out; }
        function safe(fn, fallback=null){ try { return fn(); } catch(e){ return fallback; } }
        function meta(item){ return { objectId:safe(()=>item.id), name:safe(()=>item.name), type:safe(()=>item.constructor.name), bounds:safe(()=>item.geometricBounds), layer:safe(()=>item.itemLayer.name), locked:safe(()=>item.locked,false), visible:safe(()=>item.visible,true) }; }
        function itemById(id){ const items = doc.allPageItems || doc.pageItems; for (let i=0;i<len(items);i++){ const it=at(items,i); if (safe(()=>it.id) === id) return it; } throw new Error('Object not found: '+id); }
        function itemByName(name){ const hits=[]; const items = doc.allPageItems || doc.pageItems; for (let i=0;i<len(items);i++){ const it=at(items,i); if (safe(()=>it.name) === name) hits.push(it); } if (hits.length !== 1) throw new Error('Expected one object named '+name+', found '+hits.length); return hits[0]; }
        function resolveItem(a){ if (a.objectId != null) return itemById(a.objectId); if (a.name) return itemByName(a.name); throw new Error('objectId or name is required'); }
        function resolveItems(a){ const ids=a.objectIds||[]; if (!ids.length) throw new Error('objectIds is required'); return ids.map(itemById); }
        function named(coll, name, kind){ const x = coll.itemByName(name); if (!x || x.isValid === false) throw new Error(kind+' not found: '+name); return x; }
        function readLabel(it){ let raw=''; try { raw = it.extractLabel ? it.extractLabel(${q(LABEL_KEY)}) : it.label; } catch(e) {} try { return raw ? JSON.parse(raw) : {}; } catch(e){ return { rawLabel: raw }; } }
        function writeLabel(it, label){ const raw=JSON.stringify(label); if (it.insertLabel) it.insertLabel(${q(LABEL_KEY)}, raw); else it.label=raw; }
        function cleanName(name){ if (!name) return name; if (!/^[a-z0-9]+(?:_[a-z0-9]+)*__(?:[a-z0-9]+_?)*__[a-z0-9_]+$/.test(name) && /[\\/"'\x00-\x1f]/.test(name)) throw new Error('Invalid semantic object name'); return name; }
        function toPt(v, unit){ return unit === 'mm' ? v * 2.8346456693 : v; }
        function boundsInPt(bounds, unit){ if (!Array.isArray(bounds) || bounds.length !== 4) throw new Error('bounds must be [top,left,bottom,right]'); const b=bounds.map(Number); if (b.some(x=>!Number.isFinite(x))) throw new Error('bounds must contain finite numbers'); if (b[2] <= b[0] || b[3] <= b[1]) throw new Error('bounds must have positive width and height'); return b.map(x=>toPt(x, unit || 'pt')); }
        function applyBasics(it,args){ if(args.name) it.name=cleanName(args.name); if(args.label) writeLabel(it,args.label); if(args.objectStyle) { const s=named(doc.objectStyles,args.objectStyle,'Object style'); if(it.applyObjectStyle) it.applyObjectStyle(s, false, false); else it.appliedObjectStyle=s; } if(args.fillSwatch) it.fillColor=named(doc.swatches,args.fillSwatch,'Swatch'); if(args.strokeSwatch) it.strokeColor=named(doc.swatches,args.strokeSwatch,'Swatch'); if(args.strokeWeight!=null) it.strokeWeight=args.strokeWeight; }
        function applyTextStyles(it,args){ const text=safe(()=>it.texts.item(0)); if(!text || text.isValid===false) return; if(args.paragraphStyle){ const s=named(doc.paragraphStyles,args.paragraphStyle,'Paragraph style'); if(text.applyParagraphStyle) text.applyParagraphStyle(s, false); else text.appliedParagraphStyle=s; } if(args.characterStyle){ const s=named(doc.characterStyles,args.characterStyle,'Character style'); if(text.applyCharacterStyle) text.applyCharacterStyle(s); else text.appliedCharacterStyle=s; } }
    `;
}

export class TemplateHandlers {
    static async handle(name, args = {}) {
        if (this[name]) return this[name](args);
        return response(this.uxpTool(name, args), name);
    }

    static init_template_workspace(args) {
        return response(initWorkspace({ originalSourcePath: args.originalInddPath, workspaceRoot: args.workspaceRoot, overwriteExistingWorkspace: args.overwriteExistingWorkspace }), 'init_template_workspace');
    }

    static get_workspace_status() {
        return response((async () => {
            const m = loadWorkspace();
            const folders = Object.fromEntries(['input','work','previews','exports','versions','logs','assets'].map((d) => [d, fs.existsSync(path.join(m.workspaceRoot, d))]));
            let active = null;
            try { active = await this.rawValidateActive(); } catch (e) { active = { ok: false, error: e.message }; }
            return { workspaceRoot: m.workspaceRoot, workingCopyPath: m.workingCopyPath, folders, activeVersionId: m.activeVersionId, versionCount: m.versions.length, previewCount: m.previews.length, derivatives: m.derivatives, activeDocument: active };
        })(), 'get_workspace_status');
    }

    static validate_workspace_path(args) {
        return response(assertWorkspacePath(args.path, { kind: args.kind }), 'validate_workspace_path');
    }

    static async rawValidateActive() {
        const m = loadWorkspace();
        return ScriptExecutor.executeViaUXP(`
            const expected = ${q(path.resolve(m.workingCopyPath))};
            let activeDocumentPath = null;
            try { if (app.documents.length) activeDocumentPath = String(await app.activeDocument.filePath || app.activeDocument.fullName || ''); } catch(e) {}
            try {
                const fp = app.documents.length ? (await app.activeDocument.filePath || await app.activeDocument.fullName) : null;
                activeDocumentPath = fp ? String(fp.nativePath || fp.fsName || fp) : activeDocumentPath;
            } catch(e) {}
            return { ok: activeDocumentPath === expected, activeDocumentPath, workingCopyPath: expected };
        `);
    }

    static validate_active_document_is_working_copy() {
        return response(this.rawValidateActive(), 'validate_active_document_is_working_copy');
    }

    static open_working_copy() {
        return response((async () => {
            const m = loadWorkspace();
            assertWorkspacePath(m.workingCopyPath, { kind: 'work', manifest: m });
            return ScriptExecutor.executeViaUXP(`
                const filePath = ${q(m.workingCopyPath)};
                const doc = await app.open(filePath);
                return { success:true, documentName: doc.name, path: filePath };
            `);
        })(), 'open_working_copy');
    }

    static save_working_copy() {
        return response(runGuarded('await doc.save(); return { success:true, path: expected };'), 'save_working_copy');
    }

    static save_version(args = {}) {
        return response((async () => {
            const m = loadWorkspace();
            await runGuarded('await doc.save(); return { success:true };');
            const versionId = nextVersionId(m);
            const versionPath = path.join(m.workspaceRoot, 'versions', `${versionId}.indd`);
            assertWorkspacePath(versionPath, { kind: 'versions', manifest: m });
            fs.copyFileSync(m.workingCopyPath, versionPath);
            const rec = { versionId, path: versionPath, label: args.label || null, derivativeId: args.derivativeId || null, createdAt: new Date().toISOString(), source: 'save_version' };
            m.versions.push(rec); m.activeVersionId = versionId; saveWorkspace(m);
            return rec;
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
            const rec = args.previewId ? m.previews.find((p) => p.previewId === args.previewId) : { path: args.path };
            if (!rec?.path) throw new Error('previewId or path is required');
            const checked = assertWorkspacePath(rec.path, { kind: 'previews', manifest: m }).path;
            const info = imageInfo(checked);
            return { ...rec, ...info, dataBase64: fs.readFileSync(checked).toString('base64') };
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
                const p = at(doc.pages, args.pageIndex || 0);
                const rect = p.rectangles.add({ geometricBounds: args.bounds, itemLayer: layer });
                rect.name = args.name || 'reference_underlay';
                writeLabel(rect, { referenceOnly:true, source:'reference_underlay', ...(args.label||{}) });
                rect.nonprinting = true;
                rect.place(args.imagePath, false);
                rect.fit(FitOptions.FILL_PROPORTIONALLY);
                rect.sendToBack(); layer.locked = args.lockLayer !== false;
                return { success:true, action:'create_reference_underlay', layerName, imagePath:args.imagePath, ...meta(rect), warnings:['Path-string placement/layer properties pending live UXP validation'] };
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
            const ext = (args.format || 'png').toLowerCase() === 'jpg' ? 'jpg' : 'png';
            const outputName = safeBasename(args.outputName || `${kind}_${args.pageIndex ?? args.spreadIndex}.${ext}`);
            const out = assertWorkspacePath(path.join(m.workspaceRoot, 'previews', outputName), { kind: 'previews', manifest: m }).path;
            if (fs.existsSync(out) && !args.overwrite) throw new Error('Preview exists; set overwrite=true');
            await runGuarded(`
                const out = ${q(out)};
                const isJpg = ${q(ext === 'jpg')};
                const pageIndex = ${q(args.pageIndex ?? null)};
                const spreadIndex = ${q(args.spreadIndex ?? null)};
                let pageString = null;
                if (${q(kind)} === 'page') {
                    if (pageIndex === null || pageIndex < 0 || pageIndex >= doc.pages.length) throw new Error('pageIndex out of range');
                    pageString = String(pageIndex + 1);
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
            `);
            const rec = { previewId: `preview_${Date.now()}_${kind}_${args.pageIndex ?? args.spreadIndex ?? 0}`, path: out, ...imageInfo(out), pageIndex: args.pageIndex ?? null, spreadIndex: args.spreadIndex ?? null, createdAt: new Date().toISOString() };
            m.previews.push(rec); saveWorkspace(m);
            return rec;
        })(), `export_${kind}_preview`);
    }

    static uxpTool(name, args) {
        if (name === 'create_image_frame' && args.imagePath) {
            const m = loadWorkspace();
            const imagePath = (() => {
                try { return assertWorkspacePath(args.imagePath, { kind: 'assets', manifest: m }).path; }
                catch { return assertWorkspacePath(args.imagePath, { kind: 'input', manifest: m }).path; }
            })();
            args = { ...args, imagePath };
        }
        const a = q(args);
        if (['inspect_document_bundle','inspect_page_items_v2','inspect_styles','inspect_swatches','inspect_layers','inspect_parent_pages','check_overset_text','check_missing_links','check_missing_fonts','check_hidden_or_locked_problem_items','run_preflight','run_template_preflight'].includes(name)) {
            return runGuarded(`${jsHelpers()} const args=${a}; ${inspectionAndChecks(name)}`);
        }
        return runGuarded(`${jsHelpers()} const args=${a}; ${layoutAndLabels(name)}`);
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
        function pageInfo(p,i){ const b = safe(()=>p.bounds, null); return { index:i, id:safe(()=>p.id), name:safe(()=>p.name), bounds:b, pageSize:pageSizeFromBounds(b), side:safe(()=>enumString(p.side), null), appliedParent:safe(()=>p.appliedMaster && p.appliedMaster.name, null), marginPreferences:marginInfo(safe(()=>p.marginPreferences, null)), itemCount:safe(()=>len(p.allPageItems || p.pageItems), null) }; }
        function spreadInfo(s,i){ return { index:i, id:safe(()=>s.id), name:safe(()=>s.name), pages:arr(s.pages,(p)=>({ index:collectionIndexById(doc.pages, p), id:safe(()=>p.id), name:safe(()=>p.name) })), itemCount:safe(()=>len(s.allPageItems || s.pageItems), null) }; }
        function parentPageInfo(m,i){ const mid = idOf(m); const appliedPages = arr(doc.pages,(p,pi)=>safe(()=>p.appliedMaster && p.appliedMaster.id, null) === mid ? pi : null).filter(x=>x !== null); return { index:i, id:safe(()=>m.id), name:safe(()=>m.name), pageCount:safe(()=>len(m.pages), null), appliedPages, pages:arr(m.pages,(p,pi)=>({ index:pi, name:safe(()=>p.name), bounds:safe(()=>p.bounds), pageSize:pageSizeFromBounds(safe(()=>p.bounds, null)), margins:marginInfo(safe(()=>p.marginPreferences, null)) })), pageItemsSummary:arr(m.allPageItems || m.pageItems || [], (it)=>({ objectId:safe(()=>it.id), name:safe(()=>it.name), type:safe(()=>it.constructor.name), bounds:safe(()=>it.geometricBounds), layerName:safe(()=>it.itemLayer.name) })) }; }
        function textInfo(it){ const isText = /TextFrame/i.test(safe(()=>it.constructor.name,'')); if (!isText && safe(()=>it.contents, null) == null) return null; const text = safe(()=>it.texts && it.texts.item(0), null); const para = safe(()=>it.paragraphs && it.paragraphs.item(0), null); const range = safe(()=>it.textStyleRanges && it.textStyleRanges.item(0), null); const firstChar = safe(()=>it.characters && it.characters.item(0), null); const excerpt = args.includeTextExcerpt === false ? undefined : String(safe(()=>it.contents, '') || '').slice(0, 500); return { excerpt, textExcerpt:excerpt, storyId:safe(()=>it.parentStory.id, null), paragraphStyle:safe(()=>para.appliedParagraphStyle.name, safe(()=>text.appliedParagraphStyle.name, null)), characterStyle:safe(()=>range.appliedCharacterStyle.name, null), fontFamily:safe(()=>range.appliedFont.fontFamily, safe(()=>firstChar.appliedFont.fontFamily, null)), fontStyle:safe(()=>range.fontStyle, safe(()=>firstChar.fontStyle, null)), pointSize:safe(()=>range.pointSize, safe(()=>firstChar.pointSize, null)), leading:safe(()=>range.leading, safe(()=>firstChar.leading, null)), tracking:safe(()=>range.tracking, safe(()=>firstChar.tracking, null)), justification:safe(()=>enumString(para.justification), null), overset:!!safe(()=>it.overflows, false) }; }
        function imageInfoForItem(it){ const hasGraphics = safe(()=>it.graphics && len(it.graphics) > 0, false); const g = hasGraphics ? safe(()=>at(it.graphics,0), null) : null; const link = safe(()=>g && g.itemLink, null); return { hasPlacedGraphic:!!g, linkName:safe(()=>link.name, null), linkPath:safe(()=>link.filePath, null), linkStatus:safe(()=>enumString(link.status), null), effectivePpi:safe(()=>g.effectivePpi, null), actualPpi:safe(()=>g.actualPpi, null) }; }
        function shapeInfoForItem(it){ const type = safe(()=>it.constructor.name, null); const path0 = safe(()=>it.paths && len(it.paths) ? at(it.paths,0) : null, null); const points = path0 ? arr(path0.pathPoints, (pt)=>({ anchor:safe(()=>pt.anchor, null), leftDirection:safe(()=>pt.leftDirection, null), rightDirection:safe(()=>pt.rightDirection, null), pointType:safe(()=>enumString(pt.pointType), null) })) : []; return { shapeType:/Oval/i.test(type) ? 'oval' : /Polygon/i.test(type) ? 'polygon' : /GraphicLine/i.test(type) ? 'line' : /Rectangle|TextFrame/i.test(type) ? 'rectangle' : type, cornerRadius:safe(()=>it.topLeftCornerRadius, null), pathPoints:points.length <= 64 ? points : [], pathPointCount:points.length }; }
        function pageIndexForItem(it){ const pp = safe(()=>it.parentPage, null); return pp ? collectionIndexById(doc.pages, pp) : null; }
        function spreadIndexForItem(it){ const pp = safe(()=>it.parentPage, null); const sp = pp ? safe(()=>pp.parent, null) : safe(()=>it.parent, null); return sp ? collectionIndexById(doc.spreads, sp) : null; }
        function itemInfo(it,i){ const layer = safe(()=>it.itemLayer, null); return { objectId:safe(()=>it.id), name:safe(()=>it.name), type:safe(()=>it.constructor.name), index:i, zOrderIndex:safe(()=>it.index, null), pageIndex:pageIndexForItem(it), spreadIndex:spreadIndexForItem(it), layerName:safe(()=>layer.name, null), layerId:safe(()=>layer.id, null), layerVisible:safe(()=>layer.visible, null), bounds:safe(()=>it.geometricBounds, null), geometricBounds:safe(()=>it.geometricBounds, null), visibleBounds:safe(()=>it.visibleBounds, null), coordinateUnit:'pt', rotation:safe(()=>it.rotationAngle, null), locked:safe(()=>it.locked, false), visible:safe(()=>it.visible, true), fillColor:swatchRef(safe(()=>it.fillColor, null)), strokeColor:swatchRef(safe(()=>it.strokeColor, null)), strokeWeight:safe(()=>it.strokeWeight, null), opacity:safe(()=>it.transparencySettings.blendingSettings.opacity, null), appliedObjectStyle:safe(()=>it.appliedObjectStyle.name, null), parentOrigin:safe(()=>it.overriddenMasterPageItem ? { objectId:it.overriddenMasterPageItem.id, name:it.overriddenMasterPageItem.name } : null, null), overridden:safe(()=>it.overridden, null), label:readLabel(it), text:textInfo(it), image:imageInfoForItem(it), shape:shapeInfoForItem(it) }; }
        function itemSource(){ if (args.pageIndex != null) { const p = at(doc.pages, args.pageIndex); let out = arr(p.allPageItems || p.pageItems, x=>x); if (args.includeParentItems) out = out.concat(arr(safe(()=>p.masterPageItems, []), x=>x)); return out; } if (args.spreadIndex != null) { const s = at(doc.spreads, args.spreadIndex); return arr(s.allPageItems || s.pageItems, x=>x); } return arr(doc.allPageItems || doc.pageItems, x=>x); }
        const dp = doc.documentPreferences;
        const documentUnits = { horizontalMeasurementUnits:safe(()=>enumString(doc.viewPreferences.horizontalMeasurementUnits), null), verticalMeasurementUnits:safe(()=>enumString(doc.viewPreferences.verticalMeasurementUnits), null), rulerOrigin:safe(()=>enumString(doc.viewPreferences.rulerOrigin), null) };
        const document = { name:doc.name, path:expected, pageCount:len(doc.pages), facingPages:safe(()=>dp.facingPages, null), pageWidth:safe(()=>dp.pageWidth, null), pageHeight:safe(()=>dp.pageHeight, null), pageSize:safe(()=>dp.pageSize, null), pageOrientation:safe(()=>enumString(dp.pageOrientation), null), bleed:{ top:safe(()=>dp.documentBleedTopOffset, null), bottom:safe(()=>dp.documentBleedBottomOffset, null), insideOrLeft:safe(()=>dp.documentBleedInsideOrLeftOffset, null), outsideOrRight:safe(()=>dp.documentBleedOutsideOrRightOffset, null), uniform:safe(()=>dp.documentBleedUniformSize, null) }, slug:{ top:safe(()=>dp.slugTopOffset, null), bottom:safe(()=>dp.slugBottomOffset, null), insideOrLeft:safe(()=>dp.slugInsideOrLeftOffset, null), outsideOrRight:safe(()=>dp.slugRightOrOutsideOffset, null), uniform:safe(()=>dp.documentSlugUniformSize, null) }, documentUnits };
        const layers = arr(doc.layers, (x,i)=>({index:i, id:safe(()=>x.id), name:safe(()=>x.name), visible:safe(()=>x.visible), locked:safe(()=>x.locked), printable:safe(()=>x.printable), color:safe(()=>enumString(x.layerColor), null), itemCount:safe(()=>len(x.pageItems), null)}));
        const swatches = arr(doc.swatches, (x,i)=>({index:i, ...swatchRef(x), usageCount:null, usageCountAvailable:false}));
        const styles = { paragraph: arr(doc.paragraphStyles, paragraphStyleInfo), character: arr(doc.characterStyles, characterStyleInfo), object: arr(doc.objectStyles, objectStyleInfo), table: arr(safe(()=>doc.tableStyles, []), (x,i)=>({index:i,id:safe(()=>x.id),name:safe(()=>x.name),basedOn:safe(()=>x.basedOn.name,null),group:styleGroupName(x)})), cell: arr(safe(()=>doc.cellStyles, []), (x,i)=>({index:i,id:safe(()=>x.id),name:safe(()=>x.name),basedOn:safe(()=>x.basedOn.name,null),group:styleGroupName(x)})) };
        const pages = arr(doc.pages, pageInfo);
        const spreads = arr(doc.spreads, spreadInfo);
        const parentPages = arr(doc.masterSpreads || [], parentPageInfo);
        const inspectedItems = arr(itemSource(), itemInfo);
        const visibleInspectItems = inspectedItems.filter(i => args.includeHidden || (i.visible !== false && i.layerVisible !== false));
    `;
    return `${common}
        if (${q(name)} === 'inspect_document_bundle') return { success:true, document, pageCount:len(doc.pages), pageSizes:pages.map(p=>({pageIndex:p.index, ...(p.pageSize||{})})), facingPages:document.facingPages, margins:pages.map(p=>({pageIndex:p.index, margins:p.marginPreferences})), bleed:document.bleed, slug:document.slug, spreads, pages, layers, swatches, styles, parentPages, fonts:arr(doc.fonts,(f)=>({name:safe(()=>f.name),fontFamily:safe(()=>f.fontFamily,null),fontStyle:safe(()=>f.fontStyleName,null),status:safe(()=>String(f.status))})), links:arr(doc.links,(l)=>({name:safe(()=>l.name),status:safe(()=>String(l.status)),path:safe(()=>l.filePath)})), documentUnits, basicPreflightState:safe(()=>({ preflightOff:doc.preflightOptions.preflightOff }), null), warnings:[] };
        if (${q(name)} === 'inspect_page_items_v2') return { success:true, items:visibleInspectItems, warnings:[] };
        if (${q(name)} === 'inspect_styles') return { success:true, styles, warnings:[] };
        if (${q(name)} === 'inspect_swatches') return { success:true, swatches, warnings:[] };
        if (${q(name)} === 'inspect_layers') return { success:true, layers, warnings:[] };
        if (${q(name)} === 'inspect_parent_pages') return { success:true, parentPages, warnings:[] };
        const oversetText = { ok:true, issues:inspectedItems.filter(i=>i.text && i.text.overset).map(i=>({objectId:i.objectId,objectName:i.name,pageIndex:i.pageIndex,textExcerpt:i.text && (i.text.textExcerpt || i.text.excerpt),summary:'Text frame is overset'})), warnings:[] }; oversetText.ok = oversetText.issues.length===0;
        const missingLinks = { ok:true, issues:arr(doc.links,(l)=>({linkName:safe(()=>l.name),status:safe(()=>String(l.status)),path:safe(()=>l.filePath)})).filter(l=>!/normal|ok/i.test(l.status||'')), warnings:[] }; missingLinks.ok = missingLinks.issues.length===0;
        const missingFonts = { ok:true, issues:arr(doc.fonts,(f)=>({fontName:safe(()=>f.name),status:safe(()=>String(f.status))})).filter(f=>/missing|substitut/i.test(f.status||'')), warnings:[] }; missingFonts.ok = missingFonts.issues.length===0;
        const hiddenLocked = { ok:true, issues:inspectedItems.filter(i=>(i.label?.source==='agent_created' && (i.locked || i.visible===false)) || (i.label?.referenceOnly && i.visible!==false)).map(i=>({objectId:i.objectId,objectName:i.name,summary:'Generated/reference item visibility or lock needs review'})), warnings:[] }; hiddenLocked.ok = hiddenLocked.issues.length===0;
        if (${q(name)} === 'check_overset_text') return { success:true, ...oversetText };
        if (${q(name)} === 'check_missing_links') return { success:true, ...missingLinks };
        if (${q(name)} === 'check_missing_fonts') return { success:true, ...missingFonts };
        if (${q(name)} === 'check_hidden_or_locked_problem_items') return { success:true, ...hiddenLocked };
        const documentPreflight = { ok:true, issues:[], warnings:['Basic preflight only in MVP'] };
        if (${q(name)} === 'run_preflight') return { success:true, ...documentPreflight };
        const issues = [...oversetText.issues, ...missingLinks.issues, ...missingFonts.issues, ...hiddenLocked.issues];
        return { success:true, ok:issues.length===0, summary:{oversetText:oversetText.issues.length,missingLinks:missingLinks.issues.length,missingFonts:missingFonts.issues.length,hiddenOrLocked:hiddenLocked.issues.length}, checks:{oversetText,missingLinks,missingFonts,documentPreflight,hiddenLocked}, issues, warnings:[] };
    `;
}

function layoutAndLabels(name) {
    return `
        const n = ${q(name)};
        let it, old;
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
            w = toPt(Number(w), u);
            h = toPt(Number(h), u);
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
                if (dims) p.adjustLayout({ width:dims.width, height:dims.height });
                const margins = applyPageMargins(p,args);
                return { success:true, pageIndex:len(doc.pages)-1, name:safe(()=>p.name), derivativeId:args.derivativeId||null, pageSize:safe(()=>({ width:p.bounds[3]-p.bounds[1], height:p.bounds[2]-p.bounds[0] }), dims), margins };
            } catch (e) {
                try { p.remove(); } catch(_) {}
                throw e;
            }
        }
        if (n === 'duplicate_page') { const src=at(doc.pages,args.pageIndex||0); const p=src.duplicate(); return { success:true, pageIndex:len(doc.pages)-1, name:safe(()=>p.name), derivativeId:args.derivativeId||null }; }
        if (n === 'create_text_frame') { const p=at(doc.pages,args.pageIndex||0); it=p.textFrames.add(); it.geometricBounds=boundsInPt(args.bounds,args.unit); it.contents=args.text||''; applyBasics(it,args); applyTextStyles(it,args); return { success:true, ...meta(it), unit:'pt', text:{excerpt:String(it.contents).slice(0,500), overset:safe(()=>it.overflows,false)} }; }
        if (n === 'create_image_frame' || n === 'create_shape') { const p=at(doc.pages,args.pageIndex||0); const type=args.shapeType||'rectangle'; it=(type==='oval'?p.ovals:type==='polygon'?p.polygons:p.rectangles).add(); it.geometricBounds=boundsInPt(args.bounds,args.unit); applyBasics(it,args); if(n==='create_image_frame' && args.imagePath){ it.place(args.imagePath, false); } return { success:true, ...meta(it), unit:'pt', link:safe(()=>({ name:it.graphics.item(0).itemLink.name, status:String(it.graphics.item(0).itemLink.status), path:it.graphics.item(0).itemLink.filePath }), null) }; }
        if (n === 'create_line') { const p=at(doc.pages,args.pageIndex||0); it=p.graphicLines.add(); it.paths.item(0).entirePath=[[toPt(args.start[0],args.unit),toPt(args.start[1],args.unit)],[toPt(args.end[0],args.unit),toPt(args.end[1],args.unit)]]; applyBasics(it,args); return { success:true, ...meta(it), unit:'pt' }; }
        if (n === 'set_text_content') { it=resolveItem(args); it.contents=args.text||''; return { success:true, ...meta(it), text:{excerpt:String(it.contents).slice(0,500), overset:safe(()=>it.overflows,false)} }; }
        if (n === 'set_bounds') { it=resolveItem(args); old=safe(()=>it.geometricBounds); it.geometricBounds=boundsInPt(args.bounds,args.unit); return { success:true, objectId:safe(()=>it.id), oldBounds:old, newBounds:safe(()=>it.geometricBounds), unit:'pt' }; }
        if (n === 'move_item' || n === 'resize_item') { it=resolveItem(args); old=safe(()=>it.geometricBounds); const b=old.slice(); if(args.delta){ const dy=toPt(args.delta[0]||0,args.unit), dx=toPt(args.delta[1]||0,args.unit); b[0]+=dy; b[1]+=dx; b[2]+=dy; b[3]+=dx; } if(args.bounds) { const nb=boundsInPt(args.bounds,args.unit); b[0]=nb[0]; b[1]=nb[1]; b[2]=nb[2]; b[3]=nb[3]; } it.geometricBounds=boundsInPt(b,'pt'); return { success:true, objectId:safe(()=>it.id), oldBounds:old, newBounds:safe(()=>it.geometricBounds), unit:'pt' }; }
        if (n === 'rotate_item') { it=resolveItem(args); old=safe(()=>it.rotationAngle,0); it.rotationAngle=args.degrees||0; return { success:true, objectId:safe(()=>it.id), oldRotation:old, newRotation:safe(()=>it.rotationAngle) }; }
        if (n === 'lock_item' || n === 'unlock_item') { it=resolveItem(args); it.locked=n==='lock_item'; return { success:true, ...meta(it) }; }
        if (n === 'rename_page_item') { it=resolveItem(args); old=safe(()=>it.name); it.name=cleanName(args.name); return { success:true, objectId:safe(()=>it.id), oldName:old, name:safe(()=>it.name) }; }
        if (n === 'label_object') { it=resolveItem(args); const label=args.merge===false?args.label:{...readLabel(it),...(args.label||{})}; writeLabel(it,label); return { success:true, objectId:safe(()=>it.id), label }; }
        if (n === 'get_object_label') { it=resolveItem(args); return { success:true, objectId:safe(()=>it.id), label:readLabel(it) }; }
        if (n === 'find_objects_by_label' || n === 'list_named_objects') { const q=args.labelQuery||args; const hits=arr(doc.allPageItems||doc.pageItems,(x)=>({...meta(x),label:readLabel(x)})).filter(x=>(args.includeHidden || x.visible!==false) && (!args.namePrefix || String(x.name||'').startsWith(args.namePrefix)) && Object.keys(q).every(k=>['labelQuery','includeHidden','namePrefix','pageIndex'].includes(k) || q[k]==null || x.label?.[k]===q[k])); return { success:true, objects:hits }; }
        if (n === 'bring_to_front' || n === 'send_to_back') { it=resolveItem(args); old=safe(()=>it.geometricBounds); if(n==='bring_to_front') it.bringToFront(); else it.sendToBack(); return { success:true, action:n, oldBounds:old, ...meta(it), warnings:['Docs-verified; pending live UXP validation'] }; }
        if (n === 'fit_content_to_frame' || n === 'fit_frame_to_content') { const { FitOptions } = require('indesign'); it=resolveItem(args); old=safe(()=>it.geometricBounds); const mode=n==='fit_content_to_frame'?FitOptions.CONTENT_TO_FRAME:FitOptions.FRAME_TO_CONTENT; it.fit(mode); return { success:true, action:n, fitMode:n==='fit_content_to_frame'?'CONTENT_TO_FRAME':'FRAME_TO_CONTENT', oldBounds:old, ...meta(it), warnings:['Docs-verified; pending live UXP validation'] }; }
        if (n === 'apply_swatches') { it=resolveItem(args); const applied={}, warnings=[]; if(args.fillSwatch){ it.fillColor=named(doc.swatches,args.fillSwatch,'Swatch'); applied.fillSwatch=args.fillSwatch; } if(args.strokeSwatch){ it.strokeColor=named(doc.swatches,args.strokeSwatch,'Swatch'); applied.strokeSwatch=args.strokeSwatch; } if(args.strokeWeight!=null){ it.strokeWeight=args.strokeWeight; applied.strokeWeight=args.strokeWeight; } const text=safe(()=>it.texts.item(0)); if(text && text.isValid!==false){ if(args.textFillSwatch){ text.fillColor=named(doc.swatches,args.textFillSwatch,'Swatch'); applied.textFillSwatch=args.textFillSwatch; } if(args.textStrokeSwatch){ text.strokeColor=named(doc.swatches,args.textStrokeSwatch,'Swatch'); applied.textStrokeSwatch=args.textStrokeSwatch; } } else if(args.textFillSwatch || args.textStrokeSwatch) warnings.push('Text swatch requested but object has no text content'); return { success:true, action:n, applied, ...meta(it), warnings }; }
        if (n === 'apply_styles') { it=resolveItem(args); const applied={}, warnings=[]; const clear=args.clearOverrides===true; const text=safe(()=>it.texts.item(0)); if(args.paragraphStyle){ const s=named(doc.paragraphStyles,args.paragraphStyle,'Paragraph style'); if(text && text.isValid!==false){ if(text.applyParagraphStyle) text.applyParagraphStyle(s, clear); else text.appliedParagraphStyle=s; applied.paragraphStyle=args.paragraphStyle; } else warnings.push('Paragraph style requested but object has no text content'); } if(args.characterStyle){ const s=named(doc.characterStyles,args.characterStyle,'Character style'); if(text && text.isValid!==false){ if(text.applyCharacterStyle) text.applyCharacterStyle(s); else text.appliedCharacterStyle=s; applied.characterStyle=args.characterStyle; } else warnings.push('Character style requested but object has no text content'); } if(args.objectStyle){ const s=named(doc.objectStyles,args.objectStyle,'Object style'); if(it.applyObjectStyle) it.applyObjectStyle(s, clear, false); else it.appliedObjectStyle=s; applied.objectStyle=args.objectStyle; } return { success:true, action:n, applied, clearOverrides:clear, ...meta(it), warnings }; }
        if (n === 'group_items') { const items=resolveItems(args); const parent=safe(()=>items[0].parentPage, null) || safe(()=>items[0].parent, null) || doc; const g=parent.groups.add(items); if(args.name) g.name=args.name; if(args.label) writeLabel(g,args.label); return { success:true, action:n, group:meta(g), childIds:items.map(x=>safe(()=>x.id)), warnings:['Plain item arrays/common parent are pending live UXP validation'] }; }
        if (n === 'ungroup_items') { it=resolveItem(args); const kids=arr(it.allPageItems||[], x=>safe(()=>x.id)); it.ungroup(); return { success:true, action:n, objectId:args.objectId||null, childIds:kids, warnings:['Pending live UXP validation'] }; }
        if (n === 'align_items') { const { AlignOptions, AlignDistributeBounds } = require('indesign'); const items=resolveItems(args); const before=items.map(x=>({objectId:safe(()=>x.id), bounds:safe(()=>x.geometricBounds)})); const alignMap={left:'LEFT_EDGES',right:'RIGHT_EDGES',top:'TOP_EDGES',bottom:'BOTTOM_EDGES',centerX:'HORIZONTAL_CENTERS',centerY:'VERTICAL_CENTERS'}; const boundsMap={page:'PAGE_BOUNDS',spread:'SPREAD_BOUNDS',selection:'ITEM_BOUNDS',items:'ITEM_BOUNDS',referenceObject:'KEY_OBJECT'}; const opt=AlignOptions[alignMap[args.mode]||args.mode]; const bound=AlignDistributeBounds[boundsMap[args.alignTo]||args.bounds||'ITEM_BOUNDS']; const ref=args.referenceObjectId?itemById(args.referenceObjectId):undefined; doc.align(items,opt,bound,ref); return { success:true, action:n, mode:args.mode, alignTo:args.alignTo||'items', before, after:items.map(x=>({objectId:safe(()=>x.id), bounds:safe(()=>x.geometricBounds)})), warnings:['Native align args are pending live UXP validation'] }; }
        if (n === 'distribute_items') { const { DistributeOptions, AlignDistributeBounds } = require('indesign'); const items=resolveItems(args); const before=items.map(x=>({objectId:safe(()=>x.id), bounds:safe(()=>x.geometricBounds)})); const distMap={horizontal:'HORIZONTAL_SPACE',vertical:'VERTICAL_SPACE',left:'LEFT_EDGES',right:'RIGHT_EDGES',top:'TOP_EDGES',bottom:'BOTTOM_EDGES',centerX:'HORIZONTAL_CENTERS',centerY:'VERTICAL_CENTERS'}; const boundsMap={page:'PAGE_BOUNDS',spread:'SPREAD_BOUNDS',selection:'ITEM_BOUNDS',items:'ITEM_BOUNDS'}; const opt=DistributeOptions[distMap[args.axis]||args.mode||args.axis]; const bound=AlignDistributeBounds[boundsMap[args.within]||args.bounds||'ITEM_BOUNDS']; doc.distribute(items,opt,bound,args.fixedSpacing!=null,args.fixedSpacing||0); return { success:true, action:n, axis:args.axis, before, after:items.map(x=>({objectId:safe(()=>x.id), bounds:safe(()=>x.geometricBounds)})), warnings:['Native distribute args are pending live UXP validation'] }; }
        if (n === 'create_reference_underlay' || n === 'hide_reference_underlay' || n === 'remove_reference_underlay') return { success:false, error:n+' should have been handled before generic template dispatch.' };
        return { success:false, error:'Template tool not implemented: '+n };
    `;
}
