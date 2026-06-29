# design-assets-mcp

Linux-side MCP server for design assets. It runs over stdio and owns provider access, deep SVG validation, preview rendering, cache, provenance, and cost accounting.

## Scope

- Search local Tabler and installed Iconify collections.
- Materialize sanitized asset payloads for the Mac-side `materialize_inline_svg_asset` tool.
- Optionally generate vector assets through Recraft's vector endpoint, then sanitize the returned SVG before handing it to the Mac-side materializer.
- Optionally vectorize raster inputs with VTracer.

## Run

```bash
npm install
npm start
```

## Mac handoff

The Mac-side InDesign MCP stays file-bound. It accepts sanitized inline SVG/base64 payloads, writes into `workspace/assets/imports/<assetKey>/asset.svg`, and returns the local file path for placement with the existing template tools.

In template mode, place the returned path with `create_image_slot` or `replace_image_in_frame`. `place_file_on_page` is only available when the generic/all tool profile is active on the Mac server.

## Local Iconify

- Tabler works out of the box through `@iconify-json/tabler`.
- Additional local Iconify collections require installing explicit packages such as `@iconify-json/mdi` or `@iconify-json/lucide`.
- This package does not install every collection by default.

Remote Iconify API search is opt-in through `allowRemote=true`, and remote candidates are discovery-only in this build. They are marked non-materializable unless you install a local collection for the same icon.

## Preview cap

Rendered PNG previews are capped at 2 MiB. If a preview would exceed the cap, `preview_asset` fails cleanly and `materialize_asset` omits the preview with a warning in the returned safety report.

## Recraft vector compatibility

Live validation confirmed the following Recraft vector request shape for square icon-style assets:

- `model: recraftv4_1_vector`
- `style: vector_illustration`
- `aspectRatio: 1:1`
- `response_format: b64_json`

The public `generate_vector_asset` tool still accepts user-friendly styles such as `icon`, but the adapter normalizes `icon` to `vector_illustration` for `recraftv4_1_vector` and records a provider warning in the returned asset metadata.

The adapter also omits `negativePrompt` for `recraftv4_1_vector` until that shape is validated for the model. The request still succeeds with the prompt text alone, and the omission is recorded as a provider warning.

Known rejected live inputs for `recraftv4_1_vector`:

- `style: icon`
- `size: 512x512`

Prefer `aspectRatio: 1:1` for square icons. Avoid explicit pixel sizes unless they have been validated for the specific model. The Mac-side materialization path does not need the Recraft API token; it only consumes sanitized SVG/base64 payloads written to `workspace/assets/imports/`.

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
npm run typecheck
```
