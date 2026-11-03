---
name: korean-public-data
description: Query Korean data.go.kr services (FSC corporate and financial data, KSD issuer and share data, NPS workplace headcount, NTS business status, customs trade) with the user's own service key. Use for data.go.kr evidence and source-date checks; use DART for filing and note-level financial evidence.
---

# Korean Public Data

If a data.go.kr MCP tool is already exposed in the session, it may be used. Otherwise run [scripts/api_fetch.py](scripts/api_fetch.py) on the user's own machine with the user's own data.go.kr service key. An installed skill, a successful query, the collection time and the source's reference period are separate facts. It requires only Python 3.10+ and the standard library. Resolve the script relative to this skill directory; do not assume a personal checkout path. A chat without code execution needs a connected MCP; the skill alone does not supply a server or credentials.

## Credentials and status

The helper reads `DATA_GO_KR_KEY_ENC` (data.go.kr's encoded key) or `DATA_GO_KR_KEY` (decoded key) from the environment first. If both are set, the encoded key takes precedence. A local user may explicitly register existing MCP settings through this repository's `tools/connect_existing_mcp.py`; only then may the helper reuse the datago key from those specific files. It never scans arbitrary project configurations or accepts a key on the command line. No key is copied into the plugin or shared to web environments. Do not print either value. The key must have approval for the particular API being called.

```bash
python3 scripts/api_fetch.py status
```

Status makes no network request and reports key presence only. No database is bundled; every query goes to the live API.

## Bounded API queries

```bash
python3 scripts/api_fetch.py fsc-financials --crno 1234567890123 --year 2025 --page-no 1 --num-rows 10
python3 scripts/api_fetch.py fsc-outline --corp-name 삼성전자 --page-no 1 --num-rows 20
python3 scripts/api_fetch.py fsc-affiliates --crno 1234567890123 --base-date 20260801
python3 scripts/api_fetch.py customs --hs 3304 --start-ym 202601 --end-ym 202603 --country JP
```

The numbers in these examples illustrate argument formats; resolve the actual legal entity and reference dates for the request. Financial Services Commission (FSC) tools use the 13-digit **legal entity registration number**, not the DART corporation code, stock code, or business registration number. Omit `--country` for customs totals across countries. One customs query supports at most twelve calendar months.

The helper calls the requested endpoint once, without a local response cache or automatic pagination. FSC tools default to page 1; use the returned `totalCount`, `_meta.partial_result`, and request metadata to decide whether additional pages are needed. `partial_result` means the response contains only part of the total result, not necessarily that another page follows the requested page.

API errors are distinct from valid zero-row responses. Successful responses retain raw `items`, source endpoint, requested parameters, and UTC collection time. The collection time does not establish the source data's reference date or that a revised filing is reflected. Keep original period and basis fields when presenting the result.

## Catalogued services

```bash
python3 scripts/api_fetch.py catalog --query 주식발행
python3 scripts/api_fetch.py call --service ksd_corp_info --operation getIssucoBasicInfo --param crno=1234567890123
python3 scripts/api_fetch.py call --service nps_workplace --operation latest_snapshot --param 'cond[사업장명::LIKE]=회사명' --param perPage=20
python3 scripts/api_fetch.py biz-status --bizno 123-45-67890
```

[references/datago-apis.json](references/datago-apis.json) lists 19 services and 85 operations with their documented parameters, response fields and the date each was checked: FSC corporate outline, financials, share issuance and financing disclosures, KSD issuer and share information, NPS workplaces, FTC mail-order registrations, customs trade and others. `catalog` searches it without a network call. `call` sends only the documented parameters of one operation, fills in paging defaults the provider marks required, and returns the raw rows. Each service needs its own approval for the user's key; an unapproved service returns an error, never zero rows. `biz-status` checks up to 100 business registration numbers against the NTS service (01 active, 02 suspended, 03 closed). NPS headcount is an employment proxy, not revenue. Some KSD development keys allow only 100 calls a day.

## Use the evidence correctly

- Match legal entity, period, unit, and consolidated/separate basis. FSC coverage is not universal; a zero-row response does not prove a company has no financial statements. Use DART filings for audited accounts and note-level evidence.
- Customs results can contain both total/subtotal rows and detailed HS/month rows. Preserve the raw rows, then choose one consistent aggregation level. Do not add totals to details or sum overlapping HS prefixes.
- NPS business registration identifiers may be truncated and are not sufficient on their own for exact legal-entity joins.
- Cite the source endpoint and returned reference period, and distinguish observed data from calculations. Do not imply that sharing this skill also shares the API key.

Official source entrypoints: [data.go.kr](https://www.data.go.kr/), [NPS establishment snapshots](https://www.data.go.kr/data/15083277/openapi.do).
