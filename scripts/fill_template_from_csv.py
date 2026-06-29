#!/usr/bin/env python3
"""Duplicate a finished InDesign template page and fill labeled text slots from CSV."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


DERIVATIVE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
PROTOCOL_VERSION = "2025-06-18"


class FillError(RuntimeError):
    """A configuration, CSV, MCP, or row mutation error."""


def load_json(path: str | Path) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise FillError(f"Config must contain a JSON object: {path}")
    return value


def validate_config(config: dict[str, Any]) -> None:
    for key in ("mcpUrl", "sourcePageIndex", "rowIdColumn", "derivativeIdPattern", "slotColumnMap"):
        if key not in config:
            raise FillError(f"Missing required config key: {key}")
    if not isinstance(config["mcpUrl"], str) or not config["mcpUrl"].strip():
        raise FillError("mcpUrl must be a non-empty string")
    if not isinstance(config["sourcePageIndex"], int) or isinstance(config["sourcePageIndex"], bool) or config["sourcePageIndex"] < 0:
        raise FillError("sourcePageIndex must be an integer >= 0")
    if not isinstance(config["rowIdColumn"], str) or not config["rowIdColumn"]:
        raise FillError("rowIdColumn must be a non-empty string")
    if not isinstance(config["derivativeIdPattern"], str) or not config["derivativeIdPattern"]:
        raise FillError("derivativeIdPattern must be a non-empty string")
    mapping = config["slotColumnMap"]
    if not isinstance(mapping, dict) or not mapping:
        raise FillError("slotColumnMap must be a non-empty object mapping slot names to CSV columns")
    if any(not isinstance(slot, str) or not slot or not isinstance(column, str) or not column for slot, column in mapping.items()):
        raise FillError("slotColumnMap keys and values must be non-empty strings")


def read_csv_rows(path: str | Path) -> tuple[list[str], list[dict[str, str]]]:
    with open(path, "r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise FillError("CSV must have a header row")
        headers = list(reader.fieldnames)
        rows = []
        for row in reader:
            if None in row:
                raise FillError("CSV row has more values than the header")
            rows.append({key: (value if value is not None else "") for key, value in row.items()})
    return headers, rows


def prepare_rows(
    headers: list[str],
    rows: list[dict[str, str]],
    config: dict[str, Any],
    offset: int = 0,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    required_headers = {config["rowIdColumn"], *config["slotColumnMap"].values()}
    missing = sorted(required_headers.difference(headers))
    if missing:
        raise FillError(f"CSV is missing required column(s): {', '.join(missing)}")
    if offset < 0:
        raise FillError("offset must be >= 0")
    if limit is not None and limit < 0:
        raise FillError("limit must be >= 0 or null")

    indexed_rows = list(enumerate(rows))[offset:]
    if limit is not None:
        indexed_rows = indexed_rows[:limit]
    prepared = []
    derivative_ids: set[str] = set()
    for row_index, row in indexed_rows:
        row_id = row[config["rowIdColumn"]]
        if row_id == "":
            raise FillError(f"CSV row {row_index} has an empty row id in column {config['rowIdColumn']}")
        try:
            derivative_id = config["derivativeIdPattern"].format_map(row)
        except (KeyError, ValueError) as error:
            raise FillError(f"Unable to generate derivativeId for CSV row {row_index}: {error}") from error
        if not DERIVATIVE_ID_RE.fullmatch(derivative_id) or derivative_id in {".", ".."}:
            raise FillError(
                f"Unsafe derivativeId for CSV row {row_index}: {derivative_id!r}. "
                "Use 1-128 ASCII letters, digits, dot, underscore, or hyphen, starting with a letter or digit."
            )
        if derivative_id in derivative_ids:
            raise FillError(f"Duplicate generated derivativeId: {derivative_id}")
        derivative_ids.add(derivative_id)
        prepared.append({"rowIndex": row_index, "rowId": row_id, "derivativeId": derivative_id, "values": row})
    return prepared


def parse_mcp_body(raw: str) -> dict[str, Any]:
    raw = raw.strip()
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        data = "\n".join(line[6:] for line in raw.splitlines() if line.startswith("data: "))
        if not data:
            raise FillError(f"Invalid MCP response: {raw[:300]}")
        value = json.loads(data)
    if not isinstance(value, dict):
        raise FillError("MCP response must be a JSON object")
    return value


class McpHttpClient:
    def __init__(self, url: str, timeout: float = 60.0):
        self.url = url
        self.timeout = timeout
        self.session_id: str | None = None
        self.request_id = 0

    def _request(self, payload: dict[str, Any], *, use_session: bool = True) -> tuple[dict[str, Any], Any]:
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if use_session and self.session_id:
            headers["mcp-session-id"] = self.session_id
        request = urllib.request.Request(
            self.url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = parse_mcp_body(response.read().decode("utf-8"))
                return body, response.headers
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise FillError(f"MCP HTTP {error.code}: {detail}") from error
        except urllib.error.URLError as error:
            raise FillError(f"Unable to reach MCP endpoint {self.url}: {error.reason}") from error

    def initialize(self) -> None:
        body, headers = self._request(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": "fill-template-from-csv", "version": "1.0.0"},
                },
            },
            use_session=False,
        )
        if "error" in body:
            raise FillError(f"MCP initialize failed: {body['error']}")
        self.session_id = headers.get("mcp-session-id")
        if not self.session_id:
            raise FillError("MCP initialize response did not include mcp-session-id")
        self._request({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def operational_checks(self) -> dict[str, Any]:
        parsed = urllib.parse.urlsplit(self.url)
        base_path = parsed.path[:-4] if parsed.path.endswith("/mcp") else parsed.path.rstrip("/")
        base = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, base_path, "", ""))
        checks = {}
        for name in ("health", "bridge-status"):
            endpoint = f"{base}/{name}"
            try:
                with urllib.request.urlopen(endpoint, timeout=min(self.timeout, 10.0)) as response:
                    checks[name] = json.loads(response.read().decode("utf-8"))
            except (urllib.error.URLError, json.JSONDecodeError) as error:
                raise FillError(f"Operational check failed for {endpoint}: {error}") from error
        health = checks["health"]
        bridge = checks["bridge-status"]
        if not health.get("ok"):
            raise FillError(f"MCP health check failed: {health}")
        if not bridge.get("ok") or bridge.get("pluginConnected") is False:
            raise FillError(f"InDesign bridge/plugin is not ready: {bridge}")
        return checks

    def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        if not self.session_id:
            raise FillError("MCP client is not initialized")
        self.request_id += 1
        body, _ = self._request(
            {
                "jsonrpc": "2.0",
                "id": self.request_id + 1,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments or {}},
            }
        )
        if "error" in body:
            raise FillError(f"{name}: {body['error'].get('message', body['error'])}")
        content = body.get("result", {}).get("content", [])
        text = next((item.get("text") for item in content if item.get("type") == "text"), None)
        if text is None:
            raise FillError(f"{name}: MCP response did not contain text content")
        try:
            result = json.loads(text)
        except json.JSONDecodeError as error:
            raise FillError(f"{name}: invalid JSON tool result: {text[:300]}") from error
        return require_success(result, name)


def require_success(result: dict[str, Any], tool: str) -> dict[str, Any]:
    if not isinstance(result, dict):
        raise FillError(f"{tool}: expected object result")
    if result.get("success") is False:
        raise FillError(f"{tool}: {result.get('result') or result.get('error') or 'failed'}")
    nested = result.get("result")
    if isinstance(nested, dict):
        if nested.get("success") is False:
            raise FillError(f"{tool}: {nested.get('error') or 'failed'}")
        return nested
    return result


def require_active_working_copy_validation(result: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(result, dict):
        raise FillError("validate_active_document_is_working_copy: expected object result")
    candidate = result.get("result") if isinstance(result.get("result"), dict) else result
    if not isinstance(candidate, dict):
        raise FillError("validate_active_document_is_working_copy: expected object result")
    ok = candidate.get("ok")
    if ok is True:
        return candidate
    if candidate.get("success") is False or ok is False:
        active_path = candidate.get("activeDocumentPath")
        working_copy_path = candidate.get("workingCopyPath")
        detail = candidate.get("error") or candidate.get("message") or "active document is not the working copy"
        suffix = []
        if active_path is not None:
            suffix.append(f"activeDocumentPath={active_path!r}")
        if working_copy_path is not None:
            suffix.append(f"workingCopyPath={working_copy_path!r}")
        if suffix:
            detail = f"{detail} ({', '.join(suffix)})"
        raise FillError(f"validate_active_document_is_working_copy: {detail}")
    raise FillError("validate_active_document_is_working_copy: response did not confirm ok=true")


def call(client: Any, tool: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
    return require_success(client.call_tool(tool, arguments or {}), tool)


def run_fill(
    client: Any,
    prepared_rows: list[dict[str, Any]],
    config: dict[str, Any],
    *,
    collect_errors: bool = False,
    dry_run: bool = False,
    save: bool | None = None,
    save_on_error: bool = False,
    export_preview: bool | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "success": True,
        "processed": 0,
        "failed": 0,
        "derivativesCreated": 0,
        "rows": [],
        "errors": [],
    }
    if dry_run:
        result["dryRun"] = True
        result["rows"] = [
            {"rowIndex": row["rowIndex"], "rowId": row["rowId"], "derivativeId": row["derivativeId"]}
            for row in prepared_rows
        ]
        result["processed"] = len(prepared_rows)
        return result

    if hasattr(client, "operational_checks"):
        result["operationalChecks"] = client.operational_checks()
    if hasattr(client, "initialize"):
        client.initialize()
    call(client, "get_workspace_status")
    call(client, "open_working_copy")
    require_active_working_copy_validation(call(client, "validate_active_document_is_working_copy"))

    fit_slots = config.get("fitSlots", [])
    inspect_after_update = config.get("inspectAfterUpdate", False) is True
    should_export = config.get("exportPreview", False) if export_preview is None else export_preview
    should_save = config.get("saveWorkingCopy", True) if save is None else save

    stop = False
    for row in prepared_rows:
        row_tool = "duplicate_template_page"
        row_result: dict[str, Any] = {
            "rowIndex": row["rowIndex"],
            "rowId": row["rowId"],
            "derivativeId": row["derivativeId"],
            "slots": [],
            "warnings": [],
            "errors": [],
        }
        try:
            duplicate = call(
                client,
                "duplicate_template_page",
                {
                    "sourcePageIndex": config["sourcePageIndex"],
                    "derivativeId": row["derivativeId"],
                    "relabelSlots": True,
                    "requireUniqueSlots": True,
                    "textSafetyMode": "preserve_but_guard",
                },
            )
            result["derivativesCreated"] += 1
            row_result["pageIndex"] = duplicate.get("pageIndex")
            row_result["pageId"] = duplicate.get("pageId")
            row_result["warnings"].extend(duplicate.get("warnings", []))

            for slot, column in config["slotColumnMap"].items():
                value = row["values"][column]
                slot_tool = "update_text_slot"
                slot_result = {
                    "slot": slot,
                    "column": column,
                    "sourceLength": len(value),
                    "sourceSha256": hashlib.sha256(value.encode("utf-8")).hexdigest(),
                    "updated": False,
                    "warnings": [],
                }
                try:
                    updated = call(
                        client,
                        "update_text_slot",
                        {
                            "labelQuery": {"derivativeId": row["derivativeId"], "slot": slot},
                            "text": value,
                            "preserveStyle": True,
                            "textReplacePolicy": "isolatedOnly",
                        },
                    )
                    slot_result.update(
                        {
                            "objectId": updated.get("objectId"),
                            "name": updated.get("name"),
                            "label": updated.get("label"),
                            "updated": True,
                        }
                    )
                    if fit_slots is True or (isinstance(fit_slots, list) and slot in fit_slots):
                        slot_tool = "fit_text_to_frame"
                        fit_result = call(
                            client,
                            "fit_text_to_frame",
                            {"labelQuery": {"derivativeId": row["derivativeId"], "slot": slot}},
                        )
                        slot_result["fitResult"] = fit_result
                except Exception as error:
                    failure = {
                        "rowIndex": row["rowIndex"],
                        "rowId": row["rowId"],
                        "derivativeId": row["derivativeId"],
                        "slot": slot,
                        "column": column,
                        "tool": slot_tool,
                        "error": str(error),
                    }
                    slot_result["error"] = str(error)
                    row_result["errors"].append(failure)
                    result["errors"].append(failure)
                    if not collect_errors:
                        stop = True
                row_result["slots"].append(slot_result)
                if stop:
                    break

            if not row_result["errors"] and inspect_after_update:
                row_tool = "inspect_derivative"
                row_result["inspection"] = call(client, "inspect_derivative", {"derivativeId": row["derivativeId"], "includeChecks": True})
            if not row_result["errors"] and should_export:
                row_tool = "export_derivative_preview"
                row_result["preview"] = call(client, "export_derivative_preview", {"derivativeId": row["derivativeId"], "previewQuality": "checkpoint"})
        except Exception as error:
            failure = {
                "rowIndex": row["rowIndex"],
                "rowId": row["rowId"],
                "derivativeId": row["derivativeId"],
                "slot": None,
                "column": None,
                "tool": row_tool,
                "error": str(error),
            }
            row_result["errors"].append(failure)
            result["errors"].append(failure)
            stop = not collect_errors

        result["processed"] += 1
        if row_result["errors"]:
            result["failed"] += 1
        result["rows"].append(row_result)
        if stop:
            break

    if should_save and (save_on_error or not result["errors"]):
        try:
            result["saveResult"] = call(client, "save_working_copy")
        except Exception as error:
            result["errors"].append({"rowIndex": None, "rowId": None, "slot": None, "column": None, "tool": "save_working_copy", "error": str(error)})
    elif should_save and result["errors"]:
        result["saveSkipped"] = True
        result["saveSkippedReason"] = "errors_present"
    result["success"] = not result["errors"]
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", required=True, dest="csv_path")
    parser.add_argument("--config", required=True, dest="config_path")
    parser.add_argument("--out", required=True, dest="out_path")
    parser.add_argument("--collect-errors", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--offset", type=int)
    parser.add_argument("--no-save", action="store_true")
    parser.add_argument("--save-on-error", action="store_true")
    parser.add_argument("--export-preview", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    output: dict[str, Any]
    try:
        config = load_json(args.config_path)
        validate_config(config)
        headers, rows = read_csv_rows(args.csv_path)
        offset = args.offset if args.offset is not None else config.get("offset", 0)
        limit = args.limit if args.limit is not None else config.get("limit")
        prepared = prepare_rows(headers, rows, config, offset=offset, limit=limit)
        client = McpHttpClient(config["mcpUrl"])
        output = run_fill(
            client,
            prepared,
            config,
            collect_errors=args.collect_errors,
            dry_run=args.dry_run,
            save=False if args.no_save else None,
            save_on_error=args.save_on_error,
            export_preview=True if args.export_preview else None,
        )
        output.update({"csvPath": str(Path(args.csv_path)), "configPath": str(Path(args.config_path))})
    except Exception as error:
        output = {
            "success": False,
            "csvPath": str(Path(args.csv_path)),
            "configPath": str(Path(args.config_path)),
            "processed": 0,
            "failed": 0,
            "derivativesCreated": 0,
            "rows": [],
            "errors": [{"tool": None, "error": str(error)}],
        }
    out_path = Path(args.out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"rows processed: {output.get('processed', 0)}; rows failed: {output.get('failed', 0)}; "
        f"derivatives created: {output.get('derivativesCreated', 0)}; output: {out_path}"
    )
    return 0 if output.get("success") else 1


if __name__ == "__main__":
    sys.exit(main())
