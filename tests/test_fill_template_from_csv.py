import codecs
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).parents[1] / "scripts" / "fill_template_from_csv.py"
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("fill_template_from_csv", SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def config():
    return {
        "mcpUrl": "http://mac:3333/mcp",
        "sourcePageIndex": 0,
        "rowIdColumn": "id",
        "derivativeIdPattern": "invite_{id}",
        "slotColumnMap": {"name": "name", "title": "title", "optional": "optional"},
        "saveWorkingCopy": True,
        "exportPreview": False,
    }


class FakeMcpClient:
    def __init__(self):
        self.calls = []
        self.next_object_id = 100

    def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        if name == "duplicate_template_page":
            return {"success": True, "pageIndex": len(self.calls), "pageId": 900 + len(self.calls), "warnings": []}
        if name == "update_text_slot":
            self.next_object_id += 1
            return {
                "success": True,
                "objectId": self.next_object_id,
                "name": arguments["labelQuery"]["slot"],
                "label": arguments["labelQuery"],
            }
        return {"success": True}


class FillTemplateFromCsvTests(unittest.TestCase):
    def write_csv(self, raw_bytes):
        temp = tempfile.TemporaryDirectory()
        path = Path(temp.name) / "rows.csv"
        path.write_bytes(raw_bytes)
        self.addCleanup(temp.cleanup)
        return path

    def test_csv_preserves_bom_hebrew_quoted_comma_and_empty_cell(self):
        path = self.write_csv(
            codecs.BOM_UTF8
            + 'id,name,title,optional\r\n001,חן כהן,"מסיבת סוף שנה, גן רימון",\r\n'.encode("utf-8")
        )
        headers, rows = MODULE.read_csv_rows(path)
        self.assertEqual(headers, ["id", "name", "title", "optional"])
        self.assertEqual(rows[0]["name"], "חן כהן")
        self.assertEqual(rows[0]["title"], "מסיבת סוף שנה, גן רימון")
        self.assertEqual(rows[0]["optional"], "")

    def test_missing_mapped_column_fails_before_mutation(self):
        path = self.write_csv(b"id,name,title\n001,A,B\n")
        headers, rows = MODULE.read_csv_rows(path)
        with self.assertRaisesRegex(MODULE.FillError, "optional"):
            MODULE.prepare_rows(headers, rows, config())

    def test_config_validation(self):
        valid = config()
        MODULE.validate_config(valid)
        for key in ("mcpUrl", "sourcePageIndex", "rowIdColumn", "derivativeIdPattern", "slotColumnMap"):
            broken = dict(valid)
            broken.pop(key)
            with self.assertRaisesRegex(MODULE.FillError, key):
                MODULE.validate_config(broken)
        broken = dict(valid, slotColumnMap={})
        with self.assertRaisesRegex(MODULE.FillError, "non-empty"):
            MODULE.validate_config(broken)

    def test_fake_client_receives_exact_values_and_durable_queries(self):
        rows = [
            {
                "rowIndex": 0,
                "rowId": "001",
                "derivativeId": "invite_001",
                "values": {"id": "001", "name": " חן כהן ", "title": "ערב, קיץ", "optional": ""},
            },
            {
                "rowIndex": 1,
                "rowId": "002",
                "derivativeId": "invite_002",
                "values": {"id": "002", "name": "שלומית", "title": "יום פתוח", "optional": "x"},
            },
        ]
        client = FakeMcpClient()
        result = MODULE.run_fill(client, rows, config())
        self.assertTrue(result["success"])
        duplicate_calls = [call for call in client.calls if call[0] == "duplicate_template_page"]
        update_calls = [call for call in client.calls if call[0] == "update_text_slot"]
        self.assertEqual(len(duplicate_calls), 2)
        self.assertEqual(len(update_calls), 6)
        self.assertEqual(update_calls[0][1]["text"], " חן כהן ")
        self.assertEqual(update_calls[1][1]["text"], "ערב, קיץ")
        self.assertEqual(update_calls[2][1]["text"], "")
        self.assertEqual(update_calls[0][1]["labelQuery"], {"derivativeId": "invite_001", "slot": "name"})
        self.assertEqual(update_calls[3][1]["labelQuery"], {"derivativeId": "invite_002", "slot": "name"})
        self.assertTrue(all("fit" not in arguments for _, arguments in update_calls))
        self.assertTrue(all(arguments["textReplacePolicy"] == "isolatedOnly" for _, arguments in update_calls))

    def test_duplicate_derivative_ids_fail_during_preflight(self):
        headers = ["id", "name", "title", "optional"]
        rows = [
            {"id": "001", "name": "A", "title": "B", "optional": ""},
            {"id": "001", "name": "C", "title": "D", "optional": ""},
        ]
        with self.assertRaisesRegex(MODULE.FillError, "Duplicate generated derivativeId"):
            MODULE.prepare_rows(headers, rows, config())

    def test_dry_run_has_no_mcp_calls(self):
        client = FakeMcpClient()
        rows = [{"rowIndex": 0, "rowId": "001", "derivativeId": "invite_001", "values": {}}]
        result = MODULE.run_fill(client, rows, config(), dry_run=True)
        self.assertTrue(result["success"])
        self.assertEqual(client.calls, [])


if __name__ == "__main__":
    unittest.main()
