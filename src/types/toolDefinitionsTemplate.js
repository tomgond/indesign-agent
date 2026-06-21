const names = [
    'init_template_workspace','open_working_copy','get_workspace_status','save_working_copy','save_version','list_versions','rollback_to_version','validate_workspace_path','validate_active_document_is_working_copy',
    'inspect_document_bundle','inspect_page_items_v2','inspect_styles','inspect_swatches','inspect_layers','inspect_parent_pages',
    'export_page_preview','export_spread_preview','return_preview_as_image',
    'create_page','create_image_frame','create_shape','create_line','apply_styles','apply_swatches','set_text_content','set_bounds','move_item','resize_item','rotate_item','lock_item','unlock_item','group_items','ungroup_items','bring_to_front','send_to_back','align_items','distribute_items','fit_content_to_frame','fit_frame_to_content',
    'rename_page_item','label_object','get_object_label','find_objects_by_label','list_named_objects','create_reference_underlay','hide_reference_underlay','remove_reference_underlay','record_visual_review','list_visual_reviews','mark_derivative_accepted','get_derivative_status',
    'check_overset_text','check_missing_links','check_missing_fonts','check_hidden_or_locked_problem_items','run_preflight','run_template_preflight'
];

const descriptions = {
    init_template_workspace: 'Create protected template workspace, copy original INDD to input/base-copy.indd and work/current.indd, and write manifest.json.',
    open_working_copy: 'Open only the manifest working copy at workspaceRoot/work/current.indd.',
    validate_workspace_path: 'Validate that a path stays inside the current template workspace jail.',
    validate_active_document_is_working_copy: 'Check that InDesign active document is the workspace working copy.',
    return_preview_as_image: 'Read a workspace preview image and return base64 bytes plus image metadata.',
    run_template_preflight: 'Run the MVP template checks: overset text, missing links/fonts, and hidden/locked/reference issues.'
};

export const templateToolDefinitions = names.map((name) => ({
    name,
    description: descriptions[name] || `Template generation tool: ${name}. Workspace-aware and disabled outside the active template working copy where it mutates InDesign.`,
    inputSchema: {
        type: 'object',
        properties: {
            originalInddPath: { type: 'string' }, workspaceRoot: { type: 'string' }, overwriteExistingWorkspace: { type: 'boolean' },
            path: { type: 'string' }, kind: { type: 'string' }, versionId: { type: 'string' }, label: {}, derivativeId: { type: 'string' },
            pageIndex: { type: 'number' }, spreadIndex: { type: 'number' }, objectId: { type: 'number' }, objectIds: { type: 'array', items: { type: 'number' } }, groupId: { type: 'number' }, itemId: { type: 'number' }, name: { type: 'string' }, namePrefix: { type: 'string' }, bounds: { type: 'array' }, unit: { type: 'string', enum: ['pt', 'mm'] }, text: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' },
            shapeType: { type: 'string' }, start: { type: 'array' }, end: { type: 'array' }, delta: { type: 'array' }, degrees: { type: 'number' },
            imagePath: { type: 'string' }, filePath: { type: 'string' }, fitMode: { type: 'string' },
            paragraphStyle: { type: 'string' }, characterStyle: { type: 'string' }, objectStyle: { type: 'string' }, clearOverrides: { type: 'boolean' },
            fillSwatch: { type: 'string' }, strokeSwatch: { type: 'string' }, strokeWeight: { type: 'number' }, textFillSwatch: { type: 'string' }, textStrokeSwatch: { type: 'string' },
            mode: { type: 'string' }, alignTo: { type: 'string' }, axis: { type: 'string' }, within: { type: 'string' }, fixedSpacing: { type: 'number' }, referenceObjectId: { type: 'number' },
            layerName: { type: 'string' }, lockLayer: { type: 'boolean' }, removeLayer: { type: 'boolean' },
            labelQuery: { type: 'object' }, merge: { type: 'boolean' }, includeHidden: { type: 'boolean' }, targetPreviewId: { type: 'string' }, indesignPreviewId: { type: 'string' }, brief: { type: 'string' }, issues: { type: 'array' }, suggestedFixes: { type: 'array' }, acceptedPreviewId: { type: 'string' }, notes: { type: 'string' }, limit: { type: 'number' },
            outputName: { type: 'string' }, format: { type: 'string', enum: ['png', 'jpg'] }, resolution: { type: 'number' }, transparentBackground: { type: 'boolean' }, overwrite: { type: 'boolean' }, previewId: { type: 'string' }
        }
    }
}));
