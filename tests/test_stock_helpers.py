"""Offline contract tests: official request routing, provenance and failure handling."""
from contextlib import redirect_stdout
import atexit
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import urllib.parse
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / "plugins" / "k-deal-skill" / "skills"
TEST_CONNECTION_DIR = tempfile.TemporaryDirectory(prefix="kds-stock-test-config-")
atexit.register(TEST_CONNECTION_DIR.cleanup)


def load_script(name, relative):
    spec = importlib.util.spec_from_file_location(name, SKILLS / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.credentials.DEFAULT_CONNECTION = Path(TEST_CONNECTION_DIR.name) / "absent.json"
    return module


dart = load_script("kds_dart_fetch", "korean-dart-research/scripts/dart_fetch.py")
krx = load_script("kds_krx_fetch", "krx-market-data/scripts/krx_fetch.py")


def json_response(data):
    return io.BytesIO(json.dumps(data).encode())


def zip_bytes(entries):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        for name, value in entries:
            archive.writestr(name, value)
    return stream.getvalue()


class IsolatedCredentialsTestCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        missing = Path(temporary.name) / "not-connected.json"
        for module in (dart, krx):
            pointer = patch.object(module.credentials, "DEFAULT_CONNECTION", missing)
            pointer.start()
            self.addCleanup(pointer.stop)
            no_config_read = patch.object(module.credentials, "_read_text", side_effect=AssertionError("These tests must never read host MCP configuration."))
            no_config_read.start()
            self.addCleanup(no_config_read.stop)


class DartTests(IsolatedCredentialsTestCase):
    def test_financial_request_preserves_report_basis_ids_and_raw_amounts(self):
        payload = {"status": "000", "message": "정상", "list": [{"rcept_no": "20260318000001", "account_id": "ifrs-full_Revenue", "thstrm_amount": "1,234"}]}
        with patch.dict(os.environ, {"DART_API_KEY": "test-key"}, clear=True), patch.object(dart.urllib.request, "urlopen", return_value=json_response(payload)) as transport, redirect_stdout(io.StringIO()) as output:
            exit_code = dart.main(["financials", "--corp-code", "00126380", "--year", "2025", "--report", "11014", "--fs-div", "OFS"])
        self.assertEqual(exit_code, 0)
        request = transport.call_args.args[0]
        parsed = urllib.parse.urlsplit(request.full_url)
        self.assertEqual(parsed.path, "/api/fnlttSinglAcntAll.json")
        self.assertEqual(urllib.parse.parse_qs(parsed.query), {"corp_code": ["00126380"], "bsns_year": ["2025"], "reprt_code": ["11014"], "fs_div": ["OFS"], "crtfc_key": ["test-key"]})
        result = json.loads(output.getvalue())
        self.assertEqual(result["data"]["list"][0]["thstrm_amount"], "1,234")
        self.assertEqual(result["source"]["request"]["fs_div"], "OFS")
        self.assertNotIn("test-key", output.getvalue())
        self.assertIn("fetched_at", result["source"])

    def test_credentials_are_environment_only_and_alias_is_supported(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(Path, "read_text", side_effect=AssertionError("must not read configuration")):
            with self.assertRaises(dart.DartError) as ctx:
                dart.load_key()
        self.assertEqual(ctx.exception.code, "not_connected")
        with patch.dict(os.environ, {"OPENDART_API_KEY": "alias-key"}, clear=True):
            self.assertEqual(dart.load_key(), "alias-key")

    def test_no_data_is_not_credential_or_quota_error(self):
        with patch.object(dart.urllib.request, "urlopen", return_value=json_response({"status": "013", "message": "조회된 데이타가 없습니다."})):
            self.assertEqual(dart.get_json("list.json", "secret", {})["status"], "empty")
        for code in ("010", "020", "800"):
            with self.subTest(code=code), patch.object(dart.urllib.request, "urlopen", return_value=json_response({"status": code, "message": "provider rejected request"})):
                with self.assertRaises(dart.DartError) as ctx:
                    dart.get_json("list.json", "secret", {})
                self.assertEqual(ctx.exception.code, f"dart_{code}")

    def test_error_redacts_key_and_entire_signed_url(self):
        secret = "secret/key+value"
        body = {"status": "010", "message": f"bad {secret} https://host.invalid/request?signature=opaque&crtfc_key={urllib.parse.quote(secret, safe='')}"}
        with patch.object(dart.urllib.request, "urlopen", return_value=json_response(body)):
            with self.assertRaises(dart.DartError) as ctx:
                dart.get_json("list.json", secret, {})
        message = str(ctx.exception)
        self.assertNotIn(secret, message)
        self.assertNotIn("opaque", message)
        self.assertNotIn("https://", message)

    def test_http_error_body_and_transport_url_never_leak(self):
        error = urllib.error.HTTPError("https://host.invalid/?crtfc_key=secret", 401, "secret", {}, io.BytesIO(b"secret signed-url"))
        with patch.object(dart.urllib.request, "urlopen", side_effect=error):
            with self.assertRaises(dart.DartError) as ctx:
                dart.request_bytes("list.json", "secret", {})
        self.assertEqual(ctx.exception.code, "http_401")
        self.assertNotIn("secret", str(ctx.exception))
        with patch.object(dart.urllib.request, "urlopen", side_effect=urllib.error.URLError("https://host.invalid/?key=secret")):
            with self.assertRaises(dart.DartError) as ctx:
                dart.request_bytes("list.json", "secret", {})
        self.assertNotIn("secret", str(ctx.exception))

    def test_pagination_marks_bounded_inventory_incomplete(self):
        first = {"status": "000", "total_page": 2, "total_count": 2, "list": [{"rcept_no": "20260101000001"}]}
        second = {**first, "list": [{"rcept_no": "20260102000001"}]}
        params = {"corp_code": "00126380", "bgn_de": "20260101", "end_de": "20260930", "page_no": "1", "page_count": "1"}
        with patch.object(dart.urllib.request, "urlopen", return_value=json_response(first)):
            result = dart.disclosures("key", params, all_pages=True, max_pages=1)
        self.assertFalse(result["pagination"]["complete"])
        with patch.object(dart.urllib.request, "urlopen", side_effect=[json_response(first), json_response(second)]) as transport:
            result = dart.disclosures("key", params, all_pages=True, max_pages=2)
        self.assertTrue(result["pagination"]["complete"])
        self.assertEqual(len(result["data"]), 2)
        page_queries = [urllib.parse.parse_qs(urllib.parse.urlsplit(call.args[0].full_url).query)["page_no"][0] for call in transport.call_args_list]
        self.assertEqual(page_queries, ["1", "2"])

    def test_failed_later_page_is_not_partial_success(self):
        first = {"status": "000", "total_page": 2, "total_count": 2, "list": [{"rcept_no": "20260101000001"}]}
        with patch.object(dart.urllib.request, "urlopen", side_effect=[json_response(first), json_response({"status": "020", "message": "quota"})]):
            with self.assertRaises(dart.DartError) as ctx:
                dart.disclosures("key", {"page_no": "1"}, all_pages=True)
        self.assertEqual(ctx.exception.code, "dart_020")

    def test_company_codes_keep_source_change_date(self):
        raw = zip_bytes([("CORPCODE.xml", "<result><list><corp_code>00126380</corp_code><corp_name>삼성전자</corp_name><stock_code>005930</stock_code><modify_date>20261020</modify_date></list></result>")])
        with patch.object(dart.urllib.request, "urlopen", return_value=io.BytesIO(raw)):
            result = dart.corp_code("삼성", "key")
        self.assertEqual(result["data"][0]["modify_date"], "20261020")
        self.assertEqual(result["source"]["endpoint"], "https://opendart.fss.or.kr/api/corpCode.xml")

    def test_archive_no_data_is_empty_without_creating_output_directory(self):
        raw = b"<result><status>013</status><message>No data</message></result>"
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "empty-filing"
            with patch.dict(os.environ, {"DART_API_KEY": "key"}, clear=True), patch.object(dart.urllib.request, "urlopen", return_value=io.BytesIO(raw)), redirect_stdout(io.StringIO()) as output:
                exit_code = dart.main(["document", "--rcept-no", "20260101000001", "--out", str(destination)])
            self.assertEqual(exit_code, 0)
            self.assertEqual(json.loads(output.getvalue())["status"], "empty")
            self.assertFalse(destination.exists())

    def test_archive_traversal_rejected_before_any_write(self):
        for malicious in ("../outside.xml", "/absolute.xml", "..\\outside.xml", "C:/outside.xml"):
            with self.subTest(member=malicious), tempfile.TemporaryDirectory() as directory:
                destination = Path(directory) / "out"
                raw = zip_bytes([("good.xml", "ok"), (malicious, "bad")])
                with self.assertRaises(dart.DartError) as ctx:
                    dart.extract_archive(raw, destination)
                self.assertEqual(ctx.exception.code, "unsafe_archive")
                self.assertFalse(destination.exists())

    def test_archive_symlink_and_existing_parent_escape_rejected(self):
        symlink = zipfile.ZipInfo("link")
        symlink.create_system = 3
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.assertRaises(dart.DartError):
            dart.archive_members(zip_bytes([(symlink, "../outside")]))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            destination, outside = root / "out", root / "outside"
            destination.mkdir()
            outside.mkdir()
            (destination / "redirect").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(dart.DartError):
                dart.extract_archive(zip_bytes([("redirect/file.xml", "bad")]), destination)
            self.assertFalse((outside / "file.xml").exists())

    def test_archive_extracts_nested_files_without_overwriting(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "out"
            raw = zip_bytes([("notes/note.xml", "<note>리스</note>")])
            self.assertEqual(dart.extract_archive(raw, destination), ["notes/note.xml"])
            self.assertEqual((destination / "notes/note.xml").read_text(), "<note>리스</note>")
            with self.assertRaises(dart.DartError) as ctx:
                dart.extract_archive(raw, destination)
            self.assertEqual(ctx.exception.code, "output_exists")


class KrxTests(IsolatedCredentialsTestCase):
    def test_routes_use_header_auth_explicit_date_and_market_field(self):
        expected = {
            ("trade", "KOSPI"): "stk_bydd_trd", ("trade", "KOSDAQ"): "ksq_bydd_trd", ("trade", "KONEX"): "knx_bydd_trd",
            ("base", "KOSPI"): "stk_isu_base_info", ("base", "KOSDAQ"): "ksq_isu_base_info", ("base", "KONEX"): "knx_isu_base_info",
        }
        for (operation, market), route in expected.items():
            field = "ISU_CD" if operation == "trade" else "ISU_SRT_CD"
            payload = {"OutBlock_1": [{field: "005930", "BAS_DD": "20261021", "TDD_CLSPRC": "70,000"}, {field: "000660"}]}
            with self.subTest(operation=operation, market=market), patch.object(krx.urllib.request, "urlopen", return_value=json_response(payload)) as transport:
                result = krx.fetch(operation, market, "20261021", ["005930", "999999"], "secret-key")
            request = transport.call_args.args[0]
            parsed = urllib.parse.urlsplit(request.full_url)
            self.assertEqual(parsed.scheme, "https")
            self.assertTrue(parsed.path.endswith(route))
            self.assertEqual(urllib.parse.parse_qs(parsed.query), {"basDd": ["20261021"]})
            self.assertEqual(request.get_header("Auth_key"), "secret-key")
            self.assertEqual(result["data"][0]["TDD_CLSPRC"], "70,000")
            self.assertEqual(result["coverage"]["unmatched_codes"], ["999999"])
            self.assertEqual(result["source"]["market"], market)
            self.assertNotIn("secret-key", json.dumps(result))

    def test_empty_rows_and_invalid_provider_reply_are_distinct(self):
        with patch.object(krx.urllib.request, "urlopen", return_value=json_response({"OutBlock_1": []})):
            result = krx.fetch("trade", "KOSPI", "20261021", ["005930"], "key")
        self.assertEqual(result["status"], "empty")
        self.assertEqual(result["source"]["basDd"], "20261021")
        self.assertNotIn("holiday", json.dumps(result))
        for data in ({"error": "invalid key"}, {"OutBlock_1": ""}, {"OutBlock_1": [{}]}):
            with self.subTest(reply=data), patch.object(krx.urllib.request, "urlopen", return_value=json_response(data)):
                with self.assertRaises(krx.KrxError) as ctx:
                    krx.fetch("trade", "KOSPI", "20261021", ["005930"], "key")
                self.assertEqual(ctx.exception.code, "invalid_response")

    def test_http_error_does_not_expose_credential_or_body(self):
        error = urllib.error.HTTPError("https://host.invalid/?signature=opaque", 403, "secret-key", {}, io.BytesIO(b"secret-key"))
        with patch.object(krx.urllib.request, "urlopen", side_effect=error):
            with self.assertRaises(krx.KrxError) as ctx:
                krx.fetch("trade", "KOSPI", "20261021", ["005930"], "secret-key")
        self.assertNotIn("secret-key", str(ctx.exception))
        self.assertNotIn("opaque", str(ctx.exception))

    def test_multi_date_failure_is_nonzero_and_preserves_successful_date(self):
        error = urllib.error.URLError("do not expose upstream reason")
        with patch.dict(os.environ, {"KRX_API_KEY": "key"}, clear=True), patch.object(krx.urllib.request, "urlopen", side_effect=[json_response({"OutBlock_1": [{"ISU_CD": "005930"}]}), error]), redirect_stdout(io.StringIO()) as output:
            exit_code = krx.main(["trade", "--market", "KOSPI", "--date", "20261020", "--date", "20261021", "--code", "005930"])
        result = json.loads(output.getvalue())
        self.assertEqual(exit_code, 2)
        self.assertEqual(result["status"], "partial_error")
        self.assertEqual(result["results"][0]["source"]["basDd"], "20261020")
        self.assertEqual(result["results"][1]["source"]["basDd"], "20261021")
        self.assertEqual(result["results"][1]["error"]["code"], "transport_error")

    def test_presence_status_does_not_fetch_or_print_keys(self):
        for module, names in ((dart, {"DART_API_KEY": "dart-secret", "OPENDART_API_KEY": ""}), (krx, {"KRX_API_KEY": "krx-secret"})):
            with self.subTest(module=module.__name__), patch.dict(os.environ, names, clear=True), patch.object(module.urllib.request, "urlopen", side_effect=AssertionError("must not contact provider")), redirect_stdout(io.StringIO()) as output:
                self.assertEqual(module.main(["env-status"]), 0)
            result = json.loads(output.getvalue())
            self.assertTrue(all(isinstance(value, bool) for value in result["credentials_present"].values()))
            self.assertNotIn("secret", output.getvalue())


if __name__ == "__main__":
    unittest.main()
