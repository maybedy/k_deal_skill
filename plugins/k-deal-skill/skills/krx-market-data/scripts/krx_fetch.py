#!/usr/bin/env python3
"""Official KRX data with explicit dates and env or opt-in local MCP credentials."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

_credential_spec = importlib.util.spec_from_file_location("kds_krx_credentials", Path(__file__).with_name("source_credentials.py"))
credentials = importlib.util.module_from_spec(_credential_spec)
_credential_spec.loader.exec_module(credentials)

BASE = "https://data-dbg.krx.co.kr/svc/apis"
API_CATALOG = Path(__file__).resolve().parents[1] / "references" / "krx-apis.json"
ROUTES = {
    "trade": {"KOSPI": "stk_bydd_trd", "KOSDAQ": "ksq_bydd_trd", "KONEX": "knx_bydd_trd"},
    "base": {"KOSPI": "stk_isu_base_info", "KOSDAQ": "ksq_isu_base_info", "KONEX": "knx_isu_base_info"},
}


class KrxError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def load_key() -> str:
    resolution = credentials.resolve("krx")
    key = resolution.values.get("KRX_API_KEY", "")
    if not key:
        raise KrxError("not_connected", credentials.missing_message(resolution, "KRX_API_KEY"))
    return key


def date_arg(value: str) -> str:
    if not re.fullmatch(r"\d{8}", value):
        raise argparse.ArgumentTypeError("Use YYYYMMDD.")
    try:
        datetime.strptime(value, "%Y%m%d")
    except ValueError:
        raise argparse.ArgumentTypeError("Use a valid calendar date.") from None
    return value


def api_catalog() -> list[dict]:
    return json.loads(API_CATALOG.read_text(encoding="utf-8"))["apis"]


def request_rows(endpoint: str, date: str, key: str) -> list:
    request = urllib.request.Request(f"{endpoint}?{urllib.parse.urlencode({'basDd': date})}",
        headers={"AUTH_KEY": key, "Accept": "application/json", "User-Agent": "k-deal-skill-krx/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            raw = response.read(32 * 1024 * 1024 + 1)
    except urllib.error.HTTPError as exc:
        code = exc.code
        exc.close()
        if code == 401:
            raise KrxError("not_approved", "KRX refused the key for this service (401); apply for this API at openapi.krx.co.kr.") from None
        raise KrxError(f"http_{code}", f"KRX HTTP request failed ({code}); verify key and service access.") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise KrxError("transport_error", "KRX network request failed; no data was returned.") from None
    if len(raw) > 32 * 1024 * 1024:
        raise KrxError("response_too_large", "KRX response exceeded the download size limit.")
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeError):
        raise KrxError("invalid_response", "KRX returned an invalid JSON response.") from None
    if not isinstance(data, dict) or not isinstance(data.get("OutBlock_1"), list):
        raise KrxError("invalid_response", "KRX response has no valid OutBlock_1; this is not an empty dataset.")
    return data["OutBlock_1"]


def fetch(kind: str, market: str, date: str, codes: list[str], key: str) -> dict:
    try:
        route = ROUTES[kind][market]
    except KeyError:
        raise KrxError("invalid_input", "Unsupported operation or market.") from None
    endpoint = f"{BASE}/sto/{route}"
    rows = request_rows(endpoint, date, key)
    code_field = "ISU_CD" if kind == "trade" else "ISU_SRT_CD"
    if any(not isinstance(row, dict) or code_field not in row for row in rows):
        raise KrxError("invalid_response", "KRX records do not match the expected security-code schema.")
    requested = set(codes)
    matched = [row for row in rows if str(row[code_field]) in requested]
    observed = {str(row[code_field]) for row in matched}
    return {"status": "ok" if matched else "empty",
            "source": {"provider": "KRX Open API", "endpoint": endpoint, "basDd": date, "market": market,
                       "fetched_at": datetime.now(timezone.utc).isoformat(), "requested_codes": codes},
            "coverage": {"provider_row_count": len(rows), "matched_count": len(matched),
                         "unmatched_codes": sorted(requested - observed)},
            "data": matched}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Retrieve explicit-date KRX daily data over HTTPS.")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("env-status", help="Check key presence only; no network call.")
    for operation in ROUTES:
        p = commands.add_parser(operation)
        p.add_argument("--market", choices=tuple(ROUTES[operation]), required=True)
        p.add_argument("--date", action="append", type=date_arg, required=True)
        p.add_argument("--code", action="append", required=True, help="Exact KRX short security code; may be repeated.")
        p.add_argument("--out")
    apis = commands.add_parser("apis", help="List the catalogued KRX Open API services; no network call.")
    apis.add_argument("--query", default="")
    daily = commands.add_parser("daily", help="Run any catalogued KRX Open API for one date (see `apis`).")
    daily.add_argument("--api", required=True, help="Service id such as idx/kospi_dd_trd, etp/etf_bydd_trd, bon/kts_bydd_trd.")
    daily.add_argument("--date", type=date_arg, required=True)
    daily.add_argument("--filter", action="append", default=[], help="FIELD=VALUE exact match on returned rows; may be repeated.")
    daily.add_argument("--limit", type=int, default=200)
    daily.add_argument("--out")
    return parser


def write_json(data: dict, output: str | None = None) -> None:
    rendered = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    if output:
        path = Path(output)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "env-status":
            write_json(credentials.resolve("krx").status())
            return 0
        if args.command == "apis":
            terms = args.query.lower().split()
            rows = [a for a in api_catalog() if all(t in f"{a['id']} {a['category']} {a['name']}".lower() for t in terms)]
            write_json({"status": "ok" if rows else "empty", "data": rows,
                        "note": "Each service needs its own approval on openapi.krx.co.kr; unapproved services return not_approved."})
            return 0
        key = load_key()
        if args.command == "daily":
            spec = next((a for a in api_catalog() if a["id"] == args.api), None)
            if not spec:
                raise KrxError("invalid_input", "Unknown KRX service id; run `apis` to list them.")
            filters = []
            for item in args.filter:
                field, sep, value = item.partition("=")
                if not sep or not field:
                    raise KrxError("invalid_input", "Use --filter FIELD=VALUE.")
                filters.append((field, value))
            endpoint = f"{BASE}/{spec['id']}"
            rows = request_rows(endpoint, args.date, key)
            matched = [r for r in rows if isinstance(r, dict) and all(str(r.get(f)) == v for f, v in filters)]
            write_json({"status": "ok" if matched else "empty",
                        "source": {"provider": "KRX Open API", "endpoint": endpoint, "service": spec["name"], "basDd": args.date,
                                   "fetched_at": datetime.now(timezone.utc).isoformat()},
                        "coverage": {"provider_row_count": len(rows), "matched_count": len(matched),
                                     "returned_count": min(len(matched), args.limit), "truncated": len(matched) > args.limit},
                        "data": matched[:args.limit]}, args.out)
            return 0
        if any(not re.fullmatch(r"[0-9A-Z]{6}", code) for code in args.code):
            raise KrxError("invalid_input", "Use exact six-character uppercase KRX short security codes.")
        codes = list(dict.fromkeys(args.code))
        results = []
        for date in dict.fromkeys(args.date):
            try:
                results.append(fetch(args.command, args.market, date, codes, key))
            except KrxError as exc:
                results.append({"status": "error", "source": {"provider": "KRX Open API", "basDd": date, "market": args.market},
                                "error": {"code": exc.code, "message": str(exc)}})
        has_error = any(r["status"] == "error" for r in results)
        status = "partial_error" if has_error and any(r["status"] != "error" for r in results) else "error" if has_error else "ok" if any(r["status"] == "ok" for r in results) else "empty"
        write_json({"status": status, "results": results}, args.out)
        return 2 if has_error else 0
    except KrxError as exc:
        write_json({"status": "error", "error": {"code": exc.code, "message": str(exc)}})
        return 2
    except credentials.CredentialError as exc:
        write_json({"status": "error", "error": {"code": "credential_configuration", "message": str(exc)}})
        return 2
    except OSError:
        write_json({"status": "error", "error": {"code": "local_error", "message": "Output could not be written."}})
        return 2


if __name__ == "__main__":
    sys.exit(main())
