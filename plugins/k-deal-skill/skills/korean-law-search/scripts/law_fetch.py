#!/usr/bin/env python3
"""Direct client for the 법제처 국가법령정보 공동활용 Open API (www.law.go.kr/DRF).

Python standard library only. The OC comes from the LAW_OC environment variable and is
never printed; 법제처 also checks the caller's registered IP or domain. Decision domain to
DRF target mapping follows korean-law-mcp (MIT, https://github.com/chrisryugj/korean-law-mcp).
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

DRF_BASE = "https://www.law.go.kr/DRF/"
CATALOG_PATH = Path(__file__).resolve().parents[1] / "references" / "law-apis.json"
MAX_RESPONSE_BYTES = 6 * 1024 * 1024
DECISION_TARGETS = {
    "precedent": "prec", "interpretation": "expc", "tax_tribunal": "ttSpecialDecc", "customs": "kcsCgmExpc",
    "nts": "ntsCgmExpc", "moel": "moelCgmExpc", "constitutional": "detc", "admin_appeal": "decc", "ftc": "ftc",
    "pipc": "ppc", "nlrc": "nlrc", "iaciac": "iaciac", "eiac": "eiac", "acr": "acr", "appeal_review": "adapSpecialDecc",
    "acr_special": "acrSpecialDecc", "school": "school", "public_corp": "public", "public_inst": "pi",
    "treaty": "trty", "english_law": "elaw",
}
# lawService.do has no body for these targets; the source keeps them elsewhere.
NO_DIRECT_BODY = {"ntsCgmExpc"}
FRESHNESS = "공포일·시행일·선고일 등 원자료 날짜와 조회 시각은 다릅니다."


class LawError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def catalog() -> dict:
    return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))


def decision_target(domain: str) -> str:
    if domain in DECISION_TARGETS:
        return DECISION_TARGETS[domain]
    if any(api["target"] == domain and api["kind"] == "list" for api in catalog()["apis"]):
        return domain
    raise LawError("invalid_input", "Unknown decision domain; use a named domain or a DRF target code from `catalog`.")


def jo_code(article: str | None) -> str | None:
    """제750조 -> 075000, 제10조의2 -> 001002. Anything else (부칙 등) returns None and the full text is fetched."""
    match = re.fullmatch(r"제?\s*(\d{1,4})\s*조(?:\s*의\s*(\d{1,2}))?", (article or "").strip())
    if not match:
        return None
    return match.group(1).zfill(4) + (match.group(2) or "0").zfill(2)


def redact(text: str, oc: str) -> str:
    text = re.sub(r"([?&]OC=)[^&\"'\s<>]+", r"\1[REDACTED]", text, flags=re.I)
    return text.replace(oc, "[REDACTED]") if len(oc) >= 6 else text


def load_oc() -> str:
    oc = os.environ.get("LAW_OC", "").strip()
    if not oc:
        raise LawError("not_connected", "LAW_OC is not set. Register an OC at open.law.go.kr, or use scripts/mcp_http.py (public remote server) instead.")
    if not re.fullmatch(r"[A-Za-z0-9._@-]{1,64}", oc):
        raise LawError("invalid_credential", "LAW_OC contains unexpected characters.")
    return oc


def request(endpoint: str, params: dict, oc: str) -> dict:
    query = urllib.parse.urlencode({"OC": oc, "type": "JSON", **{k: str(v) for k, v in params.items() if v not in (None, "")}})
    req = urllib.request.Request(f"{DRF_BASE}{endpoint}?{query}", headers={"Accept": "application/json", "User-Agent": "k-deal-skill-law/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=25) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as exc:
        code = exc.code
        exc.close()
        raise LawError("law_http_error", f"법제처 API가 HTTP {code}로 응답했습니다. 결과 없음으로 해석하지 않습니다.") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise LawError("transport_error", "법제처 API 연결에 실패했습니다. 결과 없음으로 해석하지 않습니다.") from None
    if len(raw) > MAX_RESPONSE_BYTES:
        raise LawError("response_too_large", "응답이 너무 큽니다. 조문(--article)을 지정하거나 범위를 좁혀 다시 조회하세요.")
    try:
        data = json.loads(redact(raw.decode("utf-8", errors="replace"), oc))
    except ValueError:
        raise LawError("law_api_non_json", "법제처 API가 JSON이 아닌 응답을 보냈습니다. OC 승인, 등록된 IP·도메인, 점검 여부를 확인하세요.") from None
    if isinstance(data, dict) and isinstance(data.get("result"), str) and isinstance(data.get("msg"), str) and len(data) <= 3:
        raise LawError("law_api_rejected", f"법제처 API가 요청을 거절했습니다: {data['result']} {data['msg']}"[:240])
    return {"status": "ok", "data": data, "metadata": {"provider": "법제처 국가법령정보 공동활용 Open API",
            "source_url": f"{DRF_BASE}{endpoint}", "request": {k: str(v) for k, v in params.items() if v not in (None, "")},
            "fetched_at": datetime.now(timezone.utc).isoformat(), "freshness": FRESHNESS}}


def rank_laws(rows: list, query: str) -> list:
    """Exact name or short name first, then its 시행령·시행규칙, then names starting with or containing the query."""
    q = re.sub(r"\s+", "", query)
    def score(item: dict) -> int:
        name = re.sub(r"\s+", "", str(item.get("법령명한글", "")))
        short = re.sub(r"\s+", "", str(item.get("법령약칭명", "")))
        if q in (name, short):
            return 0
        if name in (f"{q}시행령", f"{q}시행규칙"):
            return 1
        return 2 if name.startswith(q) else 3 if q in name else 4
    return sorted(rows, key=score)


def execute(args: argparse.Namespace) -> dict:
    if args.command == "env-status":
        return {"credentials_present": {"LAW_OC": bool(os.environ.get("LAW_OC", "").strip())},
                "note": "법제처는 OC와 함께 신청 시 등록한 IP·도메인을 확인합니다. 이 상태값은 실제 조회 성공을 뜻하지 않습니다."}
    if args.command == "catalog":
        data = catalog()
        terms = args.query.lower().split()
        hits = [api for api in data["apis"] if (not args.kind or api["kind"] == args.kind)
                and all(t in f"{api['name']} {api['target']}".lower() for t in terms)]
        return {"status": "ok" if hits else "empty", "data": [{"api_id": api["id"], "name": api["name"], "kind": api["kind"],
                "target": api["target"], "params": [f"{p['name']}{'*' if p['required'] else ''}: {p['description']}" for p in api["params"]]}
                for api in hits[:args.limit]], "metadata": {"catalog": data["source"], "compiled_from": data["compiled_from"],
                "total_apis": data["count"], "matched": len(hits), "note": "* 표시는 필수 파라미터. OC·target·type은 스크립트가 채웁니다."}}
    oc = load_oc()
    if args.command == "search-law":
        result = request("lawSearch.do", {"target": "law", "query": args.query, "display": 100}, oc)
        body = result["data"].get("LawSearch") if isinstance(result["data"], dict) else None
        if isinstance(body, dict):
            rows = body.get("law") or []
            rows = rows if isinstance(rows, list) else [rows]
            body["law"] = rank_laws(rows, args.query)[:args.display]
            result["metadata"]["ranking"] = f"법령명 일치도 순으로 상위 {len(body['law'])}건(검토 {len(rows)}건, 전체 {body.get('totalCnt', len(rows))}건)."
        return result
    if args.command == "law-text":
        params = {"target": "eflaw", "efYd": args.date} if args.date else {"target": "law"}
        params["MST" if args.mst else "ID"] = args.mst or args.law_id
        jo = jo_code(args.article)
        if jo:
            params["JO"] = jo
        result = request("lawService.do", params, oc)
        if args.article and not jo:
            result["metadata"]["note"] = "조문 번호 형식이 아니어서 전체 본문을 조회했습니다."
        return result
    if args.command == "decisions":
        return request("lawSearch.do", {"target": decision_target(args.domain), "query": args.query,
                                        "display": args.display, "page": args.page}, oc)
    if args.command == "decision-text":
        target = decision_target(args.domain)
        if target in NO_DIRECT_BODY:
            raise LawError("not_available_direct", "국세청 법령해석 본문은 법제처 Open API로 제공되지 않습니다. 국세법령정보시스템(taxlaw.nts.go.kr)에서 확인하세요.")
        return request("lawService.do", {"target": target, "ID": args.id}, oc)
    spec = next((api for api in catalog()["apis"] if api["id"] == args.api_id), None)
    if not spec:
        raise LawError("invalid_input", "Unknown api_id; run `catalog` to find one.")
    allowed = {p["name"] for p in spec["params"]}
    params = {}
    for item in args.param:
        name, sep, value = item.partition("=")
        if not sep or name not in allowed or len(value) > 300:
            raise LawError("invalid_input", f"{spec['name']}에 없는 파라미터이거나 형식이 맞지 않습니다: {name}")
        params[name] = value
    missing = [p["name"] for p in spec["params"] if p["required"] and p["name"] not in params]
    if missing:
        raise LawError("invalid_input", f"필수 파라미터가 없습니다: {', '.join(missing)}")
    result = request(spec["endpoint"], {"target": spec["target"], **params}, oc)
    result["metadata"].update(api_id=spec["id"], api_name=spec["name"])
    return result


def date_arg(value: str) -> str:
    try:
        if not re.fullmatch(r"\d{8}", value):
            raise ValueError
        datetime.strptime(value, "%Y%m%d")
    except ValueError:
        raise argparse.ArgumentTypeError("Use YYYYMMDD.") from None
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Query the 법제처 Open API directly with LAW_OC.")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("env-status", help="Report LAW_OC presence only; no network call.")
    search = commands.add_parser("search-law", help="Find statutes by name, ranked by name match.")
    search.add_argument("--query", required=True)
    search.add_argument("--display", type=int, choices=range(1, 101), default=10, metavar="1..100")
    text = commands.add_parser("law-text", help="Current or dated statute text, optionally one article.")
    ident = text.add_mutually_exclusive_group(required=True)
    ident.add_argument("--law-id")
    ident.add_argument("--mst")
    text.add_argument("--article", help="예: 제750조, 제10조의2")
    text.add_argument("--date", type=date_arg, help="시행일 기준 YYYYMMDD")
    decisions = commands.add_parser("decisions", help="Search precedents, interpretations and committee decisions.")
    decisions.add_argument("--domain", required=True, help=f"{', '.join(DECISION_TARGETS)} or a DRF target code")
    decisions.add_argument("--query", required=True)
    decisions.add_argument("--display", type=int, choices=range(1, 101), default=20, metavar="1..100")
    decisions.add_argument("--page", type=int, default=1)
    body = commands.add_parser("decision-text", help="Full text of one decision by its ID.")
    body.add_argument("--domain", required=True)
    body.add_argument("--id", required=True)
    cat = commands.add_parser("catalog", help="Find any of the 159 catalogued 법제처 APIs; no network call.")
    cat.add_argument("--query", default="")
    cat.add_argument("--kind", choices=("list", "body"))
    cat.add_argument("--limit", type=int, default=20)
    api = commands.add_parser("api", help="Run one catalogued API with its documented parameters only.")
    api.add_argument("--api-id", type=int, required=True)
    api.add_argument("--param", action="append", default=[], help="NAME=VALUE; may be repeated")
    for sub in (search, text, decisions, body, cat, api):
        sub.add_argument("--out")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = execute(args)
        rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
        if getattr(args, "out", None):
            Path(args.out).parent.mkdir(parents=True, exist_ok=True)
            Path(args.out).write_text(rendered, encoding="utf-8")
        else:
            print(rendered, end="")
        return 0
    except LawError as exc:
        print(json.dumps({"status": "error", "error": {"code": exc.code, "message": redact(str(exc), os.environ.get("LAW_OC", ""))}}, ensure_ascii=False))
        return 2
    except OSError:
        print(json.dumps({"status": "error", "error": {"code": "local_error", "message": "Output could not be written."}}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
