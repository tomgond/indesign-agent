const boundsSchema = {
    type: 'array',
    minItems: 4,
    maxItems: 4,
    items: { type: 'number' },
    description: '[top,left,bottom,right] in unit. Returned geometry is pt.'
};

const pointSchema = {
    type: 'array',
    minItems: 2,
    maxItems: 2,
    items: { type: 'number' },
    description: '[x,y] in unit.'
};

const unitSchema = {
    type: 'string',
    enum: ['pt', 'mm'],
    default: 'pt',
    description: 'Input unit. Returned geometry is pt.'
};

const fitModeSchema = {
    type: 'string',
    enum: ['proportionally', 'fillProportionally', 'contentToFrame', 'frameToContent', 'centerContent'],
    default: 'proportionally'
};

const coordinateSpaceSchema = {
    type: 'string',
    enum: ['page', 'document'],
    default: 'page',
    description: "Coordinate interpretation. 'page' means bounds are local to the target page top-left and will be converted using page.bounds. 'document' means raw InDesign document/spread coordinates."
};

const layerNameSchema = {
    type: 'string',
    default: 'AGENT_WORK',
    description: 'Writable layer for generated editable objects.'
};

const boundsValidationSchemaProps = {
    rejectOutOfPageBounds: {
        type: 'boolean',
        default: true
    },
    maxOutsidePageRatio: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        default: 0.25
    }
};

const labelObjectSchema = { type: 'object', additionalProperties: true };
const labelQuerySchema = { type: 'object', additionalProperties: true, description: 'Label match query against stored MCP label JSON.' };

const objectTargetSchema = {
    objectId: { type: 'integer' },
    name: { type: 'string' },
    labelQuery: labelQuerySchema
};

function schema(properties, required = [], extra = {}) {
    return {
        type: 'object',
        additionalProperties: false,
        properties,
        required,
        ...extra
    };
}

function targetedSchema(properties = {}, required = [], extra = {}) {
    return schema(
        { ...objectTargetSchema, ...properties },
        required,
        {
            anyOf: [{ required: ['objectId'] }, { required: ['name'] }, { required: ['labelQuery'] }],
            ...extra
        }
    );
}

const derivativeToolDefinitions = [
    {
        name: 'resolve_derivative_page',
        description: 'Resolve a derivative page by durable identity evidence, not just manifest pageIndex.',
        inputSchema: {
            ...schema({
                derivativeId: { type: 'string' },
                pageIndex: { type: 'integer', minimum: 0 }
            }),
            anyOf: [{ required: ['derivativeId'] }, { required: ['pageIndex'] }]
        }
    },
    {
        name: 'inspect_page_geometry',
        description: 'Inspect page/spread geometry before placing objects. Required when using page-local coordinates.',
        inputSchema: {
            ...schema({
                pageIndex: { type: 'integer', minimum: 0 },
                derivativeId: { type: 'string' }
            }),
            anyOf: [{ required: ['pageIndex'] }, { required: ['derivativeId'] }]
        }
    },
    {
        name: 'create_derivative_page',
        description: 'Create a derivative page, sized in points or mm, and record derivative page metadata in the workspace manifest.',
        inputSchema: {
            ...schema({
                derivativeId: { type: 'string' },
                pageSize: { type: 'string', enum: ['social_square', 'A5', 'A3', 'poster', 'banner'] },
                orientation: { type: 'string', enum: ['portrait', 'landscape'] },
                width: { type: 'number' },
                height: { type: 'number' },
                unit: unitSchema,
                basePageIndex: { type: 'integer', minimum: 0 },
                duplicateBaseMotifs: { type: 'boolean' },
                name: { type: 'string' }
            }, ['derivativeId']),
            anyOf: [{ required: ['pageSize'] }, { required: ['width', 'height'] }]
        }
    },
    {
        name: 'duplicate_items_to_page',
        description: 'Duplicate real InDesign page items or groups onto a target page. Prefer sourceLabelQueries over raw ids when deriving motifs.',
        inputSchema: schema({
            sourceObjectIds: { type: 'array', items: { type: 'integer' } },
            sourceLabelQueries: { type: 'array', items: labelQuerySchema },
            sourcePageIndex: { type: 'integer', minimum: 0, description: 'Optional source page restriction for label-based duplication.' },
            targetPageIndex: { type: 'integer', minimum: 0 },
            offset: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' }, description: '[topOffset,leftOffset] in points.' },
            scale: { type: 'number' },
            renamePrefix: { type: 'string' },
            labelPatch: labelObjectSchema,
            preserveRelativePositions: { type: 'boolean' }
        }, ['targetPageIndex'])
    },
    {
        name: 'create_text_slot',
        description: 'Preferred template text tool. Creates semantic editable text frame with label metadata. Use this instead of generic create_text_frame for derivative templates.',
        inputSchema: schema({
            derivativeId: { type: 'string' },
            role: { type: 'string' },
            slot: { type: 'string' },
            pageIndex: { type: 'integer', minimum: 0 },
            bounds: boundsSchema,
            unit: unitSchema,
            coordinateSpace: coordinateSpaceSchema,
            layerName: layerNameSchema,
            text: { type: 'string' },
            paragraphStyle: { type: 'string' },
            characterStyle: { type: 'string' },
            objectStyle: { type: 'string' },
            fillSwatch: { type: 'string' },
            strokeSwatch: { type: 'string' },
            name: { type: 'string' },
            label: labelObjectSchema,
            autoFit: { type: 'boolean' },
            ...boundsValidationSchemaProps
        }, ['derivativeId', 'role', 'slot', 'pageIndex', 'bounds', 'text'])
    },
    {
        name: 'create_image_slot',
        description: 'Preferred template image tool. Creates semantic editable image frame or placeholder with label metadata.',
        inputSchema: schema({
            derivativeId: { type: 'string' },
            role: { type: 'string' },
            slot: { type: 'string' },
            pageIndex: { type: 'integer', minimum: 0 },
            bounds: boundsSchema,
            unit: unitSchema,
            coordinateSpace: coordinateSpaceSchema,
            layerName: layerNameSchema,
            imagePath: { type: 'string' },
            placeholder: { type: 'boolean' },
            fitMode: fitModeSchema,
            objectStyle: { type: 'string' },
            fillSwatch: { type: 'string' },
            strokeSwatch: { type: 'string' },
            strokeWeight: { type: 'number', minimum: 0 },
            name: { type: 'string' },
            label: labelObjectSchema,
            ...boundsValidationSchemaProps
        }, ['derivativeId', 'role', 'slot', 'pageIndex', 'bounds'])
    },
    {
        name: 'fit_text_to_frame',
        description: 'Heuristically repair overset text by shrinking type, tightening tracking, and optionally growing the frame. Returns evidence and actions.',
        inputSchema: targetedSchema({
            minPointSize: { type: 'number' },
            maxPointSize: { type: 'number' },
            minLeading: { type: 'number' },
            allowTrackingTighten: { type: 'boolean' },
            minTracking: { type: 'number' },
            allowFrameGrow: { type: 'boolean' },
            maxGrowMm: { type: 'number' },
            growAnchor: { type: 'string', enum: ['topLeft', 'center'] },
            maxIterations: { type: 'integer', minimum: 1 },
            unit: unitSchema
        })
    },
    {
        name: 'export_derivative_preview',
        description: 'Export a derivative page preview to workspace previews/ with deterministic naming and manifest linkage.',
        inputSchema: schema({
            derivativeId: { type: 'string' },
            pageIndex: { type: 'integer', minimum: 0 },
            format: { type: 'string', enum: ['png', 'jpg'], default: 'png' },
            resolution: { type: 'number', minimum: 1 },
            overwrite: { type: 'boolean' }
        }, ['derivativeId', 'pageIndex'])
    },
    {
        name: 'inspect_derivative',
        description: 'Inspect a derivative page into agent-friendly objects, slot groupings, previews, versions, and optional checks.',
        inputSchema: schema({
            derivativeId: { type: 'string' },
            pageIndex: { type: 'integer', minimum: 0 },
            includePreviewHistory: { type: 'boolean' },
            includeObjectDetails: { type: 'boolean' },
            includeChecks: { type: 'boolean' }
        })
    },
    {
        name: 'apply_layout_recipe',
        description: 'Apply multiple deterministic edits to named, labeled, or id-targeted objects on a derivative page.',
        inputSchema: schema({
            derivativeId: { type: 'string' },
            mode: { type: 'string', enum: ['fail_fast', 'best_effort'] },
            edits: {
                type: 'array',
                items: targetedSchema({
                    setBounds: boundsSchema,
                    pageIndex: { type: 'integer', minimum: 0 },
                    coordinateSpace: coordinateSpaceSchema,
                    setText: { type: 'string' },
                    applyStyle: schema({
                        paragraphStyle: { type: 'string' },
                        characterStyle: { type: 'string' },
                        objectStyle: { type: 'string' },
                        clearOverrides: { type: 'boolean' }
                    }),
                    applySwatch: schema({
                        fillSwatch: { type: 'string' },
                        strokeSwatch: { type: 'string' },
                        strokeWeight: { type: 'number' },
                        textFillSwatch: { type: 'string' }
                    }),
                    zOrder: { type: 'string', enum: ['front', 'back'] },
                    fitMode: fitModeSchema,
                    labelPatch: labelObjectSchema,
                    ...boundsValidationSchemaProps
                })
            }
        }, ['derivativeId', 'edits'])
    },
    {
        name: 'align_items',
        description: 'Deterministically align object bounds without calling native doc.align(). Sizes are preserved.',
        inputSchema: schema({
            objectIds: { type: 'array', minItems: 1, items: { type: 'integer' } },
            mode: { type: 'string', enum: ['left', 'right', 'top', 'bottom', 'centerX', 'centerY'] },
            alignTo: { type: 'string', enum: ['page', 'spread', 'itemsBoundingBox', 'referenceObject'] },
            referenceObjectId: { type: 'integer' },
            pageIndex: { type: 'integer', minimum: 0 }
        }, ['objectIds', 'mode', 'alignTo'])
    },
    {
        name: 'distribute_items',
        description: 'Deterministically distribute object bounds along horizontal or vertical axis, preserving object sizes.',
        inputSchema: schema({
            objectIds: { type: 'array', minItems: 2, items: { type: 'integer' } },
            axis: { type: 'string', enum: ['horizontal', 'vertical'] },
            mode: { type: 'string', enum: ['centers', 'gaps'], default: 'centers' },
            within: { type: 'string', enum: ['page', 'spread', 'itemsBoundingBox'], default: 'itemsBoundingBox' },
            fixedSpacing: { type: 'number', minimum: 0 },
            unit: unitSchema,
            pageIndex: { type: 'integer', minimum: 0 }
        }, ['objectIds', 'axis'])
    },
    {
        name: 'replace_image_in_frame',
        description: 'Place or replace image content inside an existing frame. imagePath must stay under workspace assets/ or input/.',
        inputSchema: targetedSchema({
            imagePath: { type: 'string' },
            fitMode: fitModeSchema,
            preserveFrame: { type: 'boolean' }
        }, ['imagePath'])
    },
    {
        name: 'update_text_slot',
        description: 'Update text in a text slot targeted by id, name, or labelQuery, with optional heuristic fitting.',
        inputSchema: targetedSchema({
            text: { type: 'string' },
            fit: { type: 'boolean' },
            preserveStyle: { type: 'boolean' }
        }, ['text'])
    },
    {
        name: 'run_derivative_checks',
        description: 'Run derivative-scoped checks for overset, missing links/fonts, visible reference underlay, and unlabeled objects.',
        inputSchema: {
            ...schema({
                derivativeId: { type: 'string' },
                pageIndex: { type: 'integer', minimum: 0 },
                requireLabels: { type: 'boolean' },
                requireNoVisibleReferenceUnderlay: { type: 'boolean' },
                requireNoOverset: { type: 'boolean' },
                requireNoMissingLinks: { type: 'boolean' },
                requireNoMissingFonts: { type: 'boolean' }
            }),
            anyOf: [{ required: ['derivativeId'] }, { required: ['pageIndex'] }]
        }
    },
    {
        name: 'verify_template_roundtrip',
        description: 'Required persistence verification. Proves the derivative page exists after save/reopen/inspect/export.',
        inputSchema: {
            ...schema({
                derivativeId: { type: 'string' },
                pageIndex: { type: 'integer', minimum: 0 },
                expectedMinItems: { type: 'integer', minimum: 0, default: 1 },
                requirePreview: { type: 'boolean', default: true },
                requireNoOverset: { type: 'boolean', default: true },
                requireNoMissingLinks: { type: 'boolean', default: false },
                overwritePreview: { type: 'boolean', default: true }
            }),
            anyOf: [{ required: ['derivativeId'] }, { required: ['pageIndex'] }]
        }
    },
    {
        name: 'finalize_derivative',
        description: 'Required final checkpoint before claiming a derivative is complete.',
        inputSchema: schema({
            derivativeId: { type: 'string' },
            expectedMinItems: { type: 'integer', minimum: 0, default: 1 },
            requirePreview: { type: 'boolean', default: true },
            requireNoOverset: { type: 'boolean', default: true },
            requireNoMissingLinks: { type: 'boolean', default: false },
            saveVersion: { type: 'boolean', default: true },
            versionLabel: { type: 'string' }
        }, ['derivativeId'])
    },
    {
        name: 'build_derivative_from_recipe',
        description: 'Preferred high-level tool for creating one derivative page transactionally. Use this instead of many separate primitive calls when possible.',
        inputSchema: {
            ...schema({
                derivativeId: { type: 'string' },
                name: { type: 'string' },
                pageSize: { type: 'string', enum: ['social_square', 'A5', 'A3', 'poster', 'banner'] },
                width: { type: 'number', exclusiveMinimum: 0 },
                height: { type: 'number', exclusiveMinimum: 0 },
                unit: unitSchema,
                orientation: { type: 'string', enum: ['portrait', 'landscape'] },
                basePageIndex: { type: 'integer', minimum: 0 },
                duplicateBaseMotifs: { type: 'boolean', default: false },
                coordinateSpace: coordinateSpaceSchema,
                layerName: layerNameSchema,
                ...boundsValidationSchemaProps,
                items: {
                    type: 'array',
                    items: schema({
                        type: { type: 'string', enum: ['shape', 'text', 'image', 'line'] },
                        role: { type: 'string' },
                        slot: { type: 'string' },
                        motifId: { type: 'string' },
                        shapeType: { type: 'string', enum: ['rectangle', 'oval', 'polygon'] },
                        bounds: boundsSchema,
                        start: pointSchema,
                        end: pointSchema,
                        text: { type: 'string' },
                        imagePath: { type: 'string' },
                        placeholder: { type: 'boolean' },
                        paragraphStyle: { type: 'string' },
                        characterStyle: { type: 'string' },
                        objectStyle: { type: 'string' },
                        fillSwatch: { type: 'string' },
                        strokeSwatch: { type: 'string' },
                        strokeWeight: { type: 'number', minimum: 0 },
                        fitMode: fitModeSchema,
                        name: { type: 'string' },
                        label: { type: 'object', additionalProperties: true },
                        coordinateSpace: { type: 'string', enum: ['page', 'document'] },
                        layerName: { type: 'string' },
                        rejectOutOfPageBounds: { type: 'boolean' },
                        maxOutsidePageRatio: { type: 'number', minimum: 0, maximum: 1 }
                    }, ['type'])
                },
                edits: { type: 'array', items: { type: 'object', additionalProperties: true } },
                checks: schema({
                    requireNoOverset: { type: 'boolean', default: true },
                    requireNoMissingLinks: { type: 'boolean', default: false },
                    requireLabels: { type: 'boolean', default: true }
                }),
                exportPreview: { type: 'boolean', default: true },
                saveVersion: { type: 'boolean', default: true },
                versionLabel: { type: 'string' },
                mode: { type: 'string', enum: ['fail_fast', 'best_effort'], default: 'fail_fast' }
            }, ['derivativeId', 'items']),
            anyOf: [{ required: ['pageSize'] }, { required: ['width', 'height'] }]
        }
    },
    {
        name: 'move_resize_items',
        description: 'Batch move/resize objects by targetBox or offset/scale while preserving relative layout when requested.',
        inputSchema: schema({
            objectIds: { type: 'array', items: { type: 'integer' } },
            targetBox: boundsSchema,
            offset: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' }, description: '[topOffset,leftOffset]' },
            scale: { type: 'number' },
            unit: unitSchema,
            pageIndex: { type: 'integer', minimum: 0 },
            coordinateSpace: coordinateSpaceSchema,
            preserveRelativePositions: { type: 'boolean' },
            ...boundsValidationSchemaProps
        }, ['objectIds'])
    },
    {
        name: 'create_vector_motif',
        description: 'Create a reusable vector motif from primitive shapes and optional grouping.',
        inputSchema: schema({
            derivativeId: { type: 'string' },
            pageIndex: { type: 'integer', minimum: 0 },
            motifId: { type: 'string' },
            coordinateSpace: coordinateSpaceSchema,
            layerName: layerNameSchema,
            shapes: {
                type: 'array',
                items: schema({
                    shapeType: { type: 'string', enum: ['rectangle', 'oval', 'polygon', 'line'] },
                    bounds: boundsSchema,
                    points: { type: 'array', items: pointSchema },
                    fillSwatch: { type: 'string' },
                    strokeSwatch: { type: 'string' },
                    strokeWeight: { type: 'number' },
                    opacity: { type: 'number' },
                    coordinateSpace: coordinateSpaceSchema,
                    layerName: { type: 'string' },
                    ...boundsValidationSchemaProps
                }, ['shapeType'])
            },
            group: { type: 'boolean' },
            label: labelObjectSchema,
            ...boundsValidationSchemaProps
        }, ['derivativeId', 'pageIndex', 'motifId', 'shapes'])
    },
    {
        name: 'inspect_layout_grid',
        description: 'Heuristically derive grid, margin, and spacing candidates from page item bounds. Returns evidence and warnings.',
        inputSchema: schema({
            pageIndex: { type: 'integer', minimum: 0 },
            includeHidden: { type: 'boolean' }
        })
    },
    {
        name: 'analyze_design_system',
        description: 'Summarize reusable fonts, swatches, motifs, spacing, and recurring geometry from document/page inspection. Heuristic only.',
        inputSchema: schema({
            pageIndex: { type: 'integer', minimum: 0 },
            includeItems: { type: 'boolean' },
            includeMotifs: { type: 'boolean' },
            includeGrid: { type: 'boolean' }
        })
    },
    {
        name: 'compare_derivative_state',
        description: 'Compare a derivative against a previous structured inspection snapshot. Does not diff preview pixels.',
        inputSchema: schema({
            derivativeId: { type: 'string' },
            previousPreviewId: { type: 'string' },
            currentPreviewId: { type: 'string' },
            previousInspectionId: { type: 'string' }
        }, ['derivativeId'])
    }
];

const primitiveToolDefinitions = [
    { name: 'init_template_workspace', description: 'Initialize template workspace and copy original INDD into input/work.', inputSchema: schema({ originalInddPath: { type: 'string', description: 'Existing source .indd file.' }, workspaceRoot: { type: 'string' }, overwriteExistingWorkspace: { type: 'boolean', default: false } }, ['originalInddPath', 'workspaceRoot']) },
    { name: 'attach_template_workspace', description: 'Attach an existing template workspace and rehydrate state after restart.', inputSchema: schema({ workspaceRoot: { type: 'string', description: 'Existing template workspace root containing manifest.json.' } }, ['workspaceRoot']) },
    { name: 'copy_original_to_workspace', description: 'Verify existing workspace copies or alias workspace init.', inputSchema: { ...schema({ originalInddPath: { type: 'string', description: 'Existing source .indd file.' }, workspaceRoot: { type: 'string' }, overwriteExistingWorkspace: { type: 'boolean', default: false }, verifyOnly: { type: 'boolean', default: true } }), anyOf: [{ required: ['workspaceRoot'] }, { required: ['originalInddPath', 'workspaceRoot'] }] } },
    { name: 'open_working_copy', description: 'Open current workspace working copy.', inputSchema: schema({}) },
    { name: 'get_workspace_status', description: 'Inspect template workspace status.', inputSchema: schema({}) },
    { name: 'save_working_copy', description: 'Save current workspace working copy.', inputSchema: schema({}) },
    { name: 'save_version', description: 'Save a versioned copy of current working copy.', inputSchema: schema({ label: { type: 'string' }, derivativeId: { type: 'string' } }) },
    { name: 'list_versions', description: 'List saved workspace versions.', inputSchema: schema({}) },
    { name: 'rollback_to_version', description: 'Restore a saved workspace version.', inputSchema: schema({ versionId: { type: 'string' }, reopen: { type: 'boolean', default: true } }, ['versionId']) },
    { name: 'validate_workspace_path', description: 'Validate a path stays inside the workspace jail.', inputSchema: schema({ path: { type: 'string' }, kind: { type: 'string', enum: ['input', 'work', 'previews', 'exports', 'versions', 'logs', 'assets'] } }, ['path']) },
    { name: 'validate_active_document_is_working_copy', description: 'Verify active InDesign document matches work/current.indd.', inputSchema: schema({}) },
    { name: 'inspect_document_bundle', description: 'Inspect document, pages, spreads, layers, styles, and swatches.', inputSchema: schema({ includeHidden: { type: 'boolean', default: false }, includeTextExcerpt: { type: 'boolean', default: true } }) },
    { name: 'inspect_page_items_v2', description: 'Inspect page items with labels, styles, text, and image metadata.', inputSchema: schema({ pageIndex: { type: 'integer', minimum: 0 }, spreadIndex: { type: 'integer', minimum: 0 }, includeHidden: { type: 'boolean', default: false }, includeParentItems: { type: 'boolean', default: false }, includeTextExcerpt: { type: 'boolean', default: true } }) },
    { name: 'inspect_styles', description: 'Inspect document paragraph, character, object, table, and cell styles.', inputSchema: schema({}) },
    { name: 'inspect_swatches', description: 'Inspect document swatches.', inputSchema: schema({}) },
    { name: 'inspect_layers', description: 'Inspect document layers.', inputSchema: schema({}) },
    { name: 'inspect_parent_pages', description: 'Inspect document parent pages/master spreads.', inputSchema: schema({}) },
    { name: 'export_page_preview', description: 'Export a page preview into workspace previews/.', inputSchema: schema({ pageIndex: { type: 'integer', minimum: 0 }, outputName: { type: 'string', description: 'Basename only.' }, format: { type: 'string', enum: ['png', 'jpg'], default: 'png' }, resolution: { type: 'number', minimum: 1 }, transparentBackground: { type: 'boolean', default: false }, overwrite: { type: 'boolean', default: false } }, ['pageIndex']) },
    { name: 'export_spread_preview', description: 'Export a spread preview into workspace previews/.', inputSchema: schema({ spreadIndex: { type: 'integer', minimum: 0 }, outputName: { type: 'string', description: 'Basename only.' }, format: { type: 'string', enum: ['png', 'jpg'], default: 'png' }, resolution: { type: 'number', minimum: 1 }, transparentBackground: { type: 'boolean', default: false }, overwrite: { type: 'boolean', default: false } }, ['spreadIndex']) },
    { name: 'return_preview_as_image', description: 'Return a stored preview as base64 image data.', inputSchema: schema({ previewId: { type: 'string' }, path: { type: 'string', description: 'Path under previews/.' } }, [], { anyOf: [{ required: ['previewId'] }, { required: ['path'] }] }) },
    { name: 'create_page', description: 'Create a page for template work.', inputSchema: { ...schema({ pageWidth: { type: 'number', exclusiveMinimum: 0 }, pageHeight: { type: 'number', exclusiveMinimum: 0 }, width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 }, pageSize: { type: 'string', enum: ['A5', 'A3', 'social_square'] }, orientation: { type: 'string', enum: ['portrait', 'landscape'] }, unit: unitSchema, name: { type: 'string' }, derivativeId: { type: 'string' }, marginTop: { type: 'number', minimum: 0 }, marginBottom: { type: 'number', minimum: 0 }, marginLeft: { type: 'number', minimum: 0 }, marginRight: { type: 'number', minimum: 0 } }), anyOf: [{ required: ['pageWidth', 'pageHeight'] }, { required: ['width', 'height'] }, { required: ['pageSize'] }] } },
    { name: 'duplicate_page', description: 'Duplicate a page in the active working copy.', inputSchema: schema({ pageIndex: { type: 'integer', minimum: 0 }, derivativeId: { type: 'string' }, name: { type: 'string' } }, ['pageIndex']) },
    { name: 'create_text_frame', description: 'Create a text frame on a specific page.', inputSchema: schema({ pageIndex: { type: 'integer', minimum: 0 }, bounds: boundsSchema, unit: unitSchema, coordinateSpace: coordinateSpaceSchema, layerName: layerNameSchema, text: { type: 'string', default: '' }, content: { type: 'string' }, name: { type: 'string' }, label: labelObjectSchema, paragraphStyle: { type: 'string' }, characterStyle: { type: 'string' }, objectStyle: { type: 'string' }, fillSwatch: { type: 'string' }, strokeSwatch: { type: 'string' }, strokeWeight: { type: 'number', minimum: 0 }, ...boundsValidationSchemaProps }, ['pageIndex', 'bounds']) },
    { name: 'create_image_frame', description: 'Create an image frame or placeholder on a specific page.', inputSchema: schema({ pageIndex: { type: 'integer', minimum: 0 }, bounds: boundsSchema, unit: unitSchema, coordinateSpace: coordinateSpaceSchema, layerName: layerNameSchema, imagePath: { type: 'string', description: 'Path under workspace assets/ or input/.' }, filePath: { type: 'string', description: 'Alias for imagePath under workspace assets/ or input/.' }, placeholder: { type: 'boolean', default: true }, fitMode: fitModeSchema, name: { type: 'string' }, label: labelObjectSchema, objectStyle: { type: 'string' }, fillSwatch: { type: 'string' }, strokeSwatch: { type: 'string' }, strokeWeight: { type: 'number', minimum: 0 }, ...boundsValidationSchemaProps }, ['pageIndex', 'bounds']) },
    { name: 'create_shape', description: 'Create a primitive shape on a specific page.', inputSchema: schema({ pageIndex: { type: 'integer', minimum: 0 }, bounds: boundsSchema, shapeType: { type: 'string', enum: ['rectangle', 'oval', 'polygon'] }, unit: unitSchema, coordinateSpace: coordinateSpaceSchema, layerName: layerNameSchema, name: { type: 'string' }, label: labelObjectSchema, objectStyle: { type: 'string' }, fillSwatch: { type: 'string' }, strokeSwatch: { type: 'string' }, strokeWeight: { type: 'number', minimum: 0 }, ...boundsValidationSchemaProps }, ['pageIndex', 'bounds', 'shapeType']) },
    { name: 'create_line', description: 'Create a line on a specific page.', inputSchema: schema({ pageIndex: { type: 'integer', minimum: 0 }, start: pointSchema, end: pointSchema, unit: unitSchema, coordinateSpace: coordinateSpaceSchema, layerName: layerNameSchema, name: { type: 'string' }, label: labelObjectSchema, objectStyle: { type: 'string' }, strokeSwatch: { type: 'string' }, strokeWeight: { type: 'number', minimum: 0 }, ...boundsValidationSchemaProps }, ['pageIndex', 'start', 'end']) },
    { name: 'apply_styles', description: 'Apply paragraph, character, or object styles to one object.', inputSchema: targetedSchema({ paragraphStyle: { type: 'string' }, characterStyle: { type: 'string' }, objectStyle: { type: 'string' }, clearOverrides: { type: 'boolean', default: false } }) },
    { name: 'apply_swatches', description: 'Apply fill, stroke, and text swatches to one object.', inputSchema: targetedSchema({ fillSwatch: { type: 'string' }, strokeSwatch: { type: 'string' }, strokeWeight: { type: 'number' }, textFillSwatch: { type: 'string' }, textStrokeSwatch: { type: 'string' } }) },
    { name: 'set_text_content', description: 'Set text content on one targeted text object.', inputSchema: targetedSchema({ text: { type: 'string' } }, ['text']) },
    { name: 'set_bounds', description: 'Set absolute bounds on one targeted object.', inputSchema: targetedSchema({ bounds: boundsSchema, unit: unitSchema, pageIndex: { type: 'integer', minimum: 0 }, coordinateSpace: coordinateSpaceSchema, preserveCenter: { type: 'boolean', default: false }, preserveAspectRatio: { type: 'boolean', default: false }, anchor: { type: 'string', enum: ['topLeft', 'center', 'bottomRight'], default: 'topLeft' }, roundTo: { type: 'number', exclusiveMinimum: 0 }, returnBeforeAfter: { type: 'boolean', default: false }, ...boundsValidationSchemaProps }, ['bounds']) },
    { name: 'move_item', description: 'Move one targeted object by delta.', inputSchema: targetedSchema({ delta: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' }, description: '[topOffset,leftOffset] in unit.' }, unit: unitSchema }, ['delta']) },
    { name: 'resize_item', description: 'Resize one targeted object to absolute bounds.', inputSchema: targetedSchema({ bounds: boundsSchema, unit: unitSchema, pageIndex: { type: 'integer', minimum: 0 }, coordinateSpace: coordinateSpaceSchema, preserveCenter: { type: 'boolean', default: false }, preserveAspectRatio: { type: 'boolean', default: false }, anchor: { type: 'string', enum: ['topLeft', 'center', 'bottomRight'], default: 'topLeft' }, roundTo: { type: 'number', exclusiveMinimum: 0 }, returnBeforeAfter: { type: 'boolean', default: false }, ...boundsValidationSchemaProps }, ['bounds']) },
    { name: 'rotate_item', description: 'Rotate one targeted object.', inputSchema: targetedSchema({ degrees: { type: 'number' } }, ['degrees']) },
    { name: 'lock_item', description: 'Lock one targeted object.', inputSchema: targetedSchema() },
    { name: 'unlock_item', description: 'Unlock one targeted object.', inputSchema: targetedSchema() },
    { name: 'group_items', description: 'Group multiple objects.', inputSchema: schema({ objectIds: { type: 'array', minItems: 2, items: { type: 'integer' } }, name: { type: 'string' }, label: labelObjectSchema }, ['objectIds']) },
    { name: 'ungroup_items', description: 'Ungroup one targeted group.', inputSchema: targetedSchema() },
    { name: 'bring_to_front', description: 'Bring one targeted object to front.', inputSchema: targetedSchema() },
    { name: 'send_to_back', description: 'Send one targeted object to back.', inputSchema: targetedSchema() },
    { name: 'fit_content_to_frame', description: 'Fit content to one targeted frame.', inputSchema: targetedSchema() },
    { name: 'fit_frame_to_content', description: 'Fit one targeted frame to its content.', inputSchema: targetedSchema() },
    { name: 'place_image', description: 'Place or replace image content in one targeted frame.', inputSchema: targetedSchema({ imagePath: { type: 'string', description: 'Path under workspace assets/ or input/.' }, filePath: { type: 'string', description: 'Alias for imagePath under workspace assets/ or input/.' }, fitMode: fitModeSchema }, [], { anyOf: [{ required: ['objectId', 'imagePath'] }, { required: ['name', 'imagePath'] }, { required: ['labelQuery', 'imagePath'] }, { required: ['objectId', 'filePath'] }, { required: ['name', 'filePath'] }, { required: ['labelQuery', 'filePath'] }] }) },
    { name: 'rename_page_item', description: 'Rename one targeted page item.', inputSchema: targetedSchema({ newName: { type: 'string' } }, ['newName']) },
    { name: 'label_object', description: 'Set or merge semantic label JSON on one object.', inputSchema: targetedSchema({ label: labelObjectSchema, merge: { type: 'boolean', default: true } }, ['label']) },
    { name: 'get_object_label', description: 'Read semantic label JSON from one object.', inputSchema: targetedSchema() },
    { name: 'find_objects_by_label', description: 'Find objects whose semantic labels match a query.', inputSchema: schema({ labelQuery: labelQuerySchema, includeHidden: { type: 'boolean', default: false }, namePrefix: { type: 'string' }, pageIndex: { type: 'integer', minimum: 0 } }, ['labelQuery']) },
    { name: 'list_named_objects', description: 'List named objects, optionally filtered by label query.', inputSchema: schema({ namePrefix: { type: 'string' }, labelQuery: labelQuerySchema, includeHidden: { type: 'boolean', default: false }, pageIndex: { type: 'integer', minimum: 0 } }) },
    { name: 'create_reference_underlay', description: 'Create a non-printing reference image underlay.', inputSchema: schema({ pageIndex: { type: 'integer', minimum: 0 }, bounds: boundsSchema, imagePath: { type: 'string', description: 'Path under workspace assets/ or input/.' }, filePath: { type: 'string', description: 'Alias for imagePath under workspace assets/ or input/.' }, unit: unitSchema, coordinateSpace: coordinateSpaceSchema, name: { type: 'string' }, label: labelObjectSchema, layerName: { type: 'string', default: 'REFERENCE_UNDERLAY' }, lockLayer: { type: 'boolean', default: true }, ...boundsValidationSchemaProps }, ['pageIndex', 'bounds'], { anyOf: [{ required: ['pageIndex', 'bounds', 'imagePath'] }, { required: ['pageIndex', 'bounds', 'filePath'] }] }) },
    { name: 'hide_reference_underlay', description: 'Hide the reference underlay layer.', inputSchema: schema({ layerName: { type: 'string', default: 'REFERENCE_UNDERLAY' } }) },
    { name: 'remove_reference_underlay', description: 'Remove reference underlay items or the whole layer.', inputSchema: schema({ layerName: { type: 'string', default: 'REFERENCE_UNDERLAY' }, removeLayer: { type: 'boolean', default: true } }) },
    { name: 'record_visual_review', description: 'Record visual review notes for a derivative.', inputSchema: schema({ derivativeId: { type: 'string' }, targetPreviewId: { type: 'string' }, indesignPreviewId: { type: 'string' }, brief: { type: 'string', default: '' }, issues: { type: 'array', items: {} }, suggestedFixes: { type: 'array', items: {} } }, ['derivativeId']) },
    { name: 'list_visual_reviews', description: 'List recorded visual reviews.', inputSchema: schema({ derivativeId: { type: 'string' }, limit: { type: 'integer', minimum: 1, default: 100 } }) },
    { name: 'mark_derivative_accepted', description: 'Mark a derivative preview/version as accepted.', inputSchema: schema({ derivativeId: { type: 'string' }, acceptedPreviewId: { type: 'string' }, versionId: { type: 'string' }, notes: { type: 'string', default: '' } }, ['derivativeId']) },
    { name: 'get_derivative_status', description: 'Get derivative manifest status.', inputSchema: schema({ derivativeId: { type: 'string' } }, ['derivativeId']) },
    { name: 'check_overset_text', description: 'Check for overset text frames.', inputSchema: schema({ pageIndex: { type: 'integer', minimum: 0 }, spreadIndex: { type: 'integer', minimum: 0 }, includeHidden: { type: 'boolean', default: false }, includeTextExcerpt: { type: 'boolean', default: true } }) },
    { name: 'check_missing_links', description: 'Check for missing or broken links.', inputSchema: schema({}) },
    { name: 'check_missing_fonts', description: 'Check for missing fonts.', inputSchema: schema({}) },
    { name: 'check_hidden_or_locked_problem_items', description: 'Check for hidden or locked generated/reference items.', inputSchema: schema({ pageIndex: { type: 'integer', minimum: 0 }, spreadIndex: { type: 'integer', minimum: 0 }, includeHidden: { type: 'boolean', default: true } }) },
    { name: 'run_preflight', description: 'Run basic template preflight checks.', inputSchema: schema({}) },
    { name: 'run_template_preflight', description: 'Run page/spread-scoped template preflight checks.', inputSchema: schema({ pageIndex: { type: 'integer', minimum: 0 }, spreadIndex: { type: 'integer', minimum: 0 }, includeHidden: { type: 'boolean', default: true }, includeTextExcerpt: { type: 'boolean', default: true } }) }
];

const byName = new Map();

for (const tool of derivativeToolDefinitions) byName.set(tool.name, tool);
for (const tool of primitiveToolDefinitions) byName.set(tool.name, tool);

export const templateToolDefinitions = [...byName.values()];

const duplicateNames = templateToolDefinitions
    .map((tool) => tool.name)
    .filter((name, index, arr) => arr.indexOf(name) !== index);

if (duplicateNames.length) {
    throw new Error(`Duplicate template tool definitions: ${[...new Set(duplicateNames)].join(', ')}`);
}

export const templateToolProfileNames = templateToolDefinitions.map((tool) => tool.name);
