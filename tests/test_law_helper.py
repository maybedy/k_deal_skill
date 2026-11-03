"""Offline behavioral tests for the portable law client."""
import importlib.util
import contextlib
import datetime as dt
import io
import json
from pathlib import Path
import unittest
from unittest import mock
import urllib.error

SCRIPT = (Path(__file__).parents[1] / "plugins/k-deal-skill/skills/korean-law-search/scripts/mcp_http.py")
SPEC = importlib.util.spec_from_file_location("law_helper", SCRIPT)
law = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(law)


class Response(io.BytesIO):
    def __init__(self, payload=b"", **headers):
        super().__init__(payload)
        self.headers = headers


class Opener:
    def __init__(self, responses):
        self.responses, self.requests = iter(responses), []

    def open(self, request, timeout):
        self.requests.append(request)
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return response


def rpc(result, ident=1):
    return json.dumps({"jsonrpc": "2.0", "id": ident, "result": result}).encode()


class LawClientTests(unittest.TestCase):
    def test_json_and_multiline_sse_select_matching_id(self):
        self.assertEqual(law.decode_response(rpc({"ok": True}), "application/json", 1)["result"], {"ok": True})
        raw = (b': keepalive\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'
               b'event: message\ndata: {"jsonrpc":"2.0",\ndata: "id":2,"result":{"ok":true}}\n\n')
        self.assertEqual(law.decode_response(raw, "text/event-stream", 2)["result"], {"ok": True})

    def test_invalid_or_oversized_response_is_error(self):
        for raw in (b"<html>unavailable</html>", b"x" * (law.MAX_RESPONSE_BYTES + 1)):
            with self.assertRaises(law.MCPError):
                law.decode_response(raw, "application/json", 1)

    def test_endpoint_validation_rejects_host_query_and_userinfo(self):
        for endpoint in ("http://mcp.gomdori.app/law", "https://mcp.gomdori.app.evil.test/law",
                         "https://mcp.gomdori.app/law?oc=secret", "https://evil@mcp.gomdori.app/law",
                         "https://mcp.gomdori.app/other"):
            with self.assertRaises(law.MCPError):
                law.LawClient(endpoint, api_key="secret")

    def test_redirect_handler_never_follows(self):
        self.assertIsNone(law.NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil.test"))

    def test_initialize_negotiates_and_carries_session_and_key_headers(self):
        opener = Opener([
            Response(rpc({"protocolVersion": "2025-03-26", "serverInfo": {"version": "4.15.9"}}),
                     **{"Content-Type": "application/json", "Mcp-Session-Id": "session-123"}),
            Response(), Response(rpc({"tools": []}, 3), **{"Content-Type": "application/json"}),
        ])
        client = law.LawClient(api_key="secret", opener=opener)
        client.initialize()
        client.tools_list()
        for request in opener.requests:
            self.assertNotIn("secret", request.full_url)
            self.assertNotIn(b"secret", request.data)
            self.assertEqual(dict(request.header_items())["Apikey"], "secret")
        self.assertEqual(dict(opener.requests[2].header_items())["Mcp-session-id"], "session-123")
        self.assertEqual(dict(opener.requests[2].header_items())["Mcp-protocol-version"], "2025-03-26")

    def test_unsupported_protocol_stops_before_tool_call(self):
        opener = Opener([Response(rpc({"protocolVersion": "2099-01-01"}), **{"Content-Type": "application/json"})])
        with self.assertRaisesRegex(law.MCPError, "unsupported"):
            law.LawClient(api_key="", opener=opener).initialize()
        self.assertEqual(len(opener.requests), 1)

    def test_auth_http_error_does_not_print_response_body(self):
        body = io.BytesIO(b"echo secret")
        error = urllib.error.HTTPError(law.DEFAULT_ENDPOINT, 401, "", {}, body)
        with self.assertRaisesRegex(law.MCPError, "LAW_OC") as caught:
            law.LawClient(api_key="secret", opener=Opener([error])).tools_list()
        self.assertNotIn("secret", str(caught.exception))
        self.assertTrue(body.closed)

    def test_rpc_tool_error_redacts_key_and_is_not_empty_result(self):
        result = {"isError": True, "content": [{"type": "text", "text": "key=private-key rejected"}]}
        client = law.LawClient(api_key="private-key", opener=Opener([Response(rpc(result), **{"Content-Type": "application/json"})]))
        with self.assertRaisesRegex(law.MCPError, "not zero results") as caught:
            client.call("search_law", {"query": "민법"})
        self.assertNotIn("private-key", str(caught.exception))
        self.assertIn("[REDACTED]", str(caught.exception))

    def test_rejects_arbitrary_or_proxy_tools_before_network(self):
        opener = Opener([])
        for tool in ("delete_law", "execute_tool"):
            with self.assertRaises(law.MCPError):
                law.LawClient(api_key="", opener=opener).call(tool, {})
        self.assertEqual(opener.requests, [])

    def test_credential_arguments_rejected_recursively(self):
        for arguments in ({"apiKey": "secret"}, {"options": {"LAW_OC": "secret"}}, []):
            with self.assertRaises(law.MCPError):
                law.validate_arguments(arguments)

    def test_redacts_plain_encoded_and_url_credentials(self):
        self.assertNotIn("s%2Becret", law.redact("s%2Becret", "s+ecret"))
        self.assertEqual(law.redact("https://www.law.go.kr/?OC=hidden&ID=1"),
                         "https://www.law.go.kr/?OC=[REDACTED]&ID=1")

    def test_redacted_output_remains_valid_json_with_quote_in_secret(self):
        encoded = json.dumps(law.redact_result({"result": ['value="secret"']}, '"secret"'))
        self.assertEqual(json.loads(encoded), {"result": ["value=[REDACTED]"]})

    def test_cli_emits_parseable_utc_collection_time(self):
        output = io.StringIO()
        client = mock.Mock(endpoint=law.DEFAULT_ENDPOINT, protocol="2025-03-26",
                           server_info={"version": "4.15.9"})
        client.initialize.return_value = {"protocolVersion": "2025-03-26"}
        before = dt.datetime.now(dt.timezone.utc)
        with mock.patch.object(law, "LawClient", return_value=client), \
                mock.patch.dict(law.os.environ, {"LAW_OC": ""}), \
                contextlib.redirect_stdout(output):
            self.assertEqual(law.main(["initialize"]), 0)
        after = dt.datetime.now(dt.timezone.utc)
        fetched_at = dt.datetime.fromisoformat(json.loads(output.getvalue())["fetched_at"])
        self.assertEqual(fetched_at.utcoffset(), dt.timedelta(0))
        self.assertLessEqual(before, fetched_at)
        self.assertLessEqual(fetched_at, after)


if __name__ == "__main__":
    unittest.main()
