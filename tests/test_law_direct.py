from __future__ import annotations
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "plugins/k-deal-skill/skills/korean-law-search/scripts/law_fetch.py"
spec = importlib.util.spec_from_file_location("kds_law_fetch", SCRIPT)
law = importlib.util.module_from_spec(spec)
spec.loader.exec_module(law)


def run(argv, environ=None):
    out = io.StringIO()
    with patch.dict(law.os.environ, environ or {}, clear=True), contextlib.redirect_stdout(out):
        code = law.main(argv)
    return code, json.loads(out.getvalue())


class LawDirectTests(unittest.TestCase):
    def test_article_codes(self):
        self.assertEqual(law.jo_code("제750조"), "075000")
        self.assertEqual(law.jo_code("제10조의2"), "001002")
        self.assertIsNone(law.jo_code("부칙"))

    def test_exact_name_ranks_first(self):
        rows = [{"법령명한글": "상법 시행령"}, {"법령명한글": "상호저축은행법"}, {"법령명한글": "상법"}]
        self.assertEqual([r["법령명한글"] for r in law.rank_laws(rows, "상법")], ["상법", "상법 시행령", "상호저축은행법"])

    def test_oc_is_redacted(self):
        self.assertNotIn("secretoc", law.redact("https://x/?OC=secretoc&type=JSON secretoc", "secretoc"))

    def test_missing_oc_fails_without_network(self):
        with patch.object(law.urllib.request, "urlopen", side_effect=AssertionError("network called")):
            code, result = run(["search-law", "--query", "민법"])
        self.assertEqual(code, 2)
        self.assertEqual(result["error"]["code"], "not_connected")

    def test_catalog_is_local_and_api_rejects_undocumented_params(self):
        with patch.object(law.urllib.request, "urlopen", side_effect=AssertionError("network called")):
            code, result = run(["catalog", "--query", "판례", "--limit", "3"])
            self.assertEqual(code, 0)
            api_id = result["data"][0]["api_id"]
            code, result = run(["api", "--api-id", str(api_id), "--param", "undocumented=1"], {"LAW_OC": "testoc"})
        self.assertEqual(code, 2)
        self.assertEqual(result["error"]["code"], "invalid_input")

    def test_rejection_is_an_error_not_empty_result(self):
        class Response(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *a): return False
        body = json.dumps({"result": "실패", "msg": "미신청된 목록/본문에 대한 접근입니다."}).encode()
        with patch.object(law.urllib.request, "urlopen", return_value=Response(body)):
            code, result = run(["search-law", "--query", "민법"], {"LAW_OC": "testoc"})
        self.assertEqual(code, 2)
        self.assertEqual(result["error"]["code"], "law_api_rejected")


if __name__ == "__main__":
    unittest.main()
