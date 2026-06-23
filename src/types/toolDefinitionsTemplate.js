const boundsSchema = {
    type: 'array',
    description: 'Bounds as [top,left,bottom,right]. Returned geometry is always points.',
    minItems: 4,
    maxItems: 4,
    items: { type: 'number' }
};

const unitSchema = { type: 'string', enum: ['pt', 'mm'], description: 'Input unit. Returned geometry is always points.' };
const fitModeSchema = { type: 'string', enum: ['proportionally', 'fillProportionally', 'contentToFrame', 'frameToContent', 'centerContent'] };
const objectTargetSchema = {
    objectId: { type: 'number' },
    name: { type: 'string' },
    labelQuery: { type: 'object', description: 'Label match query against stored MCP label JSON.' }
};

function schema(properties, required = []) {
    return { type: 'object', properties, required };
}

const explicit = [
    {
        name: 'create_derivative_page',
        description: 'Create a derivative page, sized in points or mm, and record derivative page metadata in the workspace manifest.',
        inputSchema: { ...schema({ derivativeId: { type: 'string' }, pageSize: { type: 'string', enum: ['social_square', 'A5', 'A3', 'poster', 'banner'] }, orientation: { type: 'string', enum: ['portrait', 'landscape'] }, width: { type: 'number' }, height: { type: 'number' }, unit: unitSchema, basePageIndex: { type: 'number' }, duplicateBaseMotifs: { type: 'boolean' }, name: { type: 'string' } }, ['derivativeId']), anyOf: [{ required: ['pageSize'] }, { required: ['width', 'height'] }] }
    },
    {
        name: 'duplicate_items_to_page',
        description: 'Duplicate real InDesign page items or groups onto a target page. Prefer sourceLabelQueries over raw ids when deriving motifs.',
        inputSchema: schema({ sourceObjectIds: { type: 'array', items: { type: 'number' } }, sourceLabelQueries: { type: 'array', items: { type: 'object' } }, sourcePageIndex: { type: 'number', description: 'Optional source page restriction for label-based duplication.' }, targetPageIndex: { type: 'number' }, offset: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' }, description: '[topOffset,leftOffset] in points.' }, scale: { type: 'number' }, renamePrefix: { type: 'string' }, labelPatch: { type: 'object' }, preserveRelativePositions: { type: 'boolean' } }, ['targetPageIndex'])
    },
    {
        name: 'create_text_slot',
        description: 'Preferred template text tool. Create a semantic editable text frame with label metadata; for template generation, prefer this over create_text_frame.',
        inputSchema: schema({ derivativeId: { type: 'string' }, role: { type: 'string' }, slot: { type: 'string' }, pageIndex: { type: 'number' }, bounds: boundsSchema, unit: unitSchema, text: { type: 'string' }, paragraphStyle: { type: 'string' }, characterStyle: { type: 'string' }, objectStyle: { type: 'string' }, fillSwatch: { type: 'string' }, strokeSwatch: { type: 'string' }, name: { type: 'string' }, label: { type: 'object' }, autoFit: { type: 'boolean' } }, ['derivativeId', 'role', 'slot', 'pageIndex', 'bounds', 'text'])
    },
    {
        name: 'create_image_slot',
        description: 'Create an editable image frame or placeholder. imagePath must stay under workspace assets/ or input/.',
        inputSchema: schema({ derivativeId: { type: 'string' }, role: { type: 'string' }, slot: { type: 'string' }, pageIndex: { type: 'number' }, bounds: boundsSchema, unit: unitSchema, imagePath: { type: 'string' }, placeholder: { type: 'boolean' }, fitMode: fitModeSchema, objectStyle: { type: 'string' }, fillSwatch: { type: 'string' }, strokeSwatch: { type: 'string' }, strokeWeight: { type: 'number' }, name: { type: 'string' }, label: { type: 'object' } }, ['derivativeId', 'role', 'slot', 'pageIndex', 'bounds'])
    },
    {
        name: 'fit_text_to_frame',
        description: 'Heuristically repair overset text by shrinking type, tightening tracking, and optionally growing the frame. Returns evidence and actions.',
        inputSchema: schema({ ...objectTargetSchema, minPointSize: { type: 'number' }, maxPointSize: { type: 'number' }, minLeading: { type: 'number' }, allowTrackingTighten: { type: 'boolean' }, minTracking: { type: 'number' }, allowFrameGrow: { type: 'boolean' }, maxGrowMm: { type: 'number' }, growAnchor: { type: 'string', enum: ['topLeft', 'center'] }, maxIterations: { type: 'number' }, unit: unitSchema })
    },
    {
        name: 'export_derivative_preview',
        description: 'Export a derivative page preview to workspace previews/ with deterministic naming and manifest linkage.',
        inputSchema: schema({ derivativeId: { type: 'string' }, pageIndex: { type: 'number' }, format: { type: 'string', enum: ['png', 'jpg'] }, resolution: { type: 'number' }, overwrite: { type: 'boolean' } }, ['derivativeId', 'pageIndex'])
    },
    {
        name: 'inspect_derivative',
        description: 'Inspect a derivative page into agent-friendly objects, slot groupings, previews, versions, and optional checks.',
        inputSchema: schema({ derivativeId: { type: 'string' }, pageIndex: { type: 'number' }, includePreviewHistory: { type: 'boolean' }, includeObjectDetails: { type: 'boolean' }, includeChecks: { type: 'boolean' } })
    },
    {
        name: 'apply_layout_recipe',
        description: 'Apply multiple deterministic edits to named, labeled, or id-targeted objects on a derivative page.',
        inputSchema: schema({ derivativeId: { type: 'string' }, mode: { type: 'string', enum: ['fail_fast', 'best_effort'] }, edits: { type: 'array', items: { type: 'object', properties: { ...objectTargetSchema, setBounds: boundsSchema, setText: { type: 'string' }, applyStyle: { type: 'object', properties: { paragraphStyle: { type: 'string' }, characterStyle: { type: 'string' }, objectStyle: { type: 'string' }, clearOverrides: { type: 'boolean' } } }, applySwatch: { type: 'object', properties: { fillSwatch: { type: 'string' }, strokeSwatch: { type: 'string' }, strokeWeight: { type: 'number' }, textFillSwatch: { type: 'string' } } }, zOrder: { type: 'string', enum: ['front', 'back'] }, fitMode: fitModeSchema, labelPatch: { type: 'object' } } } } }, ['derivativeId', 'edits'])
    },
    {
        name: 'align_items',
        description: 'Deterministically align object bounds without calling native doc.align(). Sizes are preserved.',
        inputSchema: schema({ objectIds: { type: 'array', items: { type: 'number' } }, mode: { type: 'string', enum: ['left', 'right', 'top', 'bottom', 'centerX', 'centerY'] }, alignTo: { type: 'string', enum: ['page', 'spread', 'itemsBoundingBox', 'referenceObject'] }, referenceObjectId: { type: 'number' }, pageIndex: { type: 'number' } }, ['objectIds', 'mode', 'alignTo'])
    },
    {
        name: 'distribute_items',
        description: 'Deterministically distribute object bounds along horizontal or vertical axis, preserving object sizes.',
        inputSchema: schema({ objectIds: { type: 'array', items: { type: 'number' } }, axis: { type: 'string', enum: ['horizontal', 'vertical'] }, mode: { type: 'string', enum: ['centers', 'gaps'] }, within: { type: 'string', enum: ['page', 'spread', 'itemsBoundingBox'] }, fixedSpacing: { type: 'number' }, unit: unitSchema, pageIndex: { type: 'number' } }, ['objectIds', 'axis'])
    },
    {
        name: 'replace_image_in_frame',
        description: 'Place or replace image content inside an existing frame. imagePath must stay under workspace assets/ or input/.',
        inputSchema: schema({ ...objectTargetSchema, imagePath: { type: 'string' }, fitMode: fitModeSchema, preserveFrame: { type: 'boolean' } }, ['imagePath'])
    },
    {
        name: 'update_text_slot',
        description: 'Update text in a text slot targeted by id, name, or labelQuery, with optional heuristic fitting.',
        inputSchema: schema({ ...objectTargetSchema, text: { type: 'string' }, fit: { type: 'boolean' }, preserveStyle: { type: 'boolean' } }, ['text'])
    },
    {
        name: 'run_derivative_checks',
        description: 'Run derivative-scoped checks for overset, missing links/fonts, visible reference underlay, and unlabeled objects.',
        inputSchema: { ...schema({ derivativeId: { type: 'string' }, pageIndex: { type: 'number' }, requireLabels: { type: 'boolean' }, requireNoVisibleReferenceUnderlay: { type: 'boolean' }, requireNoOverset: { type: 'boolean' }, requireNoMissingLinks: { type: 'boolean' }, requireNoMissingFonts: { type: 'boolean' } }), anyOf: [{ required: ['derivativeId'] }, { required: ['pageIndex'] }] }
    },
    {
        name: 'move_resize_items',
        description: 'Batch move/resize objects by targetBox or offset/scale while preserving relative layout when requested.',
        inputSchema: schema({ objectIds: { type: 'array', items: { type: 'number' } }, targetBox: boundsSchema, offset: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' }, description: '[topOffset,leftOffset]' }, scale: { type: 'number' }, unit: unitSchema, preserveRelativePositions: { type: 'boolean' } }, ['objectIds'])
    },
    {
        name: 'create_vector_motif',
        description: 'Create a reusable vector motif from primitive shapes and optional grouping.',
        inputSchema: schema({ derivativeId: { type: 'string' }, pageIndex: { type: 'number' }, motifId: { type: 'string' }, shapes: { type: 'array', items: { type: 'object', properties: { shapeType: { type: 'string', enum: ['rectangle', 'oval', 'polygon', 'line'] }, bounds: boundsSchema, points: { type: 'array', items: { type: 'array', items: { type: 'number' } } }, fillSwatch: { type: 'string' }, strokeSwatch: { type: 'string' }, strokeWeight: { type: 'number' }, opacity: { type: 'number' } }, required: ['shapeType'] } }, group: { type: 'boolean' }, label: { type: 'object' } }, ['derivativeId', 'pageIndex', 'motifId', 'shapes'])
    },
    {
        name: 'inspect_layout_grid',
        description: 'Heuristically derive grid, margin, and spacing candidates from page item bounds. Returns evidence and warnings.',
        inputSchema: schema({ pageIndex: { type: 'number' }, includeHidden: { type: 'boolean' } })
    },
    {
        name: 'analyze_design_system',
        description: 'Summarize reusable fonts, swatches, motifs, spacing, and recurring geometry from document/page inspection. Heuristic only.',
        inputSchema: schema({ pageIndex: { type: 'number' }, includeItems: { type: 'boolean' }, includeMotifs: { type: 'boolean' }, includeGrid: { type: 'boolean' } })
    },
    {
        name: 'compare_derivative_state',
        description: 'Compare a derivative against a previous structured inspection snapshot. Does not diff preview pixels.',
        inputSchema: schema({ derivativeId: { type: 'string' }, previousPreviewId: { type: 'string' }, currentPreviewId: { type: 'string' }, previousInspectionId: { type: 'string' } }, ['derivativeId'])
    }
];

const genericNames = [
    'init_template_workspace','open_working_copy','get_workspace_status','save_working_copy','save_version','list_versions','rollback_to_version','validate_workspace_path','validate_active_document_is_working_copy',
    'inspect_document_bundle','inspect_page_items_v2','inspect_styles','inspect_swatches','inspect_layers','inspect_parent_pages',
    'export_page_preview','export_spread_preview','return_preview_as_image',
    'create_page','duplicate_page','create_text_frame','create_image_frame','create_shape','create_line','apply_styles','apply_swatches','set_text_content','set_bounds','move_item','resize_item','rotate_item','lock_item','unlock_item','group_items','ungroup_items','bring_to_front','send_to_back','fit_content_to_frame','fit_frame_to_content','place_image',
    'rename_page_item','label_object','get_object_label','find_objects_by_label','list_named_objects','create_reference_underlay','hide_reference_underlay','remove_reference_underlay','record_visual_review','list_visual_reviews','mark_derivative_accepted','get_derivative_status',
    'check_overset_text','check_missing_links','check_missing_fonts','check_hidden_or_locked_problem_items','run_preflight','run_template_preflight'
].filter((name) => !explicit.some((tool) => tool.name === name));

export const templateToolDefinitions = [
    ...explicit,
    ...genericNames.map((name) => ({
        name,
        description: `Template generation tool: ${name}. Workspace-aware and guarded to the active template working copy when it mutates InDesign.`,
        inputSchema: schema({})
    }))
];
