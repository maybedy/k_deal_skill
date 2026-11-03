#!/usr/bin/env python3
"""Small read-only MCP HTTP client for the anonymous law-only connection (/law) of the Market Research server.

For users without their own LAW_OC. The server answers from the 법제처 Open API with the operator's OC; this client
never sends a key. Original implementation with no third-party dependencies.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# Operator's public /law address. Empty until the server has a public domain; K_DEAL_LAW_ENDPOINT overrides it
# (for example a self-hosted Market Research server).
PUBLIC_LAW_ENDPOINT = ""
DEFAULT_ENDPOINT = os.environ.get("K_DEAL_LAW_ENDPOINT", "").strip() or PUBLIC_LAW_ENDPOINT
SUPPORTED_PROTOCOLS = ("2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26")
READ_ONLY_TOOLS = frozenset({
    "law_search", "law_text", "law_decisions_search", "law_decision_text", "law_catalog", "law_api",
})
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_ARGUMENT_BYTES = 100 * 1024
AUTH_FIELDS = frozenset({"apikey", "api_key", "law_oc", "oc", "authorization", "token"})


class MCPError(Exception):
    """An actionable, bounded error that is safe to show after redaction."""


def redact(text: str, secret: str = "") -> str:
    if secret:
        for value in {secret, urllib.parse.quote(secret, safe=""),
                      urllib.parse.quote_plus(secret), json.dumps(secret)[1:-1]}:
            text = text.replace(value, "[REDACTED]")
    return re.sub(
        r"(?i)([?&](?:oc|api_?key|token)=)[^&\s\"<>]+",
        r"\1[REDACTED]", text,
    )


def redact_result(value: object, secret: str = "") -> object:
    """Redact before JSON serialization, so quote-bearing keys cannot break JSON."""
    if isinstance(value, str):
        return redact(value, secret)
    if isinstance(value, list):
        return [redact_result(item, secret) for item in value]
    if isinstance(value, dict):
        return {str(key): redact_result(item, secret) for key, item in value.items()}
    return value


def validate_endpoint(endpoint: str) -> str:
    if not endpoint:
        raise MCPError("No remote law server is configured yet. Issue a LAW_OC at open.law.go.kr and use scripts/law_fetch.py.")
    parts = urllib.parse.urlsplit(endpoint)
    if (parts.scheme != "https" or not parts.hostname or parts.username or parts.password
            or parts.query or parts.fragment or not parts.path.endswith("/law")):
        raise MCPError("The law endpoint must be a plain https://<host>/law address with no credentials or query.")
    return endpoint


def validate_arguments(arguments: object) -> dict:
    if not isinstance(arguments, dict):
        raise MCPError("Tool arguments must be a JSON object.")
    if len(json.dumps(arguments, ensure_ascii=False).encode()) > MAX_ARGUMENT_BYTES:
        raise MCPError("Tool arguments exceed the 100 KiB limit.")

    def visit(value: object) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                if key.lower() in AUTH_FIELDS:
                    raise MCPError("Pass credentials through LAW_OC only, never tool arguments.")
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)
    visit(arguments)
    return arguments


def decode_response(raw: bytes, content_type: str, request_id: int) -> dict | None:
    """Select the matching JSON-RPC response, ignoring SSE progress notifications."""
    if len(raw) > MAX_RESPONSE_BYTES:
        raise MCPError("MCP response exceeds the 2 MiB limit.")
    if not raw.strip():
        return None
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise MCPError("MCP returned non-UTF-8 data.") from exc
    if "text/event-stream" in content_type or text.lstrip().startswith(("event:", "data:", ":")):
        events, parts = [], []
        for line in text.splitlines() + [""]:
            if not line:
                if parts:
                    events.append("\n".join(parts))
                    parts = []
            elif line.startswith("data:"):
                parts.append(line[5:].lstrip(" "))
    else:
        events = [text]
    for event in events:
        if event.strip() == "[DONE]":
            continue
        try:
            payload = json.loads(event)
        except json.JSONDecodeError as exc:
            raise MCPError("MCP returned invalid JSON, possibly an upstream error page.") from exc
        messages = payload if isinstance(payload, list) else [payload]
        for message in messages:
            if isinstance(message, dict) and message.get("id") == request_id:
                if message.get("jsonrpc") != "2.0" or not ({"result", "error"} & message.keys()):
                    raise MCPError("Invalid JSON-RPC response envelope.")
                return message
    return None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Refuse even same-origin redirects so session headers cannot leak.
        return None


class LawClient:
    def __init__(self, endpoint: str = DEFAULT_ENDPOINT, timeout: float = 25, opener=None):
        self.endpoint = validate_endpoint(endpoint)
        if not 1 <= timeout <= 60:
            raise MCPError("Timeout must be between 1 and 60 seconds.")
        self.timeout = timeout
        # Only used to redact; the key itself is never sent to the remote server.
        self.api_key = os.environ.get("LAW_OC", "")
        self.opener = opener or urllib.request.build_opener(NoRedirect())
        self.session_id = None
        self.protocol = None
        self.server_info = None
        self.next_id = 1

    def _safe_message(self, value: object) -> str:
        return redact(str(value), self.api_key)[:1500]

    def _post(self, method: str, params: dict, notification: bool = False):
        request_id = self.next_id
        self.next_id += 1
        payload = {"jsonrpc": "2.0", "method": method, "params": params}
        if not notification:
            payload["id"] = request_id
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if self.protocol:
            headers["MCP-Protocol-Version"] = self.protocol
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        request = urllib.request.Request(self.endpoint, json.dumps(payload).encode(), headers, method="POST")
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                session = response.headers.get("Mcp-Session-Id")
                if session:
                    if len(session) > 1024 or not all(32 <= ord(c) < 127 for c in session):
                        raise MCPError("MCP returned an invalid session header.")
                    self.session_id = session
                if notification:
                    return None
                content_type = response.headers.get("Content-Type", "")
                if "text/event-stream" in content_type:
                    # Stop at the matching event; an SSE stream need not close.
                    deadline, total, event = time.monotonic() + self.timeout, 0, bytearray()
                    message = None
                    while time.monotonic() < deadline:
                        line = response.readline(MAX_RESPONSE_BYTES - total + 1)
                        total += len(line)
                        if total > MAX_RESPONSE_BYTES:
                            raise MCPError("MCP response exceeds the 2 MiB limit.")
                        event.extend(line)
                        if not line.strip():
                            message = decode_response(bytes(event), content_type, request_id)
                            event.clear()
                            if message is not None:
                                break
                        if not line:
                            break
                    if message is None and event:
                        message = decode_response(bytes(event), content_type, request_id)
                else:
                    message = decode_response(response.read(MAX_RESPONSE_BYTES + 1), content_type, request_id)
        except urllib.error.HTTPError as exc:
            # HTTPError owns the response stream even when its body is not read.
            exc.close()
            if exc.code in (401, 403):
                raise MCPError("Access denied (HTTP %s). The remote law connection may be closed; issue a LAW_OC and use scripts/law_fetch.py." % exc.code) from None
            if exc.code == 429:
                raise MCPError("Per-IP limit of the shared law connection reached (HTTP 429). Wait, or issue a LAW_OC and use scripts/law_fetch.py; this is not an empty search result.") from None
            if 300 <= exc.code < 400:
                raise MCPError("HTTP redirect refused; no credentials were forwarded to the redirect target.") from None
            if exc.code == 404 and self.session_id:
                raise MCPError("MCP session expired or endpoint unavailable (HTTP 404); start a fresh invocation.") from None
            raise MCPError("MCP HTTP error %s; no response body logged." % exc.code) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise MCPError("MCP network request failed or timed out. Check runtime HTTPS access to the configured endpoint.") from None
        if message is None:
            raise MCPError("MCP returned no matching JSON-RPC response.")
        if "error" in message:
            error = message["error"]
            raise MCPError("MCP error: " + self._safe_message(error))
        return message["result"]

    def initialize(self) -> dict:
        result = self._post("initialize", {
            "protocolVersion": SUPPORTED_PROTOCOLS[0], "capabilities": {},
            "clientInfo": {"name": "k-deal-skill-law-client", "version": "1.1.0"},
        })
        if not isinstance(result, dict) or result.get("protocolVersion") not in SUPPORTED_PROTOCOLS:
            raise MCPError("Server negotiated an unsupported MCP protocol; update the client after review.")
        self.protocol = result["protocolVersion"]
        self.server_info = result.get("serverInfo", {})
        self._post("notifications/initialized", {}, notification=True)
        return result

    def tools_list(self) -> dict:
        return self._post("tools/list", {})

    def call(self, name: str, arguments: dict) -> dict:
        if name not in READ_ONLY_TOOLS:
            raise MCPError("Tool is not in this client's read-only allowlist.")
        result = self._post("tools/call", {"name": name, "arguments": validate_arguments(arguments)})
        if isinstance(result, dict) and result.get("isError"):
            raise MCPError("Law lookup failed (not zero results): " + self._safe_message(result.get("content", [])))
        return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT, help="https://<host>/law; defaults to K_DEAL_LAW_ENDPOINT or the operator server")
    parser.add_argument("--timeout", type=float, default=25, help="Per-request timeout, 1–60 seconds")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("initialize")
    commands.add_parser("tools-list")
    search = commands.add_parser("search-law")
    search.add_argument("--query", required=True)
    search.add_argument("--display", type=int, default=10, choices=range(1, 51), metavar="1..50")
    law = commands.add_parser("law-text")
    identifier = law.add_mutually_exclusive_group(required=True)
    identifier.add_argument("--mst")
    identifier.add_argument("--law-id")
    law.add_argument("--article")
    law.add_argument("--date", help="As-of date YYYYMMDD; omit for current text")
    call = commands.add_parser("call", help="Call a vetted read-only top-level tool")
    call.add_argument("tool", choices=sorted(READ_ONLY_TOOLS))
    call.add_argument("--arguments", default="{}", help="JSON object; never include credentials")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    key = os.environ.get("LAW_OC", "")
    try:
        if args.command == "call":
            try:
                arguments = validate_arguments(json.loads(args.arguments))
            except json.JSONDecodeError:
                raise MCPError("--arguments is not valid JSON.") from None
        elif args.command == "law-text":
            arguments = {"mst": args.mst} if args.mst else {"law_id": args.law_id}
            if args.article:
                arguments["article"] = args.article
            if args.date:
                try:
                    if not re.fullmatch(r"\d{8}", args.date):
                        raise ValueError
                    dt.datetime.strptime(args.date, "%Y%m%d")
                except ValueError:
                    raise MCPError("--date must be a valid YYYYMMDD date.") from None
                arguments["date"] = args.date
        client = LawClient(args.endpoint, args.timeout)
        result = client.initialize()
        if args.command == "tools-list":
            result = client.tools_list()
        elif args.command == "search-law":
            result = client.call("law_search", {"query": args.query, "display": args.display})
        elif args.command == "law-text":
            result = client.call("law_text", arguments)
        elif args.command == "call":
            result = client.call(args.tool, arguments)
        output = {"endpoint": client.endpoint,
                  "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                  "protocol_version": client.protocol,
                  "server": client.server_info, "result": result}
        print(json.dumps(redact_result(output, key), ensure_ascii=False, indent=2))
        return 0
    except (MCPError, RecursionError) as exc:
        message = "JSON nesting is too deep." if isinstance(exc, RecursionError) else str(exc)
        print(json.dumps({"error": redact(message, key)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
