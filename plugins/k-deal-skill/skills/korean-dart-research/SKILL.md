---
name: korean-dart-research
description: Research Korean company filings, financial statements, XBRL and notes using official DART sources, preserving legal entity, reporting basis, period and filing identifiers.
---

# Korean DART research

Resolve the legal entity before comparing figures. Use an already exposed DART MCP when it supports the required operation; tool names may include `get_corp_code`, `get_disclosure_list`, `get_financial_statement` and `get_disclosure`. A registered server or installed skill alone does not prove that data is accessible.

Otherwise run the bundled Python helper on the user's own machine with the user's own OpenDART key (issued free at opendart.fss.or.kr). It needs Python 3.10+, network access and the key; no server is involved. It uses the official OpenDART API and standard library only. Resolve `scripts/dart_fetch.py` relative to this skill's actual installation directory. The examples below run from that directory; no user-specific directory is required.

```bash
python3 scripts/dart_fetch.py env-status
python3 scripts/dart_fetch.py corp-code --name 삼성전자
python3 scripts/dart_fetch.py disclosures --corp-code 00126380 --begin 20260101 --end 20260930 --all-pages --out filings.json
python3 scripts/dart_fetch.py financials --corp-code 00126380 --year 2025 --report 11011 --fs-div CFS --out financials.json
python3 scripts/dart_fetch.py reports --query 출자
python3 scripts/dart_fetch.py report --api hyslrSttus --corp-code 00126380 --year 2025 --report 11011
python3 scripts/dart_fetch.py report --api piicDecsn --corp-code 00126380 --begin 20250101 --end 20260930
python3 scripts/dart_fetch.py document --rcept-no <14-digit-filing-id> --out ./filing-source
python3 scripts/dart_fetch.py xbrl --rcept-no <14-digit-filing-id> --report 11011 --out ./xbrl-source
python3 scripts/dart_fetch.py search-xbrl --path ./xbrl-source --pattern '리스|우발|약정|담보|특수관계|부문'
```

`reports` lists the 75 catalogued report APIs in [references/dart-reports.json](references/dart-reports.json) (largest shareholders, officers, dividends, treasury shares, investments in other companies, audit opinion, pay, multi-company accounts and ratios, 5% holdings, major-event reports such as rights issues, CB/BW/EB, mergers and splits, and registration statements) without a network call. `report` runs one of them: periodic and financial items need `--year` and `--report`, ratio items also `--idx-cl-code`, and event and filing items need `--begin` and `--end`. `corp-code` lists exact-name and listed matches first.

OpenDART allows 20,000 calls a day per key, and bursts of about 1,000 calls a minute can block the caller's IP for an hour. Run large batches sequentially.

Credentials come first from `DART_API_KEY` or `OPENDART_API_KEY` in the execution environment. On a local machine, the helper can also reuse only the MCP configuration files that the user explicitly registered through this repository's `tools/connect_existing_mcp.py` setup tool. That optional connection file contains paths, not keys; it does not share credentials with other users or web environments. Without an explicit connection it does not search local configuration. `env-status` reports booleans and source labels and does not contact the service. Do not ask the user to paste a key into chat, read unrelated configuration files, or claim the plugin supplies credentials. If execution or credentials are unavailable, identify the missing connection; do not invent figures.

## Evidence and interpretation

- Confirm `corp_code` (8 digits), legal entity name and, when applicable, stock code. Company-code lookup goes directly to DART; `modify_date` is the source record's change date, not the retrieval time.
- Keep `rcept_no`, report name, filing date and original filing URL. Reconcile original and corrected filings. `--last-report-only` requests final reports; omission preserves the full filing history.
- Use CFS before OFS unless the question concerns the individual legal entity. The helper requires and records the selected basis and never silently falls back. Report codes: `11011` annual, `11012` half-year, `11013` Q1, `11014` Q3. The financial helper always requests all accounts from `fnlttSinglAcntAll.json`.
- Preserve source amount strings, units, periods and account identifiers. Do not infer monthly/quarterly amounts from cumulative values without stating the subtraction and checking comparative periods.
- `status: empty` means the provider returned no records for the requested scope. Credential, quota, transport and parsing failures are `status: error`, never zero revenue or no filings. Inspect `pagination.complete`; `--all-pages` is bounded by `--max-pages` and may be incomplete.
- Separate source values, calculations and assumptions. Save relevant raw output in the user's chosen research location and cite its source metadata. A fresh download does not make the reporting period current.
- Downloaded archives are extracted only after path and size validation. Use a new destination or an empty destination; existing files are not overwritten. Search results are leads for reading the actual note, not proof of interpretation.

This skill does not use the `korea-stock-analyzer` package, synthetic news, guessed margins or EPS-derived cash-flow defaults.

## Sources and provenance

- [OpenDART API guide](https://opendart.fss.or.kr/guide/main.do)
- [Disclosure search guide](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019001)
- [Company code guide](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019018)

Adapted from an earlier `korean-dart-research` skill and `dart_fetch.py`. This distributed version removes project-config credential lookup and adds explicit source metadata, bounded pagination, error/no-data separation and safe archive extraction.
