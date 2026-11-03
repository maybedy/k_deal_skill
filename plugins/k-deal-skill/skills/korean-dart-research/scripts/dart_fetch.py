#!/usr/bin/env python3
"""Portable OpenDART helper; adapted from an earlier dart_fetch.py.

Python standard library only. Credentials come from environment variables or an
explicit local MCP connection; values and request URLs are never persisted.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
from xml.etree import ElementTree as ET
import zipfile

_credential_spec = importlib.util.spec_from_file_location("kds_dart_credentials", Path(__file__).with_name("source_credentials.py"))
credentials = importlib.util.module_from_spec(_credential_spec)
_credential_spec.loader.exec_module(credentials)

BASE = "https://opendart.fss.or.kr/api"
REPORT_CODES = ("11011", "11012", "11013", "11014")
MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
REPORT_CATALOG = Path(__file__).resolve().parents[1] / "references" / "dart-reports.json"


def report_catalog() -> dict:
    data = json.loads(REPORT_CATALOG.read_text(encoding="utf-8"))
    return {item["id"]: item for item in data["reports"]}, data["groups"]


class DartError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class DartNoData(DartError):
    def __init__(self):
        super().__init__("dart_013", "OpenDART returned no records for this request.")


def redact(message: str, *secrets: str) -> str:
    for secret in secrets:
        if secret:
            message = message.replace(secret, "[redacted]")
            message = message.replace(urllib.parse.quote(secret, safe=""), "[redacted]")
    return re.sub(r"https?://[^\s<>\"']+", "[redacted-url]", message)[:500]


def load_key() -> str:
    resolution = credentials.resolve("dart")
    for name in ("DART_API_KEY", "OPENDART_API_KEY"):
        value = resolution.values.get(name, "")
        if value:
            return value
    raise DartError("not_connected", credentials.missing_message(resolution, "DART_API_KEY / OPENDART_API_KEY"))


def source(endpoint: str, params: dict) -> dict:
    return {"provider": "OpenDART", "endpoint": f"{BASE}/{endpoint}",
            "request": params, "fetched_at": datetime.now(timezone.utc).isoformat()}


def request_bytes(endpoint: str, key: str, params: dict, timeout: int = 60) -> bytes:
    clean_params = {k: v for k, v in params.items() if v is not None and v != ""}
    url = f"{BASE}/{endpoint}?{urllib.parse.urlencode({**clean_params, 'crtfc_key': key})}"
    request = urllib.request.Request(url, headers={"User-Agent": "k-deal-skill-dart/1.0", "Accept": "*/*"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(MAX_ARCHIVE_BYTES + 1)
    except urllib.error.HTTPError as exc:
        code = exc.code
        exc.close()
        raise DartError(f"http_{code}", f"OpenDART HTTP request failed ({code}).") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise DartError("transport_error", "OpenDART network request failed; no data was returned.") from None
    if len(raw) > MAX_ARCHIVE_BYTES:
        raise DartError("response_too_large", "OpenDART response exceeded the download size limit.")
    return raw


def get_json(endpoint: str, key: str, params: dict) -> dict:
    raw = request_bytes(endpoint, key, params)
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeError):
        raise DartError("invalid_response", "OpenDART returned an invalid JSON response.") from None
    if not isinstance(data, dict) or not isinstance(data.get("status"), str):
        raise DartError("invalid_response", "OpenDART response has no valid status field.")
    code = data["status"]
    if code not in ("000", "013"):
        raise DartError(f"dart_{code}", redact(str(data.get("message", "OpenDART rejected the request.")), key))
    if "message" in data:
        data["message"] = redact(str(data["message"]), key)
    return {"status": "empty" if code == "013" else "ok", "source": source(endpoint, params), "data": data}


def archive_members(raw: bytes) -> tuple[zipfile.ZipFile, list[zipfile.ZipInfo]]:
    """Validate every member before reading or writing any archive content."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        try:
            root = ET.fromstring(raw)
            code = root.findtext("status")
        except ET.ParseError:
            code = None
        if code == "013":
            raise DartNoData() from None
        raise DartError(f"dart_{code}" if code else "invalid_archive", "OpenDART did not return a valid ZIP archive.") from None
    members = archive.infolist()
    if len(members) > 2000 or sum(m.file_size for m in members) > MAX_ARCHIVE_BYTES:
        archive.close()
        raise DartError("unsafe_archive", "Archive exceeds extraction size or member limits.")
    seen: set[str] = set()
    for member in members:
        name = member.filename.replace("\\", "/")
        path = PurePosixPath(name)
        mode = member.external_attr >> 16
        if (path.is_absolute() or ".." in path.parts or ":" in name or "\x00" in name
                or stat.S_ISLNK(mode) or str(path) in seen or not path.parts):
            archive.close()
            raise DartError("unsafe_archive", "Archive contains an unsafe or duplicate member path.")
        seen.add(str(path))
    return archive, members


def extract_archive(raw: bytes, destination: Path) -> list[str]:
    archive, members = archive_members(raw)
    try:
        root = destination.resolve()
        targets = []
        for member in members:
            target = root.joinpath(*PurePosixPath(member.filename.replace("\\", "/")).parts)
            if not target.resolve().is_relative_to(root):
                raise DartError("unsafe_archive", "Archive member resolves outside the destination.")
            if not member.is_dir() and target.exists():
                raise DartError("output_exists", "An extraction output already exists; choose a new destination.")
            targets.append((member, target))
        root.mkdir(parents=True, exist_ok=True)
        extracted = []
        for member, target in targets:
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(member) as incoming, target.open("xb") as outgoing:
                while chunk := incoming.read(1024 * 1024):
                    outgoing.write(chunk)
            extracted.append(str(target.relative_to(root)))
        return extracted
    except (OSError, RuntimeError, zipfile.BadZipFile):
        raise DartError("archive_write_error", "Archive could not be completely extracted; inspect the destination before retrying.") from None
    finally:
        archive.close()


def corp_code(name: str, key: str, limit: int = 20) -> dict:
    raw = request_bytes("corpCode.xml", key, {})
    try:
        archive, members = archive_members(raw)
    except DartNoData:
        return {"status": "empty", "source": source("corpCode.xml", {"search": name}), "matched_count": 0, "truncated": False, "data": []}
    try:
        candidates = [m for m in members if PurePosixPath(m.filename).name.upper() == "CORPCODE.XML"]
        if len(candidates) != 1:
            raise DartError("invalid_archive", "Company-code archive does not contain exactly one CORPCODE.xml.")
        root = ET.fromstring(archive.read(candidates[0]))
    except (ET.ParseError, zipfile.BadZipFile):
        raise DartError("invalid_response", "Company-code XML could not be parsed.") from None
    finally:
        archive.close()
    needle = name.strip().casefold()
    rows = []
    for item in root.findall(".//list"):
        row = {child.tag: (child.text or "").strip() for child in item}
        if any(needle in row.get(k, "").casefold() for k in ("corp_name", "corp_eng_name")) or needle in (row.get("corp_code"), row.get("stock_code")):
            rows.append(row)
    # Exact name or code first, listed companies before unlisted ones with the same name.
    rows.sort(key=lambda r: (needle not in (r.get("corp_name", "").casefold(), r.get("corp_code"), r.get("stock_code")),
                             not r.get("stock_code")))
    return {"status": "ok" if rows else "empty", "source": source("corpCode.xml", {"search": name}),
            "matched_count": len(rows), "truncated": len(rows) > limit, "data": rows[:limit]}


def disclosures(key: str, params: dict, all_pages: bool = False, max_pages: int = 20) -> dict:
    start_page = int(params.get("page_no", 1))
    pages, rows = [], []
    total_pages, total_count = start_page, 0
    for offset in range(max_pages if all_pages else 1):
        page_no = start_page + offset
        result = get_json("list.json", key, {**params, "page_no": str(page_no)})
        data = result["data"]
        pages.append({"page_no": page_no, "status": data["status"], "fetched_at": result["source"]["fetched_at"]})
        if result["status"] == "empty":
            if rows:
                raise DartError("pagination_changed", "A later disclosure page was empty after earlier records; retry the requested scope.")
            total_pages, total_count = 0, 0
            break
        try:
            total_pages, total_count = int(data["total_page"]), int(data["total_count"])
        except (KeyError, ValueError, TypeError):
            raise DartError("invalid_response", "Disclosure response has invalid pagination metadata.") from None
        if not isinstance(data.get("list"), list):
            raise DartError("invalid_response", "Disclosure response has no valid record list.")
        rows.extend(data["list"])
        if page_no >= total_pages:
            break
    complete = (start_page == 1 and (total_pages == 0 or pages[-1]["page_no"] >= total_pages)
                and len(rows) == total_count)
    return {"status": "ok" if rows else "empty", "source": source("list.json", params), "data": rows,
            "pagination": {"complete": complete, "requested_all_pages": all_pages, "total_pages": total_pages,
                           "total_count": total_count, "returned_count": len(rows), "pages": pages}}


def date_arg(value: str) -> str:
    if not re.fullmatch(r"\d{8}", value):
        raise argparse.ArgumentTypeError("Use YYYYMMDD.")
    try:
        datetime.strptime(value, "%Y%m%d")
    except ValueError:
        raise argparse.ArgumentTypeError("Use a valid calendar date.") from None
    return value


def digits(length: int):
    def check(value: str) -> str:
        if not re.fullmatch(rf"\d{{{length}}}", value):
            raise argparse.ArgumentTypeError(f"Expected {length} digits.")
        return value
    return check


def positive(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("Use a positive integer.")
    return number


def write_json(data: dict, output: str | None = None) -> None:
    rendered = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    if output:
        path = Path(output)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read official OpenDART sources using environment or explicitly connected local MCP credentials.")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("env-status", help="Report credential presence only; do not contact DART.")
    corp = commands.add_parser("corp-code", help="Search a fresh official company-code snapshot.")
    corp.add_argument("--name", required=True)
    corp.add_argument("--limit", type=positive, default=20)
    corp.add_argument("--out")
    listing = commands.add_parser("disclosures", help="Fetch a bounded filing inventory with pagination metadata.")
    listing.add_argument("--corp-code", type=digits(8), required=True)
    listing.add_argument("--begin", type=date_arg, required=True)
    listing.add_argument("--end", type=date_arg, required=True)
    listing.add_argument("--type", default="", choices=("", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J"))
    listing.add_argument("--last-report-only", action="store_true")
    listing.add_argument("--page", type=positive, default=1)
    listing.add_argument("--page-count", type=int, choices=range(1, 101), default=100, metavar="1..100")
    listing.add_argument("--all-pages", action="store_true")
    listing.add_argument("--max-pages", type=positive, default=20)
    listing.add_argument("--out")
    financial = commands.add_parser("financials", help="All financial accounts for an explicit fiscal year, report and basis.")
    financial.add_argument("--corp-code", type=digits(8), required=True)
    financial.add_argument("--year", type=digits(4), required=True)
    financial.add_argument("--report", choices=REPORT_CODES, required=True)
    financial.add_argument("--fs-div", choices=("CFS", "OFS"), required=True)
    financial.add_argument("--out")
    for command, endpoint in (("document", "document.xml"), ("xbrl", "fnlttXbrl.xml")):
        download = commands.add_parser(command, help="Download and safely extract a filing archive.")
        download.add_argument("--rcept-no", type=digits(14), required=True)
        if command == "xbrl":
            download.add_argument("--report", choices=REPORT_CODES, required=True)
        download.add_argument("--out", required=True, help="New or empty extraction directory.")
        download.add_argument("--json-out")
        download.set_defaults(endpoint=endpoint)
    reports = commands.add_parser("reports", help="List the catalogued OpenDART report APIs; no network call.")
    reports.add_argument("--query", default="")
    report = commands.add_parser("report", help="Run one catalogued OpenDART report API (see `reports`).")
    report.add_argument("--api", required=True, help="Report API id, e.g. hyslrSttus, otrCprInvstmntSttus, piicDecsn.")
    report.add_argument("--corp-code", required=True, help="8-digit corp_code; comma-separated for multi-company APIs.")
    report.add_argument("--year", type=digits(4))
    report.add_argument("--report", choices=REPORT_CODES)
    report.add_argument("--idx-cl-code", choices=("M210000", "M220000", "M230000", "M240000"))
    report.add_argument("--begin", type=date_arg)
    report.add_argument("--end", type=date_arg)
    report.add_argument("--out")
    search = commands.add_parser("search-xbrl", help="Search previously downloaded source text; no credential needed.")
    search.add_argument("--path", required=True)
    search.add_argument("--pattern", required=True)
    search.add_argument("--limit", type=positive, default=100)
    search.add_argument("--out")
    return parser


def execute(args: argparse.Namespace) -> tuple[dict, str | None]:
    if args.command == "env-status":
        return credentials.resolve("dart").status(), None
    if args.command == "search-xbrl":
        root = Path(args.path)
        if not root.exists():
            raise DartError("input_missing", "Source path does not exist.")
        pattern = re.compile(args.pattern, re.IGNORECASE)
        paths = [root] if root.is_file() else sorted(root.rglob("*"))
        matches = []
        for path in paths:
            if not path.is_file() or path.suffix.lower() not in (".xml", ".xbrl", ".txt", ".html", ".htm"):
                continue
            for index, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                if pattern.search(line):
                    matches.append({"file": str(path), "line": index, "text": re.sub(r"\s+", " ", line).strip()[:1000]})
                    if len(matches) >= args.limit:
                        return {"status": "ok", "limit_reached": True, "data": matches}, args.out
        return {"status": "ok" if matches else "empty", "limit_reached": False, "data": matches}, args.out
    if args.command == "reports":
        catalog, groups = report_catalog()
        terms = args.query.lower().split()
        rows = [{**item, "params": groups[item["group"]]} for item in catalog.values()
                if all(t in f"{item['id']} {item['name']}".lower() for t in terms)]
        return {"status": "ok" if rows else "empty", "data": rows,
                "note": "periodic·financial need --year and --report; event·filing need --begin and --end."}, None
    key = load_key()
    if args.command == "report":
        catalog, _ = report_catalog()
        spec = catalog.get(args.api)
        if not spec:
            raise DartError("invalid_input", "Unknown report API; run `reports` to list them.")
        codes = args.corp_code.split(",")
        if not all(re.fullmatch(r"\d{8}", c) for c in codes) or (len(codes) > 1 and spec["id"] not in ("fnlttMultiAcnt", "fnlttCmpnyIndx")):
            raise DartError("invalid_input", "Use one 8-digit corp_code (comma-separated only for multi-company APIs).")
        params = {"corp_code": args.corp_code}
        if spec["group"] in ("periodic", "financial"):
            if not args.year or not args.report:
                raise DartError("invalid_input", "This report needs --year and --report.")
            params.update(bsns_year=args.year, reprt_code=args.report)
            if spec["id"] in ("fnlttSinglIndx", "fnlttCmpnyIndx"):
                if not args.idx_cl_code:
                    raise DartError("invalid_input", "This report needs --idx-cl-code (M210000 profitability, M220000 stability, M230000 growth, M240000 activity).")
                params["idx_cl_code"] = args.idx_cl_code
        elif spec["group"] in ("event", "filing"):
            if not args.begin or not args.end or args.begin > args.end:
                raise DartError("invalid_input", "This report needs --begin and --end (YYYYMMDD, begin not after end).")
            params.update(bgn_de=args.begin, end_de=args.end)
        result = get_json(f"{spec['id']}.json", key, params)
        return {**result, "report": {"id": spec["id"], "name": spec["name"], "group": spec["group"]}}, args.out
    if args.command == "corp-code":
        if not args.name.strip():
            raise DartError("invalid_input", "Company search must not be empty.")
        return corp_code(args.name, key, args.limit), args.out
    if args.command == "disclosures":
        if args.begin > args.end:
            raise DartError("invalid_input", "Begin date must not be after end date.")
        params = {"corp_code": args.corp_code, "bgn_de": args.begin, "end_de": args.end,
                  "pblntf_ty": args.type, "last_reprt_at": "Y" if args.last_report_only else "N",
                  "page_no": str(args.page), "page_count": str(args.page_count)}
        return disclosures(key, params, args.all_pages, args.max_pages), args.out
    if args.command == "financials":
        params = {"corp_code": args.corp_code, "bsns_year": args.year, "reprt_code": args.report, "fs_div": args.fs_div}
        return get_json("fnlttSinglAcntAll.json", key, params), args.out
    params = {"rcept_no": args.rcept_no}
    if args.command == "xbrl":
        params["reprt_code"] = args.report
    raw = request_bytes(args.endpoint, key, params, timeout=90)
    try:
        files = extract_archive(raw, Path(args.out))
    except DartNoData:
        return {"status": "empty", "source": source(args.endpoint, params), "data": []}, args.json_out
    return {"status": "ok", "source": {**source(args.endpoint, params), "filing_url": f"https://dart.fss.or.kr/dsaf001/main.do?rcpNo={args.rcept_no}"},
            "archive_sha256": hashlib.sha256(raw).hexdigest(), "directory": str(Path(args.out).resolve()), "files": files}, args.json_out


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        result, output = execute(args)
        write_json(result, output)
        return 0
    except DartError as exc:
        write_json({"status": "error", "error": {"code": exc.code, "message": redact(str(exc), os.environ.get("DART_API_KEY", ""), os.environ.get("OPENDART_API_KEY", ""))}})
        return 2
    except credentials.CredentialError as exc:
        write_json({"status": "error", "error": {"code": "credential_configuration", "message": str(exc)}})
        return 2
    except (OSError, ValueError, re.error):
        write_json({"status": "error", "error": {"code": "local_error", "message": "Local input or output could not be processed."}})
        return 2


if __name__ == "__main__":
    sys.exit(main())
