#!/usr/bin/env python3
"""Bounded data.go.kr API queries with the user's own service key."""

from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
from typing import Any, Mapping
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

_credential_spec = importlib.util.spec_from_file_location("kds_public_data_credentials", Path(__file__).with_name("source_credentials.py"))
credentials = importlib.util.module_from_spec(_credential_spec)
_credential_spec.loader.exec_module(credentials)


ENDPOINTS = {
    "fsc-financials": "https://apis.data.go.kr/1160100/service/GetFinaStatInfoService_V2/getSummFinaStat_V2",
    "fsc-outline": "https://apis.data.go.kr/1160100/service/GetCorpBasicInfoService_V2/getCorpOutline_V2",
    "fsc-affiliates": "https://apis.data.go.kr/1160100/service/GetCorpBasicInfoService_V2/getAffiliate_V2",
    "customs": "https://apis.data.go.kr/1220000/Itemtrade/getItemtradeList",
    "customs-country": "https://apis.data.go.kr/1220000/nitemtrade/getNitemtradeList",
}
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
CATALOG_PATH = Path(__file__).resolve().parents[1] / "references" / "datago-apis.json"
BIZ_STATUS_URL = "https://api.odcloud.kr/api/nts-businessman/v1/status"
PAGING_DEFAULTS = {"pageNo": 1, "page": 1, "numOfRows": 10, "perPage": 10}
FRESHNESS_NOTE = "Collection time is not the source reference date; latest upstream release has not been verified."
AGGREGATION_NOTE = (
    "총계/합계와 상세 HS·월별 행을 중복 합산하지 마세요. "
    "동일 기간·국가·HS 범위에서 하나의 집계 기준을 선택하고, 서로 포함되는 HS prefix도 중복 합산하지 마세요."
)


class PublicDataError(Exception):
    """An error whose message is safe to display without credentials or URLs."""


def encoded_key(environ: Mapping[str, str] | None = None) -> str:
    """Encode exactly once; an encoded key must not be passed through urlencode again."""
    try:
        resolution = credentials.resolve("datago", environ=environ)
    except credentials.CredentialError as exc:
        raise PublicDataError(str(exc)) from None
    env = resolution.values
    encoded = env.get("DATA_GO_KR_KEY_ENC", "").strip()
    decoded = env.get("DATA_GO_KR_KEY", "").strip()
    if encoded:
        if re.search(r"%(?![0-9a-fA-F]{2})", encoded):
            raise PublicDataError("DATA_GO_KR_KEY_ENC contains invalid percent encoding.")
        value = urllib.parse.unquote(encoded)
    elif decoded:
        value = decoded
    else:
        raise PublicDataError(credentials.missing_message(resolution, "DATA_GO_KR_KEY_ENC / DATA_GO_KR_KEY"))
    return urllib.parse.quote(value, safe="")


def build_url(endpoint: str, params: Mapping[str, Any], key: str) -> str:
    """Build an internal request URL; callers must never print it."""
    if endpoint not in ENDPOINTS.values():
        raise PublicDataError("Unsupported public-data endpoint.")
    query = urllib.parse.urlencode({"resultType": "json", **{k: v for k, v in params.items() if v is not None}})
    return f"{endpoint}?serviceKey={key}&{query}"


def parse_response(raw: str) -> dict[str, Any]:
    """Preserve normal raw rows; never convert upstream failures to an empty dataset."""
    try:
        if raw.lstrip().startswith("<"):
            root = ET.fromstring(raw)
            for element in root.iter():
                element.tag = element.tag.rsplit("}", 1)[-1]
            code = root.findtext(".//resultCode") or root.findtext(".//returnReasonCode")
            total = root.findtext(".//totalCount")
            items = [{child.tag: child.text for child in item} for item in root.iter("item")]
            has_payload = root.find(".//items") is not None or total is not None or bool(items)
        else:
            envelope = json.loads(raw)
            response = envelope.get("response") if isinstance(envelope, dict) else None
            if not isinstance(response, dict) or not isinstance(response.get("header"), dict):
                raise ValueError("missing envelope")
            code = response["header"].get("resultCode")
            body = response.get("body")
            if body is not None and not isinstance(body, dict):
                raise ValueError("invalid body")
            body = body or {}
            has_payload = "items" in body or "totalCount" in body
            items = body.get("items")
            if isinstance(items, dict) and "item" in items:
                items = items["item"]
            if items is None or items == "" or items == {}:
                items = []
            if isinstance(items, dict):
                items = [items]
            total = body.get("totalCount")
        if code is None:
            raise ValueError("missing result code")
        code = str(code).strip()
        if code not in {"0", "00", "000", "3", "03"}:
            # Provider messages and unexpected result codes can echo request credentials.
            safe_code = code if re.fullmatch(r"[0-9]{1,3}", code) else "unrecognized"
            raise PublicDataError(f"Public-data API error (code {safe_code}); check API approval, quota, and service status.")
        if code in {"0", "00", "000"} and not has_payload:
            raise ValueError("missing successful payload")
        if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
            raise ValueError("invalid items")
        if isinstance(total, bool):
            raise ValueError("invalid count")
        if total is None or total == "":
            total = len(items)
        elif not re.fullmatch(r"[0-9]+", str(total)):
            raise ValueError("invalid count")
        total = int(total)
        if total < len(items) or (code in {"3", "03"} and (items or total)):
            raise ValueError("inconsistent count")
    except (ValueError, TypeError, AttributeError, ET.ParseError):
        raise PublicDataError("Unrecognized public-data response; it was not treated as a zero-row result.") from None
    partial = total > len(items)
    return {
        "totalCount": total,
        "items": items,
        "_meta": {
            "response_checked": True,
            "result_code": code,
            "data_status": "partial" if partial else ("ok" if items else "no_data"),
            "returned_count": len(items),
            "partial_result": partial,
        },
    }


def fetch_api(
    endpoint: str,
    params: Mapping[str, Any],
    *,
    environ: Mapping[str, str] | None = None,
    opener: Any = None,
    timeout: float = 25,
) -> dict[str, Any]:
    key = encoded_key(environ)
    request = urllib.request.Request(
        build_url(endpoint, params, key),
        headers={"Accept": "application/json, application/xml", "User-Agent": "k-deal-skill-public-data/0.1"},
    )
    raw = _read(request, opener, timeout)
    out = parse_response(raw)
    out["_meta"].update({
        "source_url": endpoint,
        "request": {k: v for k, v in params.items() if v is not None},
        "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "cache_hit": False,
        "auto_pagination": False,
        "upstream_freshness": "not_verified",
        "freshness_note": FRESHNESS_NOTE,
    })
    if endpoint in {ENDPOINTS["customs"], ENDPOINTS["customs-country"]}:
        out["_meta"]["aggregation_note"] = AGGREGATION_NOTE
    return out


def _read(request: urllib.request.Request, opener: Any = None, timeout: float = 25) -> str:
    try:
        with (opener or urllib.request.urlopen)(request, timeout=timeout) as response:
            payload = response.read(MAX_RESPONSE_BYTES + 1)
        if len(payload) > MAX_RESPONSE_BYTES:
            raise PublicDataError("Public-data response exceeds the bounded response size; narrow the query.")
        raw = payload.decode("utf-8-sig")
    except urllib.error.HTTPError as exc:
        exc.close()
        raise PublicDataError(f"Public-data HTTP error {exc.code}; check API approval and service status.") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise PublicDataError("Unable to reach the public-data API.") from None
    except UnicodeDecodeError:
        raise PublicDataError("Public-data API returned an unreadable response.") from None
    if "SERVICE_KEY_IS_NOT_REGISTERED" in raw:
        raise PublicDataError("This service key is not approved for the requested data.go.kr service; apply on data.go.kr.")
    return raw


def load_catalog() -> dict[str, Any]:
    return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))


def catalog(query: str = "") -> dict[str, Any]:
    terms = query.lower().split()
    services = load_catalog()["services"]
    hits = [s for s in services if all(t in " ".join([s["id"], s["name"], s["provider"], s.get("pe_use", ""),
            *(f"{o['id']} {o['description']}" for o in s["operations"])]).lower() for t in terms)]
    return {"status": "ok" if hits else "empty",
            "data": [{"service": s["id"], "name": s["name"], "provider": s["provider"], "use": s.get("pe_use"),
                      "apply_url": s.get("data_url"), "operations": [{"operation": o["id"], "description": o["description"],
                      "params": [f"{p['name']}{'*' if p['required'] else ''}: {p['description']}" for p in o["params"]]}
                      for o in s["operations"]]} for s in hits],
            "note": "* marks required parameters. Each service needs its own approval for your key on data.go.kr; serviceKey and response format are filled in by the helper."}


def call(service_id: str, operation_id: str, params: Mapping[str, Any], *, environ: Mapping[str, str] | None = None,
         opener: Any = None, timeout: float = 30) -> dict[str, Any]:
    service = next((s for s in load_catalog()["services"] if s["id"] == service_id), None)
    if not service:
        raise PublicDataError("Unknown service; run `catalog` to list them.")
    op = next((o for o in service["operations"] if o["id"] == operation_id), None)
    if not op:
        raise PublicDataError(f"{service['name']} has no such operation.")
    allowed = {p["name"] for p in op["params"]}
    params = dict(params)
    for p in op["params"]:
        if p["required"] and p["name"] not in params and p["name"] in PAGING_DEFAULTS:
            params[p["name"]] = PAGING_DEFAULTS[p["name"]]
    unknown = sorted(set(params) - allowed)
    if unknown:
        raise PublicDataError(f"Not a documented parameter of {op['id']}: {', '.join(unknown)}")
    if any(not isinstance(v, (str, int, float, bool)) or len(str(v)) > 300 for v in params.values()):
        raise PublicDataError("Parameter values must be short strings or numbers.")
    missing = [p["name"] for p in op["params"] if p["required"] and p["name"] not in params]
    if missing:
        raise PublicDataError(f"Missing required parameters: {', '.join(missing)}")
    key = encoded_key(environ)
    query = [f"{service.get('key_param') or 'serviceKey'}={key}"]  # already encoded once; do not re-encode
    if service.get("format_param") and service["format_param"].get("name"):
        query.append(urllib.parse.urlencode({service["format_param"]["name"]: service["format_param"]["value"]}))
    method = (op.get("method") or service.get("method") or "GET").upper()
    if method == "GET":
        query.append(urllib.parse.urlencode({k: str(v) for k, v in params.items()}))
    endpoint = f"{service['base_url']}{op.get('path') or '/' + op['id']}"
    data = None if method == "GET" else json.dumps(params).encode()
    headers = {"Accept": "application/json, application/xml", "User-Agent": "k-deal-skill-public-data/0.1"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    raw = _read(urllib.request.Request(f"{endpoint}?{'&'.join(q for q in query if q)}", data=data, headers=headers, method=method), opener, timeout)
    meta = {"provider": f"{service['provider']} (data.go.kr)", "service": service["id"], "service_name": service["name"],
            "operation": op["id"], "source_url": endpoint, "request": params,
            "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(), "freshness_note": FRESHNESS_NOTE}
    try:
        out = parse_response(raw)
    except PublicDataError as exc:
        if not str(exc).startswith("Unrecognized"):
            raise
        try:  # odcloud and some other services do not use the response/header/body envelope
            return {"data": json.loads(raw), "_meta": {**meta, "envelope": "non_standard"}}
        except ValueError:
            raise exc from None
    out["_meta"].update(meta)
    return out


def biz_status(numbers: list[str], *, environ: Mapping[str, str] | None = None, opener: Any = None) -> dict[str, Any]:
    clean = list(dict.fromkeys(n.replace("-", "") for n in numbers))
    if not clean or len(clean) > 100 or not all(re.fullmatch(r"[0-9]{10}", n) for n in clean):
        raise PublicDataError("Use 1 to 100 ten-digit business registration numbers.")
    key = encoded_key(environ)
    request = urllib.request.Request(f"{BIZ_STATUS_URL}?serviceKey={key}&returnType=JSON", data=json.dumps({"b_no": clean}).encode(),
        headers={"Content-Type": "application/json", "Accept": "application/json", "User-Agent": "k-deal-skill-public-data/0.1"}, method="POST")
    raw = _read(request, opener)
    try:
        payload = json.loads(raw)
    except ValueError:
        raise PublicDataError("Unrecognized NTS response.") from None
    if payload.get("status_code") != "OK":
        raise PublicDataError("NTS business-status service did not return OK; check approval of this service for your key.")
    return {"data": payload.get("data", []), "_meta": {"provider": "국세청 사업자등록정보 상태조회 (data.go.kr)", "source_url": BIZ_STATUS_URL,
            "request_count": len(clean), "match_count": payload.get("match_cnt"), "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "note": "b_stt_cd 01 active, 02 suspended, 03 closed. Unregistered numbers carry a message in tax_type."}}


def status(environ: Mapping[str, str] | None = None) -> dict[str, Any]:
    env = os.environ if environ is None else environ
    try:
        credential_status = credentials.resolve("datago", environ=env).status()
    except credentials.CredentialError as exc:
        raise PublicDataError(str(exc)) from None
    return credential_status



def _positive(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return number


def _page_size(value: str) -> int:
    number = _positive(value)
    if number > 100:
        raise argparse.ArgumentTypeError("must be between 1 and 100")
    return number


def _crno(value: str) -> str:
    if not re.fullmatch(r"[0-9]{13}", value):
        raise argparse.ArgumentTypeError("must be a 13-digit legal entity registration number")
    return value


def _date(value: str) -> str:
    try:
        if not re.fullmatch(r"[0-9]{8}", value):
            raise ValueError
        dt.datetime.strptime(value, "%Y%m%d")
    except ValueError:
        raise argparse.ArgumentTypeError("must be a valid YYYYMMDD date") from None
    return value


def _month(value: str) -> str:
    try:
        if not re.fullmatch(r"[0-9]{6}", value):
            raise ValueError
        dt.datetime.strptime(value, "%Y%m")
    except ValueError:
        raise argparse.ArgumentTypeError("must be a valid YYYYMM month") from None
    return value


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(description=__doc__)
    commands = cli.add_subparsers(dest="command", required=True)
    commands.add_parser("status", help="Show key presence without network access")
    cat = commands.add_parser("catalog", help="List catalogued data.go.kr services and operations; no network call")
    cat.add_argument("--query", default="")
    run = commands.add_parser("call", help="Run one catalogued service operation")
    run.add_argument("--service", required=True)
    run.add_argument("--operation", required=True)
    run.add_argument("--param", action="append", default=[], help="NAME=VALUE; may be repeated")
    biz = commands.add_parser("biz-status", help="NTS business registration status (active/suspended/closed)")
    biz.add_argument("--bizno", action="append", required=True, help="10-digit business registration number; may be repeated")
    for name, default_rows in (("fsc-financials", 10), ("fsc-outline", 20), ("fsc-affiliates", 100)):
        sub = commands.add_parser(name)
        sub.add_argument("--page-no", type=_positive, default=1)
        sub.add_argument("--num-rows", type=_page_size, default=default_rows)
        if name == "fsc-outline":
            identity = sub.add_mutually_exclusive_group(required=True)
            identity.add_argument("--crno", type=_crno)
            identity.add_argument("--corp-name")
        else:
            sub.add_argument("--crno", type=_crno, required=True)
        if name == "fsc-financials":
            sub.add_argument("--year", type=int, choices=range(1900, 10000), metavar="YYYY", required=True)
        if name == "fsc-affiliates":
            sub.add_argument("--base-date", type=_date)
    customs = commands.add_parser("customs")
    customs.add_argument("--hs", required=True)
    customs.add_argument("--start-ym", type=_month, required=True)
    customs.add_argument("--end-ym", type=_month, required=True)
    customs.add_argument("--country")
    return cli


def dispatch(args: argparse.Namespace) -> dict[str, Any]:
    if args.command == "status":
        return status()
    if args.command == "catalog":
        return catalog(args.query)
    if args.command == "biz-status":
        return biz_status(args.bizno)
    if args.command == "call":
        params = {}
        for item in args.param:
            name, sep, value = item.partition("=")
            if not sep or not name:
                raise PublicDataError("Use --param NAME=VALUE.")
            params[name] = value
        return call(args.service, args.operation, params)
    if args.command == "customs":
        if not re.fullmatch(r"[0-9]{2,10}", args.hs):
            raise PublicDataError("HS code must contain 2 to 10 digits.")
        start, end = (int(args.start_ym[:4]) * 12 + int(args.start_ym[4:]), int(args.end_ym[:4]) * 12 + int(args.end_ym[4:]))
        if not 0 <= end - start < 12:
            raise PublicDataError("Customs queries require an ordered range of at most 12 calendar months.")
        country = args.country.upper() if args.country else None
        if country and not re.fullmatch(r"[A-Z]{2}", country):
            raise PublicDataError("Country must be a two-letter country code.")
        params = {"strtYymm": args.start_ym, "endYymm": args.end_ym, "hsSgn": args.hs, "cntyCd": country}
        return fetch_api(ENDPOINTS["customs-country" if country else "customs"], params)
    params = {"pageNo": args.page_no, "numOfRows": args.num_rows, "crno": args.crno}
    if args.command == "fsc-financials":
        params["bizYear"] = str(args.year)
    elif args.command == "fsc-outline":
        if args.corp_name is not None and not args.corp_name.strip():
            raise PublicDataError("A nonempty corporation name is required.")
        params["corpNm"] = args.corp_name
    else:
        params["basDt"] = args.base_date
    return fetch_api(ENDPOINTS[args.command], params)


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        result = dispatch(args)
    except PublicDataError as exc:
        print(json.dumps({"error": {"type": "public_data_error", "message": str(exc)}}, ensure_ascii=False), file=sys.stderr)
        return 1
    except Exception:
        # A traceback from an HTTP library may contain a key-bearing request URL.
        print(json.dumps({"error": {"type": "public_data_error", "message": "Public-data operation failed; no result was inferred."}}), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
