# InDesign MCP Server - LLM Prompt

You have access to an InDesign MCP Server that allows you to create, edit, and manage Adobe InDesign documents programmatically. Here's how to use it effectively:

## Core Capabilities

**Document Management**: Create, open, save, and close InDesign documents
**Page Operations**: Add pages, navigate between pages, set backgrounds
**Text & Typography**: Create text frames, apply styles, manage fonts
**Graphics & Images**: Place images with scaling, create shapes, apply object styles
**Styles & Colors**: Create color swatches, paragraph styles, character styles
**Layout Tools**: Group objects, create master spreads, manage positioning

## Key Tools Available

### Essential Operations

- `create_document` - Start with document creation
- `create_text_frame` - Add text content with positioning
- `place_image` - Insert images with scaling (1-1000%) and fit modes
- `create_color_swatch` - Define custom colors (RGB values)
- `create_paragraph_style` - Create reusable text styles
- `save_document` - Save your work

### Advanced Features

- `set_page_background` - Set page background colors
- `create_object_style` - Style frames and shapes
- `add_page` - Add multiple pages
- `navigate_to_page` - Switch between pages

## Best Practices

1. **Always start with document creation** before adding content
2. **Use absolute file paths** for images
3. **Create styles first**, then apply them to content
4. **Check tool responses** for success/failure
5. **Save regularly** with `save_document`

## Common Patterns

### Basic Document Creation

```javascript
// Create document
await tools.call("create_document", {
  name: "My Document",
  width: 210,
  height: 297,
  facingPages: false
});

// Add text
await tools.call("create_text_frame", {
  content: "Hello World",
  x: 25,
  y: 25,
  width: 160,
  height: 50,
  fontSize: 24,
  fontName: "Arial\\tBold"
});

// Save
await tools.call("save_document", { filePath: "./output.indd" });
```

### Branded Document with Styles

```javascript
// Create document
await tools.call("create_document", { name: "Brand Doc", width: 210, height: 297 });

// Create brand color
await tools.call("create_color_swatch", {
  name: "Brand Blue",
  colorType: "PROCESS",
  red: 0, green: 114, blue: 198
});

// Create style
await tools.call("create_paragraph_style", {
  name: "Heading 1",
  fontName: "Arial\\tBold",
  fontSize: 32,
  fillColor: "Brand Blue"
});

// Apply style
await tools.call("create_text_frame", {
  content: "Company Name",
  x: 25, y: 25, width: 160, height: 40,
  paragraphStyle: "Heading 1"
});
```

### Visual Verification (Exported Preview First)

For derivative generation and layout validation, **use exported previews plus structured inspection as the normal loop**.

**Truth model:**
- Exported preview = document/export/layout truth
- Structured inspection = object/layer/text/geometry/visibility truth
- Live screenshot = viewport/focus/UI diagnosis only

**Normal workflow:**
1. Call `open_working_copy` and validate the working copy.
2. Inspect the source/base page geometry and key objects.
3. Export a low-cost source/base-page checkpoint preview and use it as the visual anchor before planning the derivative.
4. Build or repair in small visible batches.
5. After each visible batch, export a `checkpoint` preview and compare it with structured inspection before continuing.

**Mismatch workflow:**
1. If an exported preview is blank, solid-color, or missing expected content, stop content edits.
2. Inspect object/layer state and run `diagnose_visual_mismatch`.
3. Repair with the smallest layer/z-order change using tools such as `set_item_layer`, `send_to_back`, or `bring_to_front`.
4. Export another checkpoint preview before attempting more content mutation.

**Preview tools:**
- `export_page_preview` / `export_spread_preview` / `export_derivative_preview` export preview images and return an MCP image by default unless `returnImage: false`.
- `return_preview_as_image` returns preview metadata by default and only attaches an MCP image when `returnImage: true`.

**Screenshot tools:**
- `capture_screen_preview` is a raw OS-level screenshot for display diagnostics.
- `capture_indesign_screen_preview` navigates InDesign, optionally zooms, then captures the UI for viewport/focus checks.

**Important:**
- Screenshots are OS-level (`screencapture` on macOS, PowerShell+WinForms on Windows, gnome-screenshot/import/grim on Linux). They do not prove export/layout truth.
- On macOS, Screen Recording permission may be required for Terminal/the MCP process (System Settings > Privacy & Security > Screen Recording).
- In headless or remote environments without a display, screenshot tools will return a clear error.
- When a template workspace is active, exported previews belong under `workspaceRoot/previews/`.

### Structured Design-Quality Review

Substantive visual review must record a structured rubric through `record_visual_review`. Review `hierarchy`, `alignment`, `spacing`, `typography`, `contrastColor`, `imageUse`, `styleConsistency`, `editability`, and `productionRisk`; each category records `rating`, `severity`, `score`, evidence, scoped repair guidance, acceptance impact, and whether it blocks finalization. Repairs must be concrete and bounded. Preflight blocks high-severity rubric issues only when they affect stated acceptance criteria, readability, editability, or production safety; subjective visual-quality warnings are not a general taste gate. Critique still uses exported previews plus structured inspection, never screenshots as layout truth.

### Image Placement with Scaling

```javascript
await tools.call("place_image", {
  filePath: "/absolute/path/to/image.jpg",
  x: 25, y: 25, width: 100, height: 75,
  scale: 150,  // 150% scale
  fitMode: "PROPORTIONALLY"
});
```

## Important Notes

- **Font Names**: Use format "FontName\\tStyle" (e.g., "Arial\\tBold")
- **Colors**: RGB values (0-255) for color swatches
- **Positioning**: x, y coordinates in millimeters
- **Scaling**: 1-1000% for images
- **Fit Modes**: PROPORTIONALLY, FILL_FRAME, FIT_CONTENT, FIT_FRAME

## Error Handling

- Check if tools return `success: true`
- Handle "No document open" by creating a document first
- Use fallback fonts if specific fonts aren't available
- Validate file paths for images

## Session Management

The server maintains session state, so:

- Document stays open between operations
- Page navigation persists
- Styles and colors remain available
- Use `navigate_to_page` to switch pages

When working with users, always:

1. Confirm their requirements
2. Create a structured plan
3. Execute operations step by step
4. Provide feedback on progress
5. Save the final document

Remember: This is a powerful tool for creating professional InDesign documents programmatically. Use it to automate document creation, maintain consistency, and produce high-quality layouts.
