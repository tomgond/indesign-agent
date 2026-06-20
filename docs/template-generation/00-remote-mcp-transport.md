# Feature 0: Remote Streamable HTTP MCP Transport

## Goal

Allow OpenCode or another MCP client running on Linux to connect to the MCP server running on the Mac that owns InDesign.

The Mac should run:

- Adobe InDesign.
- The UXP plugin.
- The local bridge process.
- The MCP server listening on a configurable web port.

Linux should run:

- OpenCode or another MCP client.
- No direct InDesign bridge access.

Target topology:

```text
Linux OpenCode agent
  -> Streamable HTTP MCP
      http://mac-host:3333/mcp

Mac
  -> MCP server on 0.0.0.0:3333
  -> bridge on 127.0.0.1:3000
  -> UXP plugin on 127.0.0.1:3001
  -> InDesign
```

## Manager summary

Expose the MCP server over the network, not the low-level InDesign bridge.

The MCP layer is where tool schemas, workspace safety, path jail, and typed operations live. The bridge can execute InDesign code and should remain bound to `127.0.0.1` on the Mac.

For the first implementation pass, prioritize getting HTTP MCP working over hardening. Security/auth can be added after the remote Mac/Linux loop is functioning.

## Tools or behavior to implement

This feature does not add InDesign tools. It adds an MCP server transport mode.

Required behavior:

- Add Streamable HTTP MCP transport first.
- Make HTTP the primary/default transport for this project phase.
- Keep existing stdio transport as a compatibility fallback if practical, but do not prioritize it over HTTP.
- Bind HTTP transport to configurable host/port.
- Expose MCP protocol endpoint at `/mcp`.
- Add basic operational endpoints for health and bridge status.
- Do not block remote HTTP startup on missing auth in the first pass.
- Keep bridge access Mac-local by default.

## Files to add or modify

Likely files:

- `src/core/InDesignMCPServer.js`
- `src/index.js`
- `src/core/scriptExecutor.js`
- `README.md`
- `docs/MCP_INSTRUCTIONS.md`
- tests under `tests/`

Possible new files:

- `src/core/httpTransport.js`
- `src/core/serverConfig.js`
- `tests/test-http-transport.js`

## Configuration

Recommended environment variables:

```bash
MCP_TRANSPORT=http
MCP_HOST=0.0.0.0
MCP_PORT=3333
MCP_AUTH_TOKEN=
BRIDGE_URL=http://127.0.0.1:3000
```

Defaults:

- `MCP_TRANSPORT=http`
- `MCP_HOST=0.0.0.0`
- `MCP_PORT=3333`
- `BRIDGE_URL=http://127.0.0.1:3000`
- `MCP_AUTH_TOKEN` unset/optional for the first implementation pass

Mac remote mode:

```bash
MCP_TRANSPORT=http
MCP_HOST=0.0.0.0
MCP_PORT=3333
MCP_AUTH_TOKEN=
BRIDGE_URL=http://127.0.0.1:3000
```

Later hardening can make `MCP_AUTH_TOKEN` mandatory for non-loopback binds. Do not require that for the first pass.

## Authentication

MCP auth is deferred for the first pass. Document this as a known local-network risk and keep the bridge local to reduce blast radius.

Later hardening can add a bearer token. Do not add OAuth, user management, approval UI, or policy profiles for MVP.

## Streamable HTTP transport

Use the official MCP SDK Streamable HTTP transport if available in the installed SDK version. If the current SDK version requires additional dependency updates, document the minimum SDK version and update `package.json` during implementation.

Before implementation, read the current MCP Streamable HTTP specification and the installed JavaScript SDK transport docs. The current spec direction is:

- The server exposes a single MCP endpoint, conventionally `/mcp`.
- Clients send JSON-RPC messages with HTTP `POST` to that endpoint.
- Clients include `Accept: application/json, text/event-stream`.
- Responses may be a JSON object or a request-scoped SSE stream, depending on SDK/spec behavior.
- Newer draft specs add transport metadata headers such as protocol version and method/name headers. Follow the SDK-supported spec version rather than hand-rolling incompatible behavior.

Expected endpoint:

```text
POST /mcp
```

If the SDK requires additional methods or session handling, follow the SDK transport contract rather than inventing a custom protocol.

Important: this endpoint is for MCP protocol traffic, not for direct InDesign code execution.

## Operational endpoints

Add small non-MCP endpoints for deployment checks:

### `GET /health`

Return:

```json
{
  "ok": true,
  "transport": "http",
  "name": "indesign-server-complete"
}
```

### `GET /bridge-status`

Return bridge connectivity as seen by the MCP process:

```json
{
  "ok": true,
  "bridgeUrl": "http://127.0.0.1:3000",
  "pluginConnected": true
}
```

This endpoint should call the existing bridge `/status` endpoint through `ScriptExecutor` or a shared helper. It must not expose arbitrary bridge execution.

## Bridge URL configuration

Current `src/core/scriptExecutor.js` hardcodes:

```js
const BRIDGE_URL = 'http://127.0.0.1:3000';
```

Change this to read from `process.env.BRIDGE_URL`, defaulting to `http://127.0.0.1:3000`.

In the recommended deployment, `BRIDGE_URL` remains localhost because the MCP server and bridge both run on the Mac.

## Deployment model

Recommended production-like MVP deployment:

```text
Mac:
  1. Start bridge:
     BRIDGE_TOKEN=<bridge-token> node bridge/server.js

  2. Open InDesign and load UXP plugin.

  3. Start MCP server:
     MCP_TRANSPORT=http \
     MCP_HOST=0.0.0.0 \
     MCP_PORT=3333 \
     BRIDGE_URL=http://127.0.0.1:3000 \
     BRIDGE_TOKEN=<bridge-token> \
     node src/index.js

Linux:
  4. Configure OpenCode MCP client URL:
     http://mac-host:3333/mcp

  5. First pass: no MCP auth header required.
```

Use a private LAN, VPN, Tailscale, or SSH tunnel. Even though first-pass auth is intentionally deferred, do not expose this MCP server directly to the public internet.

`BRIDGE_TOKEN` must match the token used when starting `bridge/server.js`, because the MCP process still calls the Mac-local bridge over HTTP.

## Filesystem constraint

All InDesign paths are Mac paths.

The Linux agent may call tools remotely, but paths passed to tools must refer to files visible to the Mac, for example:

```text
/Users/<you>/InDesignMCPWorkSpace/RunX
/Users/design/source/base.indd
```

Linux paths like `/home/user/...` are not valid unless that path is mounted on the Mac at the same location.

This constraint should be documented in tool descriptions for workspace initialization and asset placement.

Use `/Users/<you>/InDesignMCPWorkSpace/RunX` as the documented default/example workspace convention.

## Security boundaries

Keep these boundaries explicit:

- Public remote boundary: MCP HTTP server.
- Private local boundary: bridge HTTP/WebSocket ports.
- InDesign execution boundary: UXP plugin.

The bridge should continue listening on `127.0.0.1`. The UXP plugin should continue connecting to `ws://127.0.0.1:3001` unless there is a separate explicit reason to support remote bridge connections.

Do not expose `/execute` from the bridge over the network for this MVP.

Known first-pass security issue: the MCP server may listen on `0.0.0.0:3333` without MCP auth. This is acceptable for initial local-network development per product direction, but must be called out in comments/docs and revisited before any broader deployment.

## Interaction with template workspace safety

This feature should be implemented first because remote access changes operational risk.

After remote MCP transport exists, all template-generation tools should still enforce:

- Original source protection.
- Workspace path jail.
- Working-copy validation.
- Preview/export/version output restrictions.
- Arbitrary JS disabled by default.

HTTP transport does not replace workspace safety; it makes workspace safety more important.

## Tests for this feature

Add tests for:

- Default startup uses HTTP transport for this project phase.
- HTTP transport starts when `MCP_TRANSPORT=http`.
- HTTP transport binds configured `MCP_HOST` and `MCP_PORT`.
- HTTP transport can start on `0.0.0.0:3333` without `MCP_AUTH_TOKEN` for the first pass.
- Add comments marking missing auth as an intentional first-pass security gap.
- `/health` returns OK.
- `/bridge-status` returns bridge disconnected when bridge is unavailable.
- Auth tests can be added as pending/known-future tests if auth support is stubbed but not enforced.
- Linux/OpenCode remote configuration is documented, and after a Mac is available the MCP server should be added to this project/OpenCode setup so the agent can call it itself.
- Bridge URL can be configured with `BRIDGE_URL`.

## Acceptance criteria

- Mac can run MCP as `0.0.0.0:3333` over Streamable HTTP.
- Linux OpenCode can connect to the Mac MCP endpoint over Streamable HTTP.
- Bridge remains local to the Mac.
- InDesign files and workspace paths are Mac-local and documented as such.
- Remote MCP transport is covered by startup/health/bridge-status tests.
- Missing MCP auth is documented as an accepted first-pass risk, not an accidental omission.
