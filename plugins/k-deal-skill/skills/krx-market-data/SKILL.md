---
name: krx-market-data
description: Retrieve Korean listed-share basic information and daily price, volume, market-cap and share-count data from official KRX APIs for explicit dates and markets.
---

# KRX market data

Use an already exposed official KRX source tool when available, such as `get_stock_base_info` or `get_stock_trade_info`. Resolve the company, security code and market first; share classes can have different codes. Match the requested valuation date and financial-statement period rather than silently using today's price.

Otherwise run the bundled standard-library Python helper on the user's own machine with the user's own `KRX_API_KEY` (apply at openapi.krx.co.kr; each service is approved separately). No server is involved. Resolve `scripts/krx_fetch.py` relative to this skill's installation directory. These examples run from that directory:

```bash
python3 scripts/krx_fetch.py env-status
python3 scripts/krx_fetch.py trade --market KOSPI --date 20261021 --code 005930 --out trade.json
python3 scripts/krx_fetch.py base --market KOSPI --date 20261021 --code 005930 --out security.json
python3 scripts/krx_fetch.py apis --query 지수
python3 scripts/krx_fetch.py daily --api idx/kospi_dd_trd --date 20261021 --filter IDX_NM=코스피
```

`apis` lists the 31 KRX Open API services in [references/krx-apis.json](references/krx-apis.json) (indices, ETF/ETN/ELW, bonds, derivatives, commodities, ESG) without a network call; `daily` runs one for one date, with optional exact-match `--filter FIELD=VALUE` and `--limit`. A service the key is not approved for returns `not_approved`, not an empty result. KRX terms limit use to non-commercial purposes and forbid charging third parties for the data.

The dates and codes above are examples, not current observations. `--date` and `--code` may be repeated. Requests run sequentially, with one official market request per date; filtering happens locally. The helper does not call `korea-stock-analyzer` or scrape a third-party price service.

`env-status` checks only whether the key is present and its source label. A local user may explicitly register existing MCP settings through this repository's `tools/connect_existing_mcp.py`; only then may the helper reuse `KRX_API_KEY` from those files. No key is copied into the plugin or shared to web environments. Explicit environment credentials take precedence. KRX authentication-key approval and access to each requested service are separate requirements. Do not ask users to paste credentials into chat or read unrelated local configuration. If the tool, runtime, network or authorized credential is unavailable, identify the missing connection.

## Interpretation and evidence

- `trade` uses daily trading endpoints; `base` uses security basic-information endpoints. Supported markets are `KOSPI`, `KOSDAQ`, `KONEX`. These are daily source snapshots, not streaming quotes.
- Preserve `basDd`, the market, provider field names, all source units and numeric strings, and `fetched_at`. The query date, provider's returned `BAS_DD` if supplied, and retrieval time have distinct meanings.
- An empty result can mean no published data, an unavailable date, a market/code mismatch or another coverage issue. Do not label it a holiday or a zero value without evidence. No automatic date rollback occurs.
- The output records provider row count, matched count and unmatched requested codes per date. A successful HTTP request with an invalid response shape is an error; it is not an empty dataset. Multi-date results mark failed dates as errors and return a nonzero exit status.
- Verify shares, share class and units before deriving market capitalization. Keep treasury shares, issued shares and diluted shares distinct; this daily endpoint does not establish a fully diluted ownership calculation.
- The helper sends `AUTH_KEY` only in the request header over HTTPS. It has no insecure HTTP fallback and does not log the request headers, error bodies or signed URLs.

Source: [KRX Open API](https://openapi.krx.co.kr/contents/OPP/MAIN/main/index.cmd). Endpoint and field contracts follow the official services also used by [korea-stock-mcp](https://github.com/jjlabsio/korea-stock-mcp); this helper is independent of that npm package and has no analyzer dependency.
