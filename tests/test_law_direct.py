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


    def routed(self, routes):
        class Response(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *a): return False
        seen = []
        def urlopen(req, timeout):
            url = law.urllib.parse.urlsplit(req.full_url)
            params = dict(law.urllib.parse.parse_qsl(url.query))
            seen.append((url.path, params))
            for match, body in routes:
                if match(url.path, params):
                    return Response(body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode())
            raise AssertionError("unexpected request")
        return seen, urlopen

    def test_article_notation_variants(self):
        for text in ("제750조제1항", "제750조 제1항 제2호", "第750條", "075000", "750조"):
            self.assertEqual(law.jo_code(text), "075000")
        self.assertEqual(law.jo_code("제10조-2"), "001002")
        self.assertIsNone(law.jo_code("제0조"))

    def test_law_id_with_date_reads_the_version_in_force_and_one_article(self):
        versions = {"LawSearch": {"totalCnt": "2", "law": [
            {"법령일련번호": "284415", "시행일자": "20260317", "공포일자": "20260317", "현행연혁코드": "현행", "법령명한글": "민법"},
            {"법령일련번호": "198475", "시행일자": "20180201", "공포일자": "20171031", "현행연혁코드": "연혁", "법령명한글": "민법"}]}}
        unit = lambda kind, no="750": {"조문번호": no, "조문여부": kind}
        body = {"법령": {"기본정보": {}, "조문": {"조문단위": [unit("전문"), unit("조문"), unit("조문", "751")]}}}
        seen, urlopen = self.routed([(lambda p, q: p.endswith("lawSearch.do"), versions), (lambda p, q: True, body)])
        with patch.object(law.urllib.request, "urlopen", side_effect=urlopen):
            code, result = run(["law-text", "--law-id", "001706", "--article", "제750조", "--date", "20200615"], {"LAW_OC": "testoc"})
        self.assertEqual(code, 0)
        self.assertEqual((seen[0][1]["target"], seen[0][1]["LID"]), ("eflaw", "001706"))
        self.assertEqual((seen[1][1]["MST"], seen[1][1]["efYd"], seen[1][1]["JO"]), ("198475", "20180201", "075000"))
        self.assertNotIn("ID", seen[1][1])
        self.assertEqual(result["metadata"]["version"]["effective"], "20180201")
        self.assertEqual(result["data"]["법령"]["조문"]["조문단위"], [unit("조문")])

    def test_empty_or_message_only_bodies_are_not_found(self):
        for argv, body in ((["law-text", "--mst", "246569", "--date", "20230101"], {}),
                           (["decision-text", "--domain", "precedent", "--id", "9"], {"Law": "일치하는 판례가 없습니다."})):
            _, urlopen = self.routed([(lambda p, q: True, body)])
            with patch.object(law.urllib.request, "urlopen", side_effect=urlopen):
                code, result = run(argv, {"LAW_OC": "testoc"})
            self.assertEqual((code, result["error"]["code"]), (2, "not_found"))
        _, urlopen = self.routed([(lambda p, q: True, b"")])
        with patch.object(law.urllib.request, "urlopen", side_effect=urlopen):
            code, result = run(["decision-text", "--domain", "precedent", "--id", "9"], {"LAW_OC": "testoc"})
        self.assertEqual(result["error"]["code"], "law_api_empty")

    def test_addenda_only_latest_first(self):
        body = {"법령": {"기본정보": {"법령명_한글": "상법"}, "조문": {"조문단위": []},
                       "부칙": {"부칙단위": [{"부칙공포일자": "19620120"}, {"부칙공포일자": "20250909"}]}}}
        _, urlopen = self.routed([(lambda p, q: True, body)])
        with patch.object(law.urllib.request, "urlopen", side_effect=urlopen):
            code, result = run(["law-text", "--law-id", "001702", "--article", "부칙"], {"LAW_OC": "testoc"})
        self.assertEqual(list(result["data"]["법령"]), ["기본정보", "부칙"])
        self.assertEqual([u["부칙공포일자"] for u in result["data"]["법령"]["부칙"]["부칙단위"]], ["20250909", "19620120"])

    def test_brief_503_is_retried(self):
        class Response(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *a): return False
        calls = []
        def urlopen(req, timeout):
            calls.append(1)
            if len(calls) == 1:
                raise law.urllib.error.HTTPError(req.full_url, 503, "busy", {}, io.BytesIO(b""))
            return Response(json.dumps({"LawSearch": {"totalCnt": "0"}}).encode())
        with patch.object(law.urllib.request, "urlopen", side_effect=urlopen), patch.object(law.time, "sleep"):
            code, _ = run(["search-law", "--query", "상법"], {"LAW_OC": "testoc"})
        self.assertEqual((code, len(calls)), (0, 2))


if __name__ == "__main__":
    unittest.main()
