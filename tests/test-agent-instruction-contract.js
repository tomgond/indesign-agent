import assert from 'node:assert/strict';
import fs from 'node:fs';

const files = {
    codexTemplateAgent: fs.readFileSync(new URL('../.codex/skills/indesign-template-agent/SKILL.md', import.meta.url), 'utf8'),
    codexOrchestrator: fs.readFileSync(new URL('../.codex/skills/indesign-template-orchestrator/SKILL.md', import.meta.url), 'utf8'),
    codexPlanner: fs.readFileSync(new URL('../.codex/skills/indesign-template-orchestrator/references/planner.md', import.meta.url), 'utf8'),
    codexExecutor: fs.readFileSync(new URL('../.codex/skills/indesign-template-orchestrator/references/executor.md', import.meta.url), 'utf8'),
    codexInspector: fs.readFileSync(new URL('../.codex/skills/indesign-template-orchestrator/references/inspector.md', import.meta.url), 'utf8'),
    codexCritic: fs.readFileSync(new URL('../.codex/skills/indesign-template-orchestrator/references/critic.md', import.meta.url), 'utf8'),
    codexPreflight: fs.readFileSync(new URL('../.codex/skills/indesign-template-orchestrator/references/preflight.md', import.meta.url), 'utf8'),
    opencodeTemplateAgent: fs.readFileSync(new URL('../.opencode/skills/indesign-template-agent/SKILL.md', import.meta.url), 'utf8'),
    opencodeOrchestrator: fs.readFileSync(new URL('../.opencode/agents/indesign-orchestrator.md', import.meta.url), 'utf8'),
    opencodePlanner: fs.readFileSync(new URL('../.opencode/agents/indesign-design-planner.md', import.meta.url), 'utf8'),
    opencodeExecutor: fs.readFileSync(new URL('../.opencode/agents/indesign-layout-executor.md', import.meta.url), 'utf8'),
    opencodeInspector: fs.readFileSync(new URL('../.opencode/agents/indesign-inspector.md', import.meta.url), 'utf8'),
    opencodeCritic: fs.readFileSync(new URL('../.opencode/agents/indesign-visual-critic.md', import.meta.url), 'utf8'),
    opencodePreflight: fs.readFileSync(new URL('../.opencode/agents/indesign-preflight-checker.md', import.meta.url), 'utf8'),
    llmPrompt: fs.readFileSync(new URL('../docs/LLM_PROMPT.md', import.meta.url), 'utf8'),
    previewDoc: fs.readFileSync(new URL('../docs/template-generation/02-inspection-and-preview.md', import.meta.url), 'utf8')
};

const boundedDesignSystemChecks = [
    [/analyze_design_system[\s\S]*bounded heuristic evidence/i, 'bounded design-system evidence'],
    [/page-scoped by default[\s\S]*explicit `?pageIndex`?/i, 'page-scoped default'],
    [/summary or standard detail/i, 'summary or standard detail'],
    [/allowHeavyInspection=true/i, 'heavy-inspection opt-in'],
    [/path points[\s\S]*image metadata[\s\S]*text excerpts[\s\S]*hidden items[\s\S]*deep detail/i, 'bounded default exclusions'],
    [/typeScale[\s\S]*fontUsage[\s\S]*colorRoles[\s\S]*spacingScale[\s\S]*marginHints[\s\S]*gridHints[\s\S]*motifCandidates[\s\S]*imageRoles[\s\S]*warnings[\s\S]*confidence[\s\S]*provenance/i, 'bounded signal list']
];

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
        [/one or two targeted repairs|rollback|replan|rebuild/i, 'salvage/rebuild threshold'],
        ...boundedDesignSystemChecks
    ],
    codexOrchestrator: [
        [/exported previews? .*document truth/i, 'exported preview truth'],
        [/structured inspection .*truth/i, 'structured inspection truth'],
        [/live screenshots only for viewport|UI diagnosis/i, 'screenshot diagnosis only'],
        [/diagnose_visual_mismatch/, 'diagnose_visual_mismatch'],
        [/Never call `update_text_slot` with `fit:true`/i, 'update_text_slot fit:true rejection'],
        [/previewQuality:\s*"checkpoint"|`checkpoint`/i, 'checkpoint preview default'],
        [/one or two targeted repairs|rollback|replan|rebuild/i, 'salvage/rebuild threshold'],
        ...boundedDesignSystemChecks
    ],
    codexPlanner: [
        [/source\/base-page checkpoint preview|visual anchor/i, 'source/base preview anchor'],
        [/layer strategy/i, 'layer strategy'],
        [/rollback\/rebuild threshold|rollback|rebuild/i, 'salvage/rebuild threshold'],
        [/rubric findings as constraints/i, 'rubric findings as constraints'],
        [/not permission to redesign unrelated|do not invent style changes/i, 'no unrelated redesign'],
        [/issue IDs or categories/i, 'rubric issue references'],
        ...boundedDesignSystemChecks
    ],
    codexExecutor: [
        [/diagnose_visual_mismatch/, 'diagnose_visual_mismatch'],
        [/set_item_layer/, 'set_item_layer'],
        [/send_to_back/, 'send_to_back'],
        [/bring_to_front/, 'bring_to_front'],
        [/update_text_slot.*fit:true|Do not call `update_text_slot` with `fit:true`/i, 'update_text_slot fit:true rejection'],
        [/previewQuality:\s*"checkpoint"|`checkpoint`/i, 'checkpoint preview default'],
        [/one or two targeted repairs|rollback|replan/i, 'salvage/rebuild threshold'],
        [/only when explicitly scoped.*plan or a structured rubric|plan-scoped or rubric-scoped/i, 'scoped rubric repairs'],
        [/do not improvise unrelated visual changes/i, 'no unrelated visual changes']
    ],
    codexInspector: [
        [/return_preview_as_image/, 'return_preview_as_image'],
        [/diagnose_visual_mismatch/, 'diagnose_visual_mismatch'],
        [/source\/base-page checkpoint preview|visual anchor/i, 'source/base preview anchor'],
        [/without making creative judgments/i, 'evidence without creative judgment'],
        ...boundedDesignSystemChecks
    ],
    codexCritic: [
        [/record_visual_review[\s\S]*designQualityRubric|designQualityRubric[\s\S]*record_visual_review/i, 'structured review recording'],
        [/all nine categories/i, 'all nine normal-review categories'],
        [/partial rubric is incomplete evidence[\s\S]*never an implied pass/i, 'partial review semantics'],
        [/rating:[\s\S]*severity:[\s\S]*score:[\s\S]*evidence:/i, 'category rating fields'],
        [/repairSuggestion:[\s\S]*suggestedToolCalls:[\s\S]*acceptanceImpact:[\s\S]*blocksFinalization:/i, 'category repair and impact fields']
    ],
    codexPreflight: [
        [/latest visual review/i, 'latest visual review'],
        [/high-severity design issues block finalization only when[\s\S]*userAcceptanceCriteria[\s\S]*readability[\s\S]*editability[\s\S]*productionSafety/i, 'narrow design blocker rule'],
        [/visualQualityOnly[\s\S]*does not block/i, 'visual quality warning rule'],
        [/partial rubric as incomplete evidence[\s\S]*do not finalize/i, 'partial rubric preflight rule']
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
        [/one or two targeted repairs|rollback|replan|rebuild/i, 'salvage/rebuild threshold'],
        ...boundedDesignSystemChecks
    ],
    opencodeOrchestrator: [
        [/document\/export\/layout truth/i, 'exported preview truth'],
        [/object\/layer\/text\/geometry truth/i, 'structured inspection truth'],
        [/viewport\/focus\/UI diagnosis/i, 'screenshot diagnosis only'],
        [/source\/base-page checkpoint preview|visual anchor/i, 'source/base preview anchor'],
        [/layer strategy/i, 'layer strategy'],
        [/rollback|replan/i, 'salvage/rebuild threshold'],
        ...boundedDesignSystemChecks
    ],
    opencodePlanner: [
        [/source\/base-page checkpoint preview|visual anchor|sourcePreviewAnchor/i, 'source/base preview anchor'],
        [/layer strategy/i, 'layer strategy'],
        [/autoFit: false|Do not use text mutation or `autoFit`/i, 'autoFit discouraged'],
        [/rubric findings as constraints/i, 'rubric findings as constraints'],
        [/not permission to redesign unrelated|must not invent style changes/i, 'no unrelated redesign'],
        [/issue IDs or categories/i, 'rubric issue references'],
        ...boundedDesignSystemChecks
    ],
    opencodeExecutor: [
        [/diagnose_visual_mismatch/, 'diagnose_visual_mismatch'],
        [/full-page background/i, 'background checkpoint rule'],
        [/preview plus structured inspection/i, 'preview plus inspection checkpoint'],
        [/only when explicitly scoped.*plan or a structured rubric/i, 'scoped rubric repairs'],
        [/Do not improvise unrelated visual changes/i, 'no unrelated visual changes']
    ],
    opencodeInspector: [
        [/export_page_preview/, 'export_page_preview'],
        [/return_preview_as_image/, 'return_preview_as_image'],
        [/source\/base page|source\/base-page checkpoint preview|visual anchor/i, 'source/base preview anchor'],
        [/without making creative judgments/i, 'evidence without creative judgment'],
        ...boundedDesignSystemChecks
    ],
    opencodeCritic: [
        [/record_visual_review[\s\S]*designQualityRubric|designQualityRubric[\s\S]*record_visual_review/i, 'structured review recording'],
        [/all nine categories/i, 'all nine normal-review categories'],
        [/partial rubric is incomplete evidence[\s\S]*never an implied pass/i, 'partial review semantics'],
        [/rating:[\s\S]*severity:[\s\S]*score:[\s\S]*evidence:/i, 'category rating fields'],
        [/repairSuggestion:[\s\S]*suggestedToolCalls:[\s\S]*acceptanceImpact:[\s\S]*blocksFinalization:/i, 'category repair and impact fields']
    ],
    opencodePreflight: [
        [/latest visual review/i, 'latest visual review'],
        [/high-severity design issues block finalization only when[\s\S]*userAcceptanceCriteria[\s\S]*readability[\s\S]*editability[\s\S]*productionSafety/i, 'narrow design blocker rule'],
        [/visualQualityOnly[\s\S]*do not block/i, 'visual quality warning rule'],
        [/partial rubric as incomplete evidence[\s\S]*do not finalize/i, 'partial rubric preflight rule']
    ],
    llmPrompt: [
        [/Exported preview = document\/export\/layout truth/i, 'exported preview truth'],
        ...boundedDesignSystemChecks
    ]
};

for (const [name, checks] of Object.entries(checksByFile)) {
    for (const [pattern, label] of checks) {
        assert.match(files[name], pattern, `${name} missing ${label}`);
    }
}

assert.doesNotMatch(files.llmPrompt, /A screenshot is the visual truth/i);
assert.match(files.llmPrompt, /Exported preview = document\/export\/layout truth/i);
assert.match(files.llmPrompt, /Confirm important conclusions from real page items and previews/i);
assert.match(files.previewDoc, /Return preview metadata by default/i);
assert.match(files.previewDoc, /Attach an MCP image only when `returnImage: true`/i);
assert.doesNotMatch(files.previewDoc, /returns an MCP image response by default/i);

const rubricCategories = [
    'hierarchy', 'alignment', 'spacing', 'typography', 'contrastColor', 'imageUse',
    'styleConsistency', 'editability', 'productionRisk'
];
for (const name of [
    'codexCritic', 'opencodeCritic', 'codexPlanner', 'opencodePlanner',
    'codexTemplateAgent', 'opencodeTemplateAgent', 'codexOrchestrator', 'opencodeOrchestrator'
]) {
    for (const category of rubricCategories) {
        assert.match(files[name], new RegExp(`\\b${category}\\b`), `${name} missing rubric category ${category}`);
    }
}

const dependencyContractSurfaces = Object.values(files).join('\n');
assert.doesNotMatch(dependencyContractSurfaces, /model[ -]?provider|image[ -]?analysis dependency|\bOCR\b/i);

console.log('Agent instruction contract tests passed');
