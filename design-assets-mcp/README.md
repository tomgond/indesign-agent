# design-assets-mcp

Linux-side MCP server for design assets. It runs over stdio and owns provider access, deep SVG validation, preview rendering, cache, provenance, and cost accounting.

## Scope

- Search local Tabler and installed Iconify collections.
- Materialize sanitized asset payloads for the Mac-side `materialize_inline_svg_asset` tool.
- Optionally generate vector assets through Recraft.
- Optionally vectorize raster inputs with VTracer.

## Run

```bash
npm install
npm start
```

## Mac handoff

The Mac-side InDesign MCP stays file-bound. It accepts sanitized inline SVG/base64 payloads, writes into `workspace/assets/imports/<assetKey>/asset.svg`, and returns the local file path for placement with the existing template tools.

In template mode, place the returned path with `create_image_slot` or `replace_image_in_frame`. `place_file_on_page` is only available when the generic/all tool profile is active on the Mac server.

## Env

- `RECRAFT_API_TOKEN`
- `RECRAFT_DAILY_CAP_USD`
- `RECRAFT_DEFAULT_MAX_COST_USD`
- `RECRAFT_LEDGER_PATH`
- `DESIGN_ASSETS_CACHE_DIR`
- `ICONIFY_API_BASE_URL`
- `RECRAFT_API_BASE_URL`

## Tests

```bash
npm test
```
