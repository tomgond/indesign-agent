import assert from 'node:assert/strict';
import fs from 'node:fs';

const files = {
    codexTemplateAgent: fs.readFileSync(new URL('../.codex/skills/indesign-template-agent/SKILL.md', import.meta.url), 'utf8'),
    codexOrchestrator: fs.readFileSync(new URL('../.codex/skills/indesign-template-orchestrator/SKILL.md', import.meta.url), 'utf8'),
    codexPlanner: fs.readFileSync(new URL('../.codex/skills/indesign-template-orchestrator/references/planner.md', import.meta.url), 'utf8'),
    codexExecutor: fs.readFileSync(new URL('../.codex/skills/indesign-template-orchestrator/references/executor.md', import.meta.url), 'utf8'),
    codexInspector: fs.readFileSync(new URL('../.codex/skills/indesign-template-orchestrator/references/inspector.md', import.meta.url), 'utf8'),
    opencodeTemplateAgent: fs.readFileSync(new URL('../.opencode/skills/indesign-template-agent/SKILL.md', import.meta.url), 'utf8'),
    opencodeOrchestrator: fs.readFileSync(new URL('../.opencode/agents/indesign-orchestrator.md', import.meta.url), 'utf8'),
    opencodePlanner: fs.readFileSync(new URL('../.opencode/agents/indesign-design-planner.md', import.meta.url), 'utf8'),
    opencodeExecutor: fs.readFileSync(new URL('../.opencode/agents/indesign-layout-executor.md', import.meta.url), 'utf8'),
    opencodeInspector: fs.readFileSync(new URL('../.opencode/agents/indesign-inspector.md', import.meta.url), 'utf8'),
    llmPrompt: fs.readFileSync(new URL('../docs/LLM_PROMPT.md', import.meta.url), 'utf8'),
    previewDoc: fs.readFileSync(new URL('../docs/template-generation/02-inspection-and-preview.md', import.meta.url), 'utf8')
};

const checksByFile = {
    codexTemplateAgent: [
        [/exported previews? .*document truth/i, 'exported preview truth'],
        [/structured inspection .*truth|geometry, layer, text, and visibility truth/i, 'structured inspection truth'],
        [/live screen capture only for viewport|UI diagnosis/i, 'screenshot diagnosis only'],
        [/diagnose_visual_mismatch/, 'diagnose_visual_mismatch'],
        [/set_item_layer/, 'set_item_layer'],
        [/send_to_back/, 'send_to_back'],
        [/bring_to_front/, 'bring_to_front'],
        [/Never call `update_text_slot` with `fit:true`|Never call it with `fit:true`/i, 'update_text_slot fit:true rejection'],
        [/previewQuality:\s*"checkpoint"|`checkpoint`/i, 'checkpoint preview default'],
        [/source\/base-page checkpoint preview|visual anchor/i, 'source/base preview anchor'],
        [/one or two targeted repairs|rollback|replan|rebuild/i, 'salvage/rebuild threshold']
    ],
    codexOrchestrator: [
        [/exported previews? .*document truth/i, 'exported preview truth'],
        [/structured inspection .*truth/i, 'structured inspection truth'],
        [/live screenshots only for viewport|UI diagnosis/i, 'screenshot diagnosis only'],
        [/diagnose_visual_mismatch/, 'diagnose_visual_mismatch'],
        [/Never call `update_text_slot` with `fit:true`/i, 'update_text_slot fit:true rejection'],
        [/previewQuality:\s*"checkpoint"|`checkpoint`/i, 'checkpoint preview default'],
        [/one or two targeted repairs|rollback|replan|rebuild/i, 'salvage/rebuild threshold']
    ],
    codexPlanner: [
        [/source\/base-page checkpoint preview|visual anchor/i, 'source/base preview anchor'],
        [/layer strategy/i, 'layer strategy'],
        [/rollback\/rebuild threshold|rollback|rebuild/i, 'salvage/rebuild threshold']
    ],
    codexExecutor: [
        [/diagnose_visual_mismatch/, 'diagnose_visual_mismatch'],
        [/set_item_layer/, 'set_item_layer'],
        [/send_to_back/, 'send_to_back'],
        [/bring_to_front/, 'bring_to_front'],
        [/update_text_slot.*fit:true|Do not call `update_text_slot` with `fit:true`/i, 'update_text_slot fit:true rejection'],
        [/previewQuality:\s*"checkpoint"|`checkpoint`/i, 'checkpoint preview default'],
        [/one or two targeted repairs|rollback|replan/i, 'salvage/rebuild threshold']
    ],
    codexInspector: [
        [/return_preview_as_image/, 'return_preview_as_image'],
        [/diagnose_visual_mismatch/, 'diagnose_visual_mismatch'],
        [/source\/base-page checkpoint preview|visual anchor/i, 'source/base preview anchor']
    ],
    opencodeTemplateAgent: [
        [/exported previews? .*document truth/i, 'exported preview truth'],
        [/structured inspection .*truth|geometry, layer, text, and visibility truth/i, 'structured inspection truth'],
        [/live screen capture only for viewport|UI diagnosis/i, 'screenshot diagnosis only'],
        [/diagnose_visual_mismatch/, 'diagnose_visual_mismatch'],
        [/set_item_layer/, 'set_item_layer'],
        [/send_to_back/, 'send_to_back'],
        [/bring_to_front/, 'bring_to_front'],
        [/Never call it with `fit:true`|Use `update_text_slot` only when text content actually changes/i, 'update_text_slot fit:true rejection'],
        [/previewQuality:\s*"checkpoint"|`checkpoint`/i, 'checkpoint preview default'],
        [/source\/base-page checkpoint preview|visual anchor/i, 'source/base preview anchor'],
        [/one or two targeted repairs|rollback|replan|rebuild/i, 'salvage/rebuild threshold']
    ],
    opencodeOrchestrator: [
        [/document\/export\/layout truth/i, 'exported preview truth'],
        [/object\/layer\/text\/geometry truth/i, 'structured inspection truth'],
        [/viewport\/focus\/UI diagnosis/i, 'screenshot diagnosis only'],
        [/source\/base-page checkpoint preview|visual anchor/i, 'source/base preview anchor'],
        [/layer strategy/i, 'layer strategy'],
        [/rollback|replan/i, 'salvage/rebuild threshold']
    ],
    opencodePlanner: [
        [/source\/base-page checkpoint preview|visual anchor|sourcePreviewAnchor/i, 'source/base preview anchor'],
        [/layer strategy/i, 'layer strategy'],
        [/autoFit: false|Do not use text mutation or `autoFit`/i, 'autoFit discouraged']
    ],
    opencodeExecutor: [
        [/diagnose_visual_mismatch/, 'diagnose_visual_mismatch'],
        [/full-page background/i, 'background checkpoint rule'],
        [/preview plus structured inspection/i, 'preview plus inspection checkpoint']
    ],
    opencodeInspector: [
        [/export_page_preview/, 'export_page_preview'],
        [/return_preview_as_image/, 'return_preview_as_image'],
        [/source\/base page|source\/base-page checkpoint preview|visual anchor/i, 'source/base preview anchor']
    ]
};

for (const [name, checks] of Object.entries(checksByFile)) {
    for (const [pattern, label] of checks) {
        assert.match(files[name], pattern, `${name} missing ${label}`);
    }
}

assert.doesNotMatch(files.llmPrompt, /A screenshot is the visual truth/i);
assert.match(files.llmPrompt, /Exported preview = document\/export\/layout truth/i);
assert.match(files.previewDoc, /Return preview metadata by default/i);
assert.match(files.previewDoc, /Attach an MCP image only when `returnImage: true`/i);
assert.doesNotMatch(files.previewDoc, /returns an MCP image response by default/i);

console.log('Agent instruction contract tests passed');
