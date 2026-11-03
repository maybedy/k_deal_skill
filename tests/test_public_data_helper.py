"""Offline contract tests for the portable Korean public-data helper."""

import contextlib
import atexit
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import urllib.parse


SCRIPT = Path(__file__).resolve().parents[1] / "plugins/k-deal-skill/skills/korean-public-data/scripts/api_fetch.py"
SPEC = importlib.util.spec_from_file_location("public_data_helper", SCRIPT)
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)
TEST_CONNECTION_DIR = tempfile.TemporaryDirectory(prefix="kds-public-test-config-")
atexit.register(TEST_CONNECTION_DIR.cleanup)
helper.credentials.DEFAULT_CONNECTION = Path(TEST_CONNECTION_DIR.name) / "absent.json"


def envelope(code="00", items=None, total=0, message="NORMAL SERVICE"):
    return json.dumps({"response": {"header": {"resultCode": code, "resultMsg": message}, "body": {"items": [] if items is None else items, "totalCount": total}}})


class IsolatedCredentialsTestCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        pointer = patch.object(helper.credentials, "DEFAULT_CONNECTION", Path(temporary.name) / "not-connected.json")
        pointer.start()
        self.addCleanup(pointer.stop)
        no_config_read = patch.object(helper.credentials, "_read_text", side_effect=AssertionError("These tests must never read host MCP configuration."))
        no_config_read.start()
        self.addCleanup(no_config_read.stop)


class KeyAndTransportTests(IsolatedCredentialsTestCase):
    def test_raw_and_encoded_keys_have_identical_single_encoding(self):
        raw = "a+b/c=d%end"
        encoded = urllib.parse.quote(raw, safe="")
        for env in ({"DATA_GO_KR_KEY": raw}, {"DATA_GO_KR_KEY_ENC": encoded}):
            url = helper.build_url(helper.ENDPOINTS["fsc-outline"], {"corpNm": "삼성전자"}, helper.encoded_key(env))
            self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)["serviceKey"], [raw])
            self.assertIn(f"serviceKey={encoded}&", url)
        self.assertEqual(helper.encoded_key({"DATA_GO_KR_KEY_ENC": "preferred%2Bkey", "DATA_GO_KR_KEY": "other"}), "preferred%2Bkey")

    def test_missing_or_malformed_key_fails_without_a_network_request(self):
        for env in ({}, {"DATA_GO_KR_KEY_ENC": "invalid%escape"}):
            with self.assertRaises(helper.PublicDataError):
                helper.fetch_api(helper.ENDPOINTS["fsc-outline"], {}, environ=env, opener=lambda *_a, **_k: self.fail("network called"))

    def test_single_request_preserves_raw_rows_and_safe_metadata(self):
        raw_rows = [{"basDt": "20260801", "bizYear": "2025", "fnclDcdNm": "연결", "enpSaleAmt": "001234"}]
        requests = []

        def open_fake(request, timeout):
            requests.append((request, timeout))
            return io.BytesIO(envelope(items={"item": raw_rows}, total=25).encode())

        result = helper.fetch_api(helper.ENDPOINTS["fsc-financials"], {"pageNo": 2, "numOfRows": 10, "crno": "1234567890123"}, environ={"DATA_GO_KR_KEY": "sensitive+key"}, opener=open_fake)
        self.assertEqual(len(requests), 1)
        self.assertEqual(result["items"], raw_rows)
        self.assertEqual(result["_meta"]["request"]["pageNo"], 2)
        self.assertEqual(result["_meta"]["source_url"], helper.ENDPOINTS["fsc-financials"])
        self.assertFalse(result["_meta"]["cache_hit"])
        self.assertFalse(result["_meta"]["auto_pagination"])
        self.assertIn("+00:00", result["_meta"]["fetched_at"])
        self.assertNotIn("sensitive", json.dumps(result))
        self.assertNotIn("serviceKey", json.dumps(result))

    def test_http_exception_does_not_leak_key_bearing_url(self):
        secret_url = "https://example.test/?serviceKey=hidden-secret"
        for error in (urllib.error.HTTPError(secret_url, 403, secret_url, None, None), urllib.error.URLError(secret_url)):
            with self.subTest(error=type(error).__name__):
                def fail(*_a, **_k):
                    raise error
                with self.assertRaises(helper.PublicDataError) as caught:
                    helper.fetch_api(helper.ENDPOINTS["fsc-outline"], {}, environ={"DATA_GO_KR_KEY": "hidden-secret"}, opener=fail)
                self.assertNotIn("hidden-secret", str(caught.exception))
                self.assertNotIn("https://", str(caught.exception))


class ResponseTests(IsolatedCredentialsTestCase):
    def test_partial_empty_and_normal_results_are_distinct(self):
        partial = helper.parse_response(envelope(items=[{"value": "1"}], total=20))
        empty = helper.parse_response(envelope(total=0))
        normal = helper.parse_response(envelope(items=[{"value": "1"}], total=1))
        self.assertEqual(partial["_meta"]["data_status"], "partial")
        self.assertTrue(partial["_meta"]["partial_result"])
        self.assertEqual(empty["_meta"]["data_status"], "no_data")
        self.assertEqual(normal["_meta"]["data_status"], "ok")

    def test_api_errors_never_become_zero_rows_or_echo_provider_messages(self):
        for raw in (envelope(code="30", message="secret-key"), '<OpenAPI_ServiceResponse><cmmMsgHeader><returnReasonCode>30</returnReasonCode><returnAuthMsg>secret-key</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>', "<html>secret-key</html>", json.dumps({"response": {"header": {"resultCode": "00"}}})):
            with self.subTest(raw=raw[:40]):
                with self.assertRaises(helper.PublicDataError) as caught:
                    helper.parse_response(raw)
                self.assertNotIn("secret-key", str(caught.exception))

    def test_xml_and_no_data_code_are_supported(self):
        result = helper.parse_response('<response><header><resultCode>00</resultCode></header><body><items><item><year>2025</year><value>0012</value></item></items><totalCount>1</totalCount></body></response>')
        self.assertEqual(result["items"], [{"year": "2025", "value": "0012"}])
        empty = helper.parse_response('{"response":{"header":{"resultCode":"03"}}}')
        self.assertEqual(empty["_meta"]["data_status"], "no_data")
        with self.assertRaises(helper.PublicDataError):
            helper.parse_response(envelope(code="03", items=[{"value": "1"}], total=1))

    def test_customs_preserves_total_and_detail_but_supplies_aggregation_note(self):
        rows = [{"year": "총계", "expDlr": "20"}, {"year": "2026.01", "expDlr": "20"}]
        result = helper.fetch_api(helper.ENDPOINTS["customs"], {"hsSgn": "3304"}, environ={"DATA_GO_KR_KEY": "fake"}, opener=lambda *_a, **_k: io.BytesIO(envelope(items=rows, total=2).encode()))
        self.assertEqual(result["items"], rows)
        self.assertIn("aggregation_note", result["_meta"])


class CatalogAndCliTests(IsolatedCredentialsTestCase):
    def test_status_needs_no_key_and_never_echoes_it(self):
        result = helper.status(environ={"DATA_GO_KR_KEY": "do-not-show"})
        self.assertTrue(result["credentials_present"]["DATA_GO_KR_KEY"])
        self.assertNotIn("snapshot", result)
        self.assertNotIn("do-not-show", json.dumps(result))

    def test_catalog_lists_operations_without_network(self):
        with patch.object(helper, "_read", side_effect=AssertionError("network called")):
            result = helper.catalog("주식발행")
        self.assertEqual(result["status"], "ok")
        self.assertTrue(all(row["operations"] for row in result["data"]))

    def test_call_sends_only_documented_params_with_single_encoded_key(self):
        seen = {}
        def opener(request, timeout=None):
            seen["url"], seen["method"] = request.full_url, request.get_method()
            return io.BytesIO(envelope(items=[{"crno": "1"}], total=1).encode())
        service = helper.load_catalog()["services"][0]
        op = service["operations"][0]
        params = {p["name"]: "20260101" for p in op["params"] if p["required"] and p["name"] not in helper.PAGING_DEFAULTS}
        result = helper.call(service["id"], op["id"], params, environ={"DATA_GO_KR_KEY": "a+b/c="}, opener=opener)
        self.assertEqual(result["items"], [{"crno": "1"}])
        self.assertIn("serviceKey=a%2Bb%2Fc%3D", seen["url"])
        self.assertNotIn("a%252B", seen["url"])
        self.assertEqual(seen["method"], "GET")
        self.assertNotIn("serviceKey", json.dumps(result["_meta"]))
        with self.assertRaises(helper.PublicDataError):
            helper.call(service["id"], op["id"], {**params, "undocumented": "1"}, environ={"DATA_GO_KR_KEY": "k"}, opener=opener)
        with self.assertRaises(helper.PublicDataError):
            helper.call("no_such_service", op["id"], {}, environ={"DATA_GO_KR_KEY": "k"}, opener=opener)

    def test_unapproved_key_is_an_error_not_zero_rows(self):
        service = helper.load_catalog()["services"][0]
        op = service["operations"][0]
        params = {p["name"]: "1" for p in op["params"] if p["required"]}
        with self.assertRaises(helper.PublicDataError):
            helper.call(service["id"], op["id"], params, environ={"DATA_GO_KR_KEY": "k"},
                        opener=lambda *_a, **_k: io.BytesIO(b"<OpenAPI_ServiceResponse>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</OpenAPI_ServiceResponse>"))

    def test_biz_status_posts_numbers_and_validates_input(self):
        seen = {}
        def opener(request, timeout=None):
            seen["method"], seen["body"] = request.get_method(), json.loads(request.data)
            return io.BytesIO(json.dumps({"status_code": "OK", "match_cnt": 1, "data": [{"b_no": "1234567890", "b_stt_cd": "01"}]}).encode())
        result = helper.biz_status(["123-45-67890", "1234567890"], environ={"DATA_GO_KR_KEY": "k"}, opener=opener)
        self.assertEqual(seen, {"method": "POST", "body": {"b_no": ["1234567890"]}})
        self.assertEqual(result["data"][0]["b_stt_cd"], "01")
        with self.assertRaises(helper.PublicDataError):
            helper.biz_status(["12345"], environ={"DATA_GO_KR_KEY": "k"}, opener=opener)

    def test_overbroad_customs_request_fails_before_fetch(self):
        args = helper.parser().parse_args(["customs", "--hs", "3304", "--start-ym", "202501", "--end-ym", "202601"])
        with patch.object(helper, "fetch_api", side_effect=AssertionError("network called")):
            with self.assertRaises(helper.PublicDataError):
                helper.dispatch(args)

    def test_cli_error_is_structured_without_traceback(self):
        errors = io.StringIO()
        with patch.dict(helper.os.environ, {}, clear=True), contextlib.redirect_stderr(errors):
            code = helper.main(["fsc-outline", "--corp-name", "테스트"])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(errors.getvalue())["error"]["type"], "public_data_error")
        self.assertNotIn("Traceback", errors.getvalue())


if __name__ == "__main__":
    unittest.main()
